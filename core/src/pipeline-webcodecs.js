/**
 * WebCodecs 播放管线（CONTRACTS §6 WebCodecs 路径 + §7 音频主路径）。
 *
 * 职责边界：只做「样本 → 解码 → 音画同步 → 渲染/出声」，不含容器解析与生命周期编排
 * （那是 core/src/player.js 的事）。解码器、渲染器、音频输出均可注入，
 * 因此同一套代码可在 Node 下用假实现单测、在浏览器里用真实 WebCodecs 跑。
 *
 * 铁律（§6/§7）：
 *  - VideoFrame 单一所有权：渲染器 draw 后即 close（finally 保证）；无渲染器时本层负责 close；
 *  - 音频 AudioData 必须在进 Worklet 前转成 f32-planar；
 *  - 主时钟优先音频（AudioOutput.currentTimeUs），无音轨退化为单调钟；
 *  - 视频按 AvSyncController 决策 render/drop/wait。
 */
import { Emitter } from './emitter.js';
import { decodeError, notSupported, stateError } from './errors.js';
import { AvSyncController, PlaybackClock } from './clock.js';
import { annexbToAvcc } from './nal.js';

const NOOP = () => {};

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (typeof t?.unref === 'function') t.unref();
  return () => clearTimeout(t);
}

/**
 * AudioData → f32-planar（每通道一个 Float32Array，契约 §7）。
 * 复制失败或无 copyTo（假实现）时退化为 planes 直读，绝不静默丢帧。
 */
export function audioDataToPlanar(audioData) {
  const channels = Math.max(1, audioData.numberOfChannels ?? audioData.channels ?? 1);
  const frames = audioData.numberOfFrames ?? audioData.frames ?? 0;
  const out = [];
  for (let i = 0; i < channels; i++) {
    const plane = new Float32Array(frames);
    if (typeof audioData.copyTo === 'function') {
      audioData.copyTo(plane, { planeIndex: i, format: 'f32-planar' });
    } else if (audioData.planes?.[i]) {
      plane.set(audioData.planes[i].subarray(0, frames));
    }
    out.push(plane);
  }
  return out;
}

export class WebCodecsPipeline extends Emitter {
  /**
   * @param {{route:string, mediaInfo:MediaInfo, player:object, options:object}} ctx
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.options = ctx.options ?? {};
    this.player = ctx.player ?? null;
    this.mediaInfo = ctx.mediaInfo;
    /** @type {Map<number, object>} */
    this._tracks = new Map((this.mediaInfo.tracks ?? []).map((t) => [t.id, t]));
    /** 当前选中轨（按类型）：未选中的同类轨样本直接丢弃 */
    this.active = { video: null, audio: null, text: null };
    for (const t of this._tracks.values()) {
      if (this.active[t.type] == null) this.active[t.type] = t.id;
    }

    this._videoDecoder = null;
    this._audioDecoder = null;
    this.renderer = null;
    this.audioOutput = null;
    this.avSync = this.options.avSync ?? new AvSyncController(this.options.syncOptions);
    this._clock = this.options.clock ?? new PlaybackClock({ now: this.options.now });
    this._schedule = this.options.schedule ?? defaultSchedule;

    this._frames = [];
    this._framePumping = false;
    this._frameTimer = null;
    this._offsetUs = 0;
    /** 直播边缘：已灌入的最新视频样本时间戳（µs），-1 表示尚无视频样本 */
    this._liveEdgeUs = -1;
    this._firstFrameEmitted = false;
    this.state = 'ready';
    this.counters = { videoChunks: 0, audioChunks: 0, framesRendered: 0, framesDropped: 0, cues: 0, catchups: 0 };

    this.avSync.attachMaster(() => this.currentTimeSec());
  }

  /* ------------------------------ 构建 ------------------------------ */

  /** 建管线（解码器/渲染器/音频输出）。幂等。 */
  async init() {
    if (this._videoDecoder || this._audioDecoder) return this;
    const video = [...this._tracks.values()].find((t) => t.type === 'video');
    const audio = [...this._tracks.values()].find((t) => t.type === 'audio');
    if (video) await this._setupVideo(video);
    if (audio) await this._setupAudio(audio);
    return this;
  }

  _setupVideo(track) {
    const factory = this.options.videoDecoderFactory ??
      (typeof VideoDecoder === 'function'
        ? (init) => new VideoDecoder(init)
        : null);
    if (!factory) throw notSupported('当前环境没有 VideoDecoder', { codec: track.codec });
    this._videoDecoder = factory({
      output: (frame) => this._onVideoFrame(frame),
      error: (err) => this._onDecodeError(err, 'video'),
    });
    const config = {
      codec: track.codec,
      ...(track.description ? { description: track.description } : {}),
      ...(track.width ? { codedWidth: track.width, displayAspectWidth: track.width } : {}),
      ...(track.height ? { codedHeight: track.height, displayAspectHeight: track.height } : {}),
      optimizeForLatency: true,
    };
    this._videoConfig = config;
    this._videoDecoder.configure?.(config);
  }

  async _setupAudio(track) {
    const factory = this.options.audioDecoderFactory ??
      (typeof AudioDecoder === 'function'
        ? (init) => new AudioDecoder(init)
        : null);
    if (!factory) throw notSupported('当前环境没有 AudioDecoder', { codec: track.codec });
    this._audioDecoder = factory({
      output: (audioData) => this._onAudioData(audioData),
      error: (err) => this._onDecodeError(err, 'audio'),
    });
    const audioConfig = {
      codec: track.codec,
      sampleRate: track.sampleRate ?? 48000,
      numberOfChannels: track.numberOfChannels ?? 2,
      ...(track.description ? { description: track.description } : {}),
    };
    this._audioConfig = audioConfig;
    this._audioDecoder.configure?.(audioConfig);
    const sampleRate = track.sampleRate ?? 48000;
    const channels = track.numberOfChannels ?? track.channelCount ?? 2;
    const existing = this.audioOutput;
    // 同格式轨切换复用音频输出，避免重建 AudioWorklet 造成可闻断点
    if (existing && existing.sampleRate === sampleRate && (existing.channelCount ?? existing.channels) === channels) {
      return;
    }
    try {
      this.audioOutput = await (this.options.audioOutputFactory ?? createDefaultAudioOutput)({
        sampleRate,
        channels,
      });
      await this.audioOutput.init?.();
    } catch (err) {
      // 无音频输出（Node/无 AudioContext）时降级为静音播放，不阻断视频
      this.audioOutput = null;
      this.emit('audio-unavailable', err);
    }
  }

  /* ------------------------------ 输入 ------------------------------ */

  /** 消费一个样本（Player 的样本泵调用）。 */
  async pushSample(sample) {
    if (this.state === 'destroyed') return;
    const track = this._tracks.get(sample.trackId);
    if (!track) return;
    if (this.active[track.type] != null && this.active[track.type] !== track.id) return; // 非选中轨
    if (track.type === 'video') {
      if (!this._videoDecoder) return;
      await this._waitQueue(this._videoDecoder);
      // 直播落后判定需要「最新已见视频时间戳」作 live edge
      if (sample.timestamp > this._liveEdgeUs) this._liveEdgeUs = sample.timestamp;
      // TS/裸流等 annexb 轨：WebCodecs avc1/hev1 期望 AVCC（length-prefixed），
      // annexb（起始码分隔）直接喂会给 Chrome 解码错误并使 decoder 自动进入 closed。
      // 浏览器端到端验收暴露：此前仅 Node 假实现验证（不检查字节内容），TS 真实流必挂。
      const payload = track.bitstreamFormat === 'annexb' && sample.data
        ? { ...sample, data: annexbToAvcc(sample.data) }
        : sample;
      this._videoDecoder.decode(this._createChunk('video', payload));
      this.counters.videoChunks += 1;
    } else if (track.type === 'audio') {
      if (!this._audioDecoder) return;
      await this._waitQueue(this._audioDecoder);
      this._audioDecoder.decode(this._createChunk('audio', sample));
      this.counters.audioChunks += 1;
    } else if (track.type === 'text') {
      this._emitCue(sample);
    }
  }

  _createChunk(kind, sample) {
    if (this.options.createChunk) return this.options.createChunk(kind, sample);
    const payload = {
      type: sample.keyframe === false ? 'delta' : 'key',
      timestamp: sample.timestamp,
      data: sample.data,
      ...(sample.duration ? { duration: sample.duration } : {}),
    };
    if (kind === 'video' && typeof EncodedVideoChunk === 'function') return new EncodedVideoChunk(payload);
    if (kind === 'audio' && typeof EncodedAudioChunk === 'function') return new EncodedAudioChunk(payload);
    return payload; // 无 WebCodecs（注入假解码器）时退化为纯对象
  }

  /** 背压：解码队列过长时让出事件循环（默认上限 8）。 */
  async _waitQueue(decoder) {
    const limit = this.options.maxDecodeQueue ?? 8;
    let guard = 0;
    while (typeof decoder.decodeQueueSize === 'number' && decoder.decodeQueueSize >= limit && guard < 64) {
      guard += 1;
      await new Promise((resolve) => this._schedule(resolve, 0));
    }
  }

  /* ------------------------------ 输出回调 ------------------------------ */

  _onVideoFrame(frame) {
    const ts = typeof frame?.timestamp === 'number' ? frame.timestamp : 0;
    this._frames.push({ frame, ts });
    this._pumpFrames();
  }

  _onAudioData(audioData) {
    try {
      const channels = audioDataToPlanar(audioData);
      this.audioOutput?.push?.(channels);
      if (typeof audioData.close === 'function') audioData.close();
      this.emit('audio-frame', { frames: channels[0]?.length ?? 0 });
    } catch (err) {
      this._onDecodeError(err, 'audio');
    }
  }

  _onDecodeError(err, kind) {
    const e = decodeError(`${kind} 解码失败`, { cause: err });
    this.player?.statsValue?.markDecodeError?.({ kind, message: err?.message });
    this.emit('error', e);
  }

  _emitCue(sample) {
    const text = typeof TextDecoder !== 'undefined' && sample.data
      ? new TextDecoder('utf-8').decode(sample.data)
      : '';
    this.counters.cues += 1;
    this.emit('cue', {
      trackId: sample.trackId,
      startUs: sample.timestamp,
      endUs: sample.timestamp + (sample.duration ?? 0),
      text,
      raw: sample.data,
    });
  }

  /* ------------------------------ 渲染调度 ------------------------------ */

  _pumpFrames() {
    if (this._framePumping || this.state === 'destroyed') return;
    this._framePumping = true;
    try {
      while (this._frames.length > 0) {
        if (this.state !== 'playing') break;
        // 直播落后目标延迟过多时先把主钟追到 live 边缘，再让常规 render/drop 决策丢旧帧
        this._maybeLiveCatchUp();
        if (this.state !== 'playing' || this._frames.length === 0) break;
        const item = this._frames[0];
        const { action, drift } = this.avSync.suggestVideoAction(item.ts / 1_000_000);
        if (action === 'drop' || (action === 'resync' && drift < 0)) {
          // 视频太旧：一律丢帧。注意大幅落后（|drift|≥hardResyncSec）在 audio-master 下
          // 是「视频错了」不是「钟错了」——不得 resync 去迁就旧帧，仍应丢帧（§5 迟到丢帧）。
          this._frames.shift();
          this._closeFrame(item.frame);
          this.counters.framesDropped += 1;
          this.player?.statsValue?.markVideoDropped?.();
          this.emit('drop', { timestampUs: item.ts, drift });
          continue;
        }
        if (action === 'resync') {
          // 视频大幅超前（drift>0 且 ≥hardResyncSec）：主钟落后于视频——重锚主钟到该帧，
          // 避免长时间 wait 造成 A/V 无限落后；重锚不可行（外部不可控钟）则按 wait 等待。
          const reanchored = this._masterRealignToUs(item.ts);
          if (reanchored) {
            this.emit('resynced', { timestampUs: item.ts, drift });
            continue;
          }
          break;
        }
        if (action === 'wait') {
          const delay = Math.min(Math.max(Math.round(drift * 1000), 0), 250);
          if (!this._frameTimer) {
            this._frameTimer = this._schedule(() => {
              this._frameTimer = null;
              this._pumpFrames();
            }, delay);
          }
          break;
        }
        this._frames.shift();
        this._render(item.frame, item.ts);
      }
    } finally {
      this._framePumping = false;
    }
  }

  /**
   * 直播落后丢帧追赶（CONTRACTS §5「直播落后于 liveLatencyUs 目标时优先丢帧追赶」）。
   *
   * 语义：实时播放永远滞后 live 边缘约 liveLatencyUs 才合理。当主钟落后目标位置
   * （= liveEdge - liveLatencyUs）超过 catchUpThresholdUs 时，说明已积压过多老内容
   * （如网络恢复、长卡顿后），等 1× 播完会长时间偏离直播——此时直接把主钟重锚到目标：
   * 音频输出清缓冲（currentTimeUs 归零）+ 偏移锚定；随后常规 render/drop 决策把队首
   * 早于新主钟的旧帧逐个丢弃，实现「丢帧追赶」。仅当 mediaInfo.live 且提供了
   * liveLatencyUs 才生效；MSE 路线由 <video> 元素时间轴自行管理，不在本管线范围。
   *
   * 实时性保证：重锚后 _offsetUs 是绝对赋值（复用 seek 原语），不随音频钟漂移累积误差。
   * 没有可清缓冲的音频输出（外部不可控时钟）时只丢旧帧、不重锚，避免把主钟锚错。
   */
  _maybeLiveCatchUp() {
    if (this.mediaInfo?.live !== true || this._liveEdgeUs < 0) return;
    const liveLatencyUs = this.options.liveLatencyUs;
    if (!Number.isFinite(liveLatencyUs) || liveLatencyUs <= 0) return;
    const targetUs = this._liveEdgeUs - liveLatencyUs;
    const behindUs = targetUs - this.currentTimeUs;
    if (behindUs <= this._catchUpThresholdUs()) return;
    const fromUs = this.currentTimeUs;
    const reanchored = this._masterRealignToUs(targetUs);
    this.counters.catchups += 1;
    this.emit('catchup', { fromUs, toUs: Math.round(targetUs), behindUs, reanchored });
  }

  /**
   * 主钟重锚到指定媒体位置（µs）：音频输出可清缓冲时归零其计数后，偏移锚定该点；
   * 无音频输出时直接锚定单调钟。外部不可控时钟（有 currentTimeUs 却无 clearBuffer）
   * 不重锚（返回 false），避免把主钟锚到错误位置。
   * @returns {boolean} 是否真正重锚
   */
  _masterRealignToUs(timestampUs) {
    if (this.audioOutput) {
      if (typeof this.audioOutput.clearBuffer === 'function') {
        this.audioOutput.clearBuffer();
      } else if (typeof this.audioOutput.currentTimeUs === 'number') {
        return false; // 外部不可控钟
      }
    }
    this._offsetUs = Math.round(timestampUs);
    this._clock.seekTo(timestampUs / 1_000_000);
    this.avSync.seekTo(timestampUs / 1_000_000);
    return true;
  }

  /** 落后多少才触发追赶：可显式配置，否则取 liveLatency 的一半、下限 500ms */
  _catchUpThresholdUs() {
    if (Number.isFinite(this.options.catchUpThresholdUs)) return this.options.catchUpThresholdUs;
    const liveUs = this.options.liveLatencyUs;
    const base = Number.isFinite(liveUs) && liveUs > 0 ? liveUs : 3_000_000;
    return Math.max(500_000, Math.round(base / 2));
  }

  _render(frame, ts) {
    try {
      if (this.renderer) this.renderer.draw(frame); // 渲染器 finally 内 close
      else this._closeFrame(frame);
      this.counters.framesRendered += 1;
      this.player?.statsValue?.markVideoRendered?.();
      this.emit('rendered', { timestampUs: ts });
      if (!this._firstFrameEmitted) {
        this._firstFrameEmitted = true;
        this.emit('firstframe', { timestampUs: ts });
      }
    } catch (err) {
      this._closeFrame(frame);
      this._onDecodeError(err, 'render');
    }
  }

  _closeFrame(frame) {
    try {
      frame?.close?.();
    } catch {
      /* 双重 close 忽略 */
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  play() {
    if (this.state === 'destroyed') return;
    this.state = 'playing';
    this.audioOutput?.play?.();
    if (!this.audioOutput) this._clock.play(this._clock.getTimeSec());
    this.avSync.start(this.currentTimeSec());
    this._pumpFrames();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.audioOutput?.pause?.();
    this._clock.pause();
    this.avSync.pause();
  }

  /** @param {number} timestampUs 实际落点（整数微秒） */
  seek(timestampUs) {
    this._offsetUs = Math.round(timestampUs);
    this._liveEdgeUs = -1; // 跳转后按新时间轴的视频样本重新累计 live edge
    this._dropPendingFrames();
    // reset() 后必须重新 configure 才能 decode（WebCodecs 约束；由浏览器 seek 端到端验收暴露）
    this._videoDecoder?.reset?.();
    if (this._videoConfig) this._videoDecoder?.configure?.(this._videoConfig);
    this._audioDecoder?.reset?.();
    if (this._audioConfig) this._audioDecoder?.configure?.(this._audioConfig);
    this.audioOutput?.clearBuffer?.();
    this._clock.seekTo(timestampUs / 1_000_000);
    this.avSync.seekTo(timestampUs / 1_000_000);
    this.emit('seeked', { timestampUs: this._offsetUs });
  }

  setVolume(v) { this.audioOutput?.setVolume?.(v); }
  setMuted(m) { this.audioOutput?.setVolume?.(m ? 0 : (this.player?.volume ?? 1)); }
  setPlaybackRate(rate) { this._clock.setRate(rate); this.avSync.setRate(rate); }

  /**
   * 切换活动轨：清缓冲 + 重建该类型解码链（视频/音频），字幕只换选中。
   * @param {'video'|'audio'|'text'} type
   * @param {number} trackId
   */
  async selectTrack(type, trackId) {
    const track = this._tracks.get(trackId);
    if (!track || track.type !== type) throw stateError(`track not found: ${type}/${trackId}`);
    if (this.active[type] === trackId) return;
    this.active[type] = trackId;
    if (type === 'video') {
      this._dropPendingFrames();
      this._liveEdgeUs = -1; // 视频轨重建后 live edge 需重新累计
      try { this._videoDecoder?.close?.(); } catch { /* 忽略 */ }
      this._videoDecoder = null;
      this._setupVideo(track);
    } else if (type === 'audio') {
      try { this._audioDecoder?.close?.(); } catch { /* 忽略 */ }
      this._audioDecoder = null;
      this.audioOutput?.clearBuffer?.();
      await this._setupAudio(track);
    }
    this.emit('trackchange', { type, trackId, codec: track.codec });
  }

  async destroy() {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    if (this._frameTimer) { this._frameTimer(); this._frameTimer = null; }
    this._dropPendingFrames();
    try { this._videoDecoder?.close?.(); } catch { /* 忽略 */ }
    try { this._audioDecoder?.close?.(); } catch { /* 忽略 */ }
    try { this.renderer?.destroy?.(); } catch { /* 忽略 */ }
    try { this.audioOutput?.destroy?.(); } catch { /* 忽略 */ }
    this._videoDecoder = null;
    this._audioDecoder = null;
    this.renderer = null;
    this.audioOutput = null;
  }

  _dropPendingFrames() {
    while (this._frames.length) this._closeFrame(this._frames.shift().frame);
  }

  /* ------------------------------ 时钟与统计 ------------------------------ */

  /** 主时钟（秒）：音频优先，否则单调钟 */
  currentTimeSec() {
    if (this.audioOutput && typeof this.audioOutput.currentTimeUs === 'number') {
      return this._offsetUs / 1_000_000 + this.audioOutput.currentTimeUs / 1_000_000;
    }
    return this._clock.getTimeSec();
  }

  get currentTimeUs() {
    return Math.round(this.currentTimeSec() * 1_000_000);
  }

  /**
   * 缓冲水位（µs）：音频输出自报优先；否则用待渲染帧队列领先主钟的时长；
   * 两者都不可知时返回 null（Player 侧据此跳过背压判定，不会误停泵）。
   */
  get bufferedAheadUs() {
    const audio = this.audioOutput?.bufferedAheadUs;
    if (typeof audio === 'number' && Number.isFinite(audio)) return audio;
    const last = this._frames[this._frames.length - 1];
    if (!last) return null;
    const ahead = (last.ts ?? 0) - this.currentTimeUs;
    return Number.isFinite(ahead) && ahead > 0 ? ahead : null;
  }

  /** WebCodecs 路径无 SourceBuffer，区间只能由水位合成；无水位返回 null 交给 Player 兜底 */
  getBufferedRanges() {
    const ahead = this.bufferedAheadUs;
    if (typeof ahead !== 'number' || ahead <= 0) return null;
    const start = this.currentTimeUs;
    return [{ startUs: start, endUs: start + ahead }];
  }

  get stats() {
    return {
      ...this.counters,
      decodeQueue: (this._videoDecoder?.decodeQueueSize ?? 0) + (this._audioDecoder?.decodeQueueSize ?? 0),
      underrunCount: this.audioOutput?.underrunCount ?? 0,
    };
  }
}

async function createDefaultAudioOutput(options) {
  // 延迟引入：audio-worklet-player 在无 AudioContext 环境也能安全 import
  const { createAudioOutput } = await import('./audio-worklet-player.js');
  return createAudioOutput(options);
}

/**
 * 生成 Player 可用的管线工厂。
 * @param {object} [options] 覆盖解码器/渲染器/音频输出工厂、调度器与同步参数
 * @returns {(ctx:{route:string,mediaInfo:MediaInfo,player:object,options:object}) => Promise<WebCodecsPipeline>}
 */
export function webcodecsPipelineFactory(options = {}) {
  return async function createPipeline(ctx) {
    const merged = { ...ctx.options, ...options };
    const pipeline = new WebCodecsPipeline({ ...ctx, options: merged });
    if (ctx.mediaInfo?.tracks?.some((t) => t.type === 'video') && merged.canvas) {
      const { createVideoRenderer } = await import('./video-frame-renderer.js');
      pipeline.renderer = createVideoRenderer(merged.canvas, {
        preference: merged.rendererPreference,
        fit: merged.fit ?? 'contain',
      });
    }
    await pipeline.init();
    return pipeline;
  };
}

export { NOOP as _noop };
