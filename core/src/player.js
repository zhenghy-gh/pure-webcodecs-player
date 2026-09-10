/**
 * 公共播放器编排层（CONTRACTS §5）。
 *
 * 这一层只负责生命周期、数据源/注册表、路线裁决和样本泵；具体解码与渲染
 * 通过 options.pipelineFactory 注入，避免 core 在 Node 测试环境硬依赖 DOM/WebCodecs。
 */
import { Emitter } from './emitter.js';
import { createDemuxerAuto, detectFromUrl } from './registry.js';
import { BlobDataSource } from './data-source.js';
import { detectCapabilities, chooseRoute, DEFAULT_VIDEO_CODECS, DEFAULT_AUDIO_CODECS } from './capabilities.js';
import { PlaybackClock } from './clock.js';
import { Stats } from './stats.js';
import { PlayerError, stateError, notSupported, abortedError } from './errors.js';
import { webcodecsPipelineFactory } from './pipeline-webcodecs.js';
import { msePipelineFactory } from './pipeline-mse.js';

/** WebCodecs 路线下的默认管线工厂（浏览器环境才可能被选中） */
const DEFAULT_WC_PIPELINE = webcodecsPipelineFactory();
/** MSE 兼宽容错路线下的默认管线工厂 */
const DEFAULT_MSE_PIPELINE = msePipelineFactory();

function hasWebCodecsCtor() {
  return typeof VideoDecoder === 'function' || typeof AudioDecoder === 'function';
}

function hasMseCtor() {
  return typeof MediaSource === 'function' || typeof ManagedMediaSource === 'function';
}

/** 默认起播前向缓冲目标（µs）：CONTRACTS §5 bufferTargetUs 缺省 3s */
const DEFAULT_BUFFER_TARGET_US = 3_000_000;

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (typeof t?.unref === 'function') t.unref();
  return () => clearTimeout(t);
}

export const PLAYER_STATES = Object.freeze({
  IDLE: 'idle', READY: 'ready', PLAYING: 'playing', PAUSED: 'paused',
  SEEKING: 'seeking', ERROR: 'error', DESTROYED: 'destroyed',
});

const TRANSITIONS = Object.freeze({
  idle: ['ready', 'error', 'destroyed'],
  ready: ['playing', 'paused', 'seeking', 'error', 'destroyed'],
  playing: ['paused', 'seeking', 'error', 'destroyed'],
  paused: ['playing', 'seeking', 'error', 'destroyed'],
  seeking: ['ready', 'playing', 'paused', 'error', 'destroyed'],
  error: ['destroyed'],
  destroyed: [],
});

function asPlayerError(error, fallback = '播放器管线失败') {
  if (error instanceof PlayerError) return error;
  return new PlayerError('SOURCE_ERROR', fallback, { cause: error });
}

/**
 * 面向具体媒体的能力探测：默认 codec 清单并集媒体实际 codec 后深探测，
 * 使 chooseRoute 能按「真实内容 codec」裁决（如 avc1.64001F 不在默认清单，
 * 缺此合并会导致 WebCodecs 路线误判为不可用 → route='none'，由浏览器端到端验收暴露）。
 */
async function detectForMedia(info, options = {}) {
  const video = new Set(DEFAULT_VIDEO_CODECS);
  const audio = new Set(DEFAULT_AUDIO_CODECS);
  for (const t of info?.tracks ?? []) {
    if (!t?.codec) continue;
    if (t.type === 'video') video.add(t.codec);
    else if (t.type === 'audio') audio.add(t.codec);
  }
  return detectCapabilities({
    deep: true,
    videoCodecs: [...video],
    audioCodecs: [...audio],
  });
}

export class Player extends Emitter {
  constructor(options = {}) {
    super();
    this.options = {
      routePreference: ['webcodecs', 'mse'],
      /** 起播前向缓冲目标（µs，CONTRACTS §5 缺省 3s）；0 表示不预缓冲 */
      bufferTargetUs: DEFAULT_BUFFER_TARGET_US,
      /** 直播目标延迟（µs）；live 媒体存在时优先于 bufferTargetUs 作为起播水位 */
      liveLatencyUs: null,
      /** 预缓冲单次最多拉多少样本后无条件起播（防御无时间戳推进的异常流） */
      prebufferMaxSamples: 512,
      /** 背压阈值 = 起播水位 × 该系数；管线上报水位超过即暂停拉流 */
      backpressureFactor: 2,
      /** 背压轮询间隔（ms） */
      backpressurePollMs: 50,
      /** 码率统计滑动窗口（秒） */
      bitrateWindowSec: 1,
      ...options,
    };
    /** 背压/预缓冲的让出调度器（可注入以便单测立即推进） */
    this._schedule = this.options.schedule ?? defaultSchedule;
    /** 码率滑动窗口：{t: 秒, bytes} */
    this._bitrateWindow = [];
    this.stateValue = PLAYER_STATES.IDLE;
    /** 当前选中轨（按类型），load 后按 default → 首轨初始化 */
    this.selectedTracks = { video: null, audio: null, text: null };
    this.demuxer = null;
    this.mediaInfoValue = null;
    this.routeValue = 'none';
    this.pipeline = null;
    this.endedValue = false;
    this.currentTimeValue = 0;
    this.clock = options.clock ?? new PlaybackClock(options.clockOptions);
    this.statsValue = options.stats ?? new Stats(options.clockOptions);
    this._loadPromise = null;
    this._pumpToken = 0;
    this._lastTimeEventUs = -Infinity;
    this._volume = 1;
    this._muted = false;
    this._playbackRate = 1;
  }

  get state() { return this.stateValue; }
  get ended() { return this.endedValue; }
  get currentTimeUs() {
    const pipeUs = this.pipeline?.currentTimeUs;
    if (typeof pipeUs === 'number' && Number.isFinite(pipeUs) && pipeUs >= 0) {
      // 有真实输出管线时以其主时钟（音频优先）为准
      return (this.currentTimeValue = pipeUs);
    }
    if (this.stateValue === PLAYER_STATES.PLAYING) {
      this.currentTimeValue = Math.max(this.currentTimeValue, Math.round(this.clock.getTimeSec() * 1e6));
    }
    return this.currentTimeValue;
  }
  get durationUs() { return this.mediaInfoValue?.durationUs ?? null; }
  /**
   * 已缓冲区间 Array<{startUs,endUs}>。
   * 取数优先级：demuxer（网络/文件侧已知范围）→ 管线（MSE SourceBuffer 真实区间）→
   * 管线水位合成（仅有 bufferedAheadUs 时）→ 空数组。
   */
  get buffered() {
    const fromDemuxer = this.demuxer?.getBufferedRanges?.();
    if (Array.isArray(fromDemuxer) && fromDemuxer.length > 0) return fromDemuxer;
    const fromPipeline = this.pipeline?.getBufferedRanges?.();
    if (Array.isArray(fromPipeline) && fromPipeline.length > 0) return fromPipeline;
    const ahead = this.bufferedAheadUs;
    if (typeof ahead === 'number' && ahead > 0) {
      const start = this.currentTimeUs;
      return [{ startUs: start, endUs: start + ahead }];
    }
    return [];
  }
  /** 管线自报的缓冲水位（µs）；管线不提供时为 null（不参与背压判定） */
  get bufferedAheadUs() {
    const ahead = this.pipeline?.bufferedAheadUs;
    return typeof ahead === 'number' && Number.isFinite(ahead) ? ahead : null;
  }
  get videoTracks() { return this.tracksOf('video'); }
  get audioTracks() { return this.tracksOf('audio'); }
  get textTracks() { return this.tracksOf('text'); }
  get route() { return this.routeValue; }
  get stats() {
    const s = this.statsValue.snapshot();
    return { ...s, droppedFrames: s.videoFramesDropped, underrunCount: s.audioUnderruns, decodedFps: s.fps, bitrateBps: this._bitrateBps() };
  }
  get volume() { return this._volume; }
  set volume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw stateError(`invalid volume: ${value}`);
    this._volume = value;
    this.pipeline?.setVolume?.(value);
  }
  get muted() { return this._muted; }
  set muted(value) { this._muted = Boolean(value); this.pipeline?.setMuted?.(this._muted); }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(value) {
    if (!Number.isFinite(value) || value <= 0) throw stateError(`invalid playbackRate: ${value}`);
    this._playbackRate = value;
    this.clock.setRate(value);
    this.pipeline?.setPlaybackRate?.(value);
  }

  tracksOf(type) { return (this.mediaInfoValue?.tracks ?? []).filter((t) => t.type === type); }

  /** 当前参与拉取的轨 id（按选中状态，剔除未选中与 metadata 轨） */
  _activeTrackIds() {
    const ids = [];
    for (const type of ['video', 'audio', 'text']) {
      const id = this.selectedTracks[type];
      if (id != null) ids.push(id);
    }
    return ids;
  }

  async load(input) {
    if (this.stateValue === PLAYER_STATES.DESTROYED) throw stateError('load(): player destroyed');
    if (this.stateValue !== PLAYER_STATES.IDLE) throw stateError(`load(): invalid state ${this.stateValue}`);
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._load(input).catch((error) => {
      const e = asPlayerError(error, '加载媒体失败');
      if (this.stateValue !== PLAYER_STATES.DESTROYED) this._transitionSafe(PLAYER_STATES.ERROR);
      this.emit('error', e);
      throw e;
    });
    return this._loadPromise;
  }

  async _load(input) {
    if (input == null || input === '') throw stateError('load(): input is required');
    let demuxer;
    if (input?.read && typeof input.read === 'function') {
      demuxer = await this.options.demuxerFactory?.(input, this.options.demuxerOptions) ??
        await createDemuxerAuto(input, { options: this.options.demuxerOptions });
    } else if (typeof input === 'string' || input instanceof URL) {
      if (this.options.demuxerFactory) demuxer = await this.options.demuxerFactory(String(input), this.options.demuxerOptions);
      else demuxer = await detectFromUrl(String(input), { fetchImpl: this.options.fetchImpl, options: this.options.demuxerOptions });
    } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
      const source = new BlobDataSource(input);
      demuxer = await (this.options.demuxerFactory?.(source, this.options.demuxerOptions) ??
        createDemuxerAuto(source, { options: this.options.demuxerOptions }));
    } else if (this.options.demuxerFactory) {
      // 测试、嵌入式宿主和自定义输入由注入工厂自行解释。
      demuxer = await this.options.demuxerFactory(input, this.options.demuxerOptions);
    } else {
      throw stateError('load(): unsupported input');
    }
    this.demuxer = demuxer;
    // 读取进度（网络/文件侧）透传到 Player 事件面（I2：progress 事件链路）
    if (typeof demuxer.on === 'function') {
      demuxer.on('progress', (payload) => this.emit('progress', payload));
    }
    const info = await demuxer.open();
    this.mediaInfoValue = info;
    const caps = this.options.capabilities ?? await detectForMedia(info, this.options);
    // 裁决尊重宿主 routePreference（默认 ['webcodecs','mse']：能用 WC 就不落 MSE）
    this.routeValue = this.options.route ?? chooseRoute(caps, info, { preference: this.options.routePreference });
    if (this.routeValue === 'none') throw notSupported('当前环境没有可用的解码播放路线', { container: info.container, tracks: info.tracks });
    const factory =
      this.options.pipelineFactory ??
      (this.routeValue === 'webcodecs' && hasWebCodecsCtor()
        ? DEFAULT_WC_PIPELINE
        : this.routeValue === 'mse' && hasMseCtor()
          ? DEFAULT_MSE_PIPELINE
          : null);
    this.pipeline = (await factory?.({ route: this.routeValue, mediaInfo: info, player: this, options: this.options })) ?? null;
    if (typeof this.pipeline?.on === 'function') {
      // 只转发契约事件名（§5）；'error' 由编排层统一进入 error 态
      for (const event of ['firstframe', 'stall', 'underrun', 'cue', 'audio-unavailable', 'catchup']) {
        this.pipeline.on(event, (payload) => this.emit(event, payload));
      }
    }
    for (const type of ['video', 'audio', 'text']) {
      const list = info.tracks.filter((t) => t.type === type);
      const picked = list.find((t) => t.default) ?? list[0];
      this.selectedTracks[type] = picked ? picked.id : null;
    }
    this.endedValue = false;
    this.currentTimeValue = 0;
    this._transition(PLAYER_STATES.READY);
    this.emit('trackschange', { tracks: info.tracks });
    return this;
  }

  async play() {
    this._requireLoaded('play');
    if (this.stateValue === PLAYER_STATES.PLAYING) return;
    if (![PLAYER_STATES.READY, PLAYER_STATES.PAUSED].includes(this.stateValue)) throw stateError(`play(): invalid state ${this.stateValue}`);
    if (this.endedValue) { await this.seek(0); }
    this._transition(PLAYER_STATES.PLAYING);
    this.clock.play(this.currentTimeValue / 1e6);
    this.pipeline?.play?.();
    // 起播前向缓冲：先把水位灌到 bufferTargetUs 再进入常规泵（CONTRACTS §5 bufferTargetUs）
    const token = ++this._pumpToken;
    await this._prebuffer(token);
    if (token !== this._pumpToken || this.stateValue !== PLAYER_STATES.PLAYING) return;
    void this._pump(++this._pumpToken);
  }

  pause() {
    this._requireLoaded('pause');
    if (this.stateValue !== PLAYER_STATES.PLAYING) return;
    this.currentTimeValue = this.currentTimeUs;
    this.clock.pause();
    this.pipeline?.pause?.();
    this._pumpToken++;
    this._transition(PLAYER_STATES.PAUSED);
  }

  async seek(timestampUs) {
    this._requireLoaded('seek');
    if (!Number.isFinite(timestampUs) || timestampUs < 0) throw stateError(`seek(): invalid timestampUs ${timestampUs}`);
    const previous = this.stateValue;
    this._pumpToken++;
    this._transition(PLAYER_STATES.SEEKING);
    try {
      const result = await this.demuxer.seek(Math.round(timestampUs));
      this.currentTimeValue = result.actualTimestampUs;
      this.endedValue = false; // 任何 seek 均清除 ended（HTMLMediaElement 语义；此前 play() 自动重播后 ended 恒为 true）
      this.clock.seekTo(this.currentTimeValue / 1e6);
      this.statsValue.markSeek();
      await this.pipeline?.seek?.(this.currentTimeValue);
      const returnState = previous === PLAYER_STATES.PLAYING
        ? PLAYER_STATES.PLAYING
        : previous === PLAYER_STATES.READY ? PLAYER_STATES.READY : PLAYER_STATES.PAUSED;
      this._transition(returnState);
      if (previous === PLAYER_STATES.PLAYING) { this.clock.play(this.currentTimeValue / 1e6); const token = ++this._pumpToken; void this._pump(token); }
      this._emitTimeupdate(true);
      return result;
    } catch (error) {
      const returnState = previous === PLAYER_STATES.PLAYING
        ? PLAYER_STATES.PLAYING
        : previous === PLAYER_STATES.READY ? PLAYER_STATES.READY : PLAYER_STATES.PAUSED;
      this._transitionSafe(returnState);
      throw asPlayerError(error, 'seek 失败');
    }
  }

  /**
   * 切换活动轨（video/audio/text）。
   * 切轨会中断并重启样本泵；管线侧负责重建解码链或 SourceBuffer。
   */
  async selectTrack(type, trackId) {
    this._requireLoaded('selectTrack');
    if (!['video', 'audio', 'text'].includes(type)) throw stateError(`selectTrack(): invalid type ${type}`);
    if (!this.mediaInfoValue.tracks.some((t) => t.type === type && t.id === trackId)) throw stateError(`track not found: ${type}/${trackId}`);
    if (this.selectedTracks[type] === trackId) return;
    const wasPlaying = this.stateValue === PLAYER_STATES.PLAYING;
    this._pumpToken++; // 中断当前泵，避免旧轨样本继续灌入
    try {
      await this.pipeline?.selectTrack?.(type, trackId);
    } catch (error) {
      throw asPlayerError(error, '切换轨道失败');
    }
    this.selectedTracks[type] = trackId;
    this.emit('trackchange', { type, trackId });
    if (wasPlaying) {
      const token = ++this._pumpToken;
      void this._pump(token);
    }
  }

  async destroy() {
    if (this.stateValue === PLAYER_STATES.DESTROYED) return;
    this._pumpToken++;
    try { await this.pipeline?.destroy?.(); } catch {}
    try { await this.demuxer?.destroy?.(); } catch {}
    this.pipeline = null;
    this.demuxer = null;
    this._transitionSafe(PLAYER_STATES.DESTROYED);
    this.emit('end', { reason: 'aborted' });
    this.removeAllListeners();
  }

  /**
   * 起播前向缓冲：先灌满 bufferTargetUs 再交给常规泵，避免一起播就 underrun。
   * 退出条件（任一）：水位达标 / 活动轨 EOS / 达到 prebufferMaxSamples / token 或状态被抢占。
   */
  async _prebuffer(token) {
    const target = this._bufferTargetUs();
    const ids = this._activeTrackIds();
    if (target <= 0 || ids.length === 0) return;
    const done = new Set();
    let minTs = null;
    let maxTs = null;
    let durationUs = 0;
    let count = 0;
    this._emitBuffering(true, { bufferedAheadUs: 0, targetUs: target });
    try {
      while (token === this._pumpToken && this.stateValue === PLAYER_STATES.PLAYING && done.size < ids.length) {
        let progressed = false;
        for (const id of ids) {
          if (done.has(id)) continue;
          const sample = await this.demuxer.readSample(id);
          if (!sample) { done.add(id); continue; }
          progressed = true;
          count += 1;
          const ts = sample.timestamp ?? 0;
          if (minTs === null || ts < minTs) minTs = ts;
          if (maxTs === null || ts > maxTs) maxTs = ts;
          durationUs += sample.duration ?? 0;
          await this._deliver(sample, id);
          if (this._bufferSatisfied(target, minTs, maxTs, durationUs)) return;
        }
        if (!progressed && done.size === ids.length) break;
        if (!progressed) await Promise.resolve();
        if (this._bufferSatisfied(target, minTs, maxTs, durationUs)) return;
        if (count >= this.options.prebufferMaxSamples) break;
      }
    } catch (error) {
      const e = asPlayerError(error, '起播缓冲失败');
      this._transitionSafe(PLAYER_STATES.ERROR);
      this.emit('error', e);
      throw e;
    } finally {
      this._emitBuffering(false, { bufferedAheadUs: this.bufferedAheadUs ?? 0, targetUs: target });
    }
  }

  /** 水位是否达标：管线自报水位优先，否则按已灌入样本的媒体时长跨度判定 */
  _bufferSatisfied(target, minTs, maxTs, durationUs) {
    const ahead = this.bufferedAheadUs;
    if (typeof ahead === 'number') return ahead >= target;
    const span = Math.max((maxTs ?? 0) - (minTs ?? 0), durationUs);
    return span >= target;
  }

  /** 背压：管线上报水位超过阈值时暂停拉流，等水位回落后继续（避免无界吃内存） */
  async _backpressure(token) {
    const limit = this._bufferTargetUs() * (this.options.backpressureFactor ?? 2);
    let ahead = this.bufferedAheadUs;
    if (typeof ahead !== 'number' || limit <= 0 || ahead <= limit) return;
    this._emitBuffering(true, { bufferedAheadUs: ahead, targetUs: limit, reason: 'backpressure' });
    let guard = 0;
    try {
      while (token === this._pumpToken && this.stateValue === PLAYER_STATES.PLAYING && guard < 4096) {
        guard += 1;
        await new Promise((resolve) => this._schedule(resolve, this.options.backpressurePollMs ?? 50));
        ahead = this.bufferedAheadUs;
        if (typeof ahead !== 'number' || ahead <= limit) break;
      }
    } finally {
      this._emitBuffering(false, { bufferedAheadUs: ahead ?? 0, targetUs: limit, reason: 'backpressure' });
    }
  }

  /** 单个样本的统一投递口：统计 → 管线 → 事件（预缓冲与常规泵共用） */
  async _deliver(sample, trackId) {
    this.currentTimeValue = Math.max(this.currentTimeValue, sample.timestamp ?? 0);
    const bytes = sample.size ?? sample.data?.byteLength ?? 0;
    this.statsValue.markDemuxed(bytes);
    this._markBitrate(bytes);
    this.statsValue.markSampleDecoded();
    await this.pipeline?.pushSample?.(sample);
    this.emit('sample', { trackId, sample });
    this._emitTimeupdate();
  }

  /** 当前起播水位（µs）：直播用 liveLatencyUs，点播用 bufferTargetUs */
  _bufferTargetUs() {
    const live = this.mediaInfoValue?.live === true;
    const target = live
      ? (this.options.liveLatencyUs ?? this.options.bufferTargetUs)
      : this.options.bufferTargetUs;
    return Number.isFinite(target) && target > 0 ? target : 0;
  }

  _emitBuffering(active, payload = {}) {
    this.emit('buffering', { active: active === true, ...payload });
  }

  /** 记录一个采样点用于滑动窗口码率统计 */
  _markBitrate(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const t = this._nowSec();
    this._bitrateWindow.push({ t, bytes });
    const windowSec = this.options.bitrateWindowSec ?? 1;
    while (this._bitrateWindow.length > 0 && t - this._bitrateWindow[0].t > windowSec) this._bitrateWindow.shift();
  }

  /** 滑动窗口码率（bps）；样本过稀时以 0.5s 为分母下限，避免瞬时尖刺 */
  _bitrateBps() {
    const w = this._bitrateWindow;
    if (w.length === 0) return 0;
    const span = Math.max(this._nowSec() - w[0].t, 0.5);
    let bytes = 0;
    for (const item of w) bytes += item.bytes;
    return Math.round((bytes * 8) / span);
  }

  _nowSec() {
    return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
  }

  async _pump(token) {
    const ids = this._activeTrackIds();
    if (ids.length === 0) return;
    const done = new Set();
    while (token === this._pumpToken && this.stateValue === PLAYER_STATES.PLAYING && done.size < ids.length) {
      let progressed = false;
      for (const id of ids) {
        if (done.has(id)) continue;
        try {
          const sample = await this.demuxer.readSample(id);
          if (!sample) { done.add(id); continue; }
          progressed = true;
          await this._deliver(sample, id);
          await this._backpressure(token);
        } catch (error) {
          const e = asPlayerError(error, '读取样本失败');
          this._transitionSafe(PLAYER_STATES.ERROR);
          this.emit('error', e);
          return;
        }
      }
      if (!progressed && done.size === ids.length) break;
      if (!progressed) await Promise.resolve();
    }
    if (token === this._pumpToken && done.size === ids.length && this.stateValue === PLAYER_STATES.PLAYING) {
      // 给管线收尾机会（MSE 需要 flush + endOfStream 才能触发元素 ended）
      try { await this.pipeline?.end?.(); } catch { /* 收尾失败不掩盖自然结束 */ }
      this.endedValue = true;
      this.clock.pause();
      this._transitionSafe(PLAYER_STATES.PAUSED);
      this.emit('ended');
    }
  }

  _emitTimeupdate(force = false) {
    const now = this.currentTimeUs;
    if (force || now - this._lastTimeEventUs >= 250000) {
      this._lastTimeEventUs = now;
      this.emit('timeupdate', { currentTimeUs: now, durationUs: this.durationUs });
    }
  }
  _requireLoaded(method) {
    if (!this.demuxer || [PLAYER_STATES.IDLE, PLAYER_STATES.ERROR, PLAYER_STATES.DESTROYED].includes(this.stateValue)) throw stateError(`${method}(): player is not loaded (state=${this.stateValue})`);
  }
  _transition(next) {
    if (!(TRANSITIONS[this.stateValue] ?? []).includes(next)) throw stateError(`illegal player state transition: ${this.stateValue} → ${next}`);
    this.stateValue = next;
    this.emit('statechange', this.stateValue);
  }
  _transitionSafe(next) { try { this._transition(next); } catch {} }
}

export async function createPlayer(options = {}) { return new Player(options); }
