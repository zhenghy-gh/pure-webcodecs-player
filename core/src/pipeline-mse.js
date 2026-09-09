/**
 * MSE 播放管线（CONTRACTS §6 MSE 兼容路径）。
 *
 * 职责边界：只做「样本 → fMP4 重封装 → SourceBuffer → <video>/<audio> 内建解码渲染」，
 * 不含容器解析与生命周期编排（那是 core/src/player.js 的事）。
 * MediaSource 封装（MseHelper）、fMP4 重封装器、mediaElement 全部可注入，
 * 因此同一套代码可在 Node 下用假实现单测、在浏览器里用真实 MSE 跑。
 *
 * 铁律（§6）：
 *  - 「能用 WebCodecs 就不落 MSE」——本管线只在 chooseRoute 裁决为 'mse' 时挂载；
 *  - appendBuffer 必须串行化且受缓冲水位背压约束（浏览器禁止同一 SB 并发更新）；
 *  - 分片按 GOP 边界切，段首必须是关键帧（随机的 tfdt 基准；续传不重发 init）；
 *  - 对外错误一律 core 十码封闭枚举。
 */
import { Emitter } from './emitter.js';
import { decodeError, notSupported, stateError } from './errors.js';
import { buildMseMimeType } from './codec-string.js';

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (typeof t?.unref === 'function') t.unref();
  return () => clearTimeout(t);
}

/** 默认 fMP4 重封装器：按需延迟引入 mp4 模块（core 不硬依赖上层容器模块） */
async function defaultRemuxerFactory() {
  try {
    const mod = await import('../../mp4/src/remuxer.js');
    return new mod.Fmp4Remuxer();
  } catch (err) {
    throw notSupported('MSE 管线需要 fMP4 重封装器（mp4/remuxer）', { cause: err });
  }
}

/** 默认 MediaSource 封装：core 自带 MseHelper */
async function defaultMseFactory({ element, managed }) {
  const { MseHelper } = await import('./mse-helper.js');
  return new MseHelper(element, { managed: managed === true });
}

export class MsePipeline extends Emitter {
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
    /** 当前选中轨（按类型）：未选中的同类轨样本不进 SourceBuffer */
    this.active = { video: null, audio: null, text: null };
    for (const t of this._tracks.values()) {
      if (this.active[t.type] == null) this.active[t.type] = t.id;
    }

    this.element = this.options.mediaElement ?? this.options.video ?? null;
    this.mse = this.options.mse ?? null;
    this.remuxer = this.options.remuxer ?? null;
    this._mseFactory = this.options.mseFactory ?? defaultMseFactory;
    this._remuxerFactory = this.options.remuxerFactory ?? defaultRemuxerFactory;
    this._schedule = this.options.schedule ?? defaultSchedule;

    this._segmentDurationUs = this.options.segmentDurationUs ?? 2_000_000;
    this._maxBufferAheadSec = this.options.maxBufferAheadSec ?? 30;
    /** @type {Map<number, object[]>} 待重封装样本（按轨） */
    this._pending = new Map();
    /** @type {Map<number, number>} 待重封装样本累计时长（µs） */
    this._pendingUs = new Map();

    this.state = 'ready';
    this.counters = { initSegments: 0, mediaSegments: 0, samples: 0, bytes: 0, cues: 0 };
    this._initialized = false;
    this._firstFrameEmitted = false;
    this._elementOffs = [];
  }

  /* ------------------------------ 构建 ------------------------------ */

  /** 建管线：开 MediaSource、建 SourceBuffer、写 init segment。幂等。 */
  async init() {
    if (this._initialized) return this;
    if (!this.element) throw notSupported('MSE 管线需要 mediaElement（<video>/<audio>）');
    // mse 可注入（测试/宿主复用），未注入时用默认 MseHelper 打开
    this.mse = this.mse ?? (await this._mseFactory({ element: this.element, managed: this.options.managed }));
    await this.mse.open?.();
    this.remuxer = this.remuxer ?? (await this._remuxerFactory());

    // 两阶段建轨：① 先为所有活动轨建齐 SourceBuffer —— 真实 Chrome 一旦某 SB 写过数据，
    // 再新建 SB 会以 QuotaExceededError 拒绝（"reached the limit of SourceBuffer objects"）；
    // ② 再统一写 init segment。两者不能交错。
    const pendingInits = [];
    for (const track of this._tracks.values()) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      // 只为当前选中轨建 SourceBuffer（其余等 selectTrack 时再建）
      if (this.active[track.type] !== track.id) continue;
      const key = this._keyOf(track);
      const mime = this.mimeFor(track);
      await this.mse.addTrack(key, mime);
      pendingInits.push({ track, key, mime, init: this.remuxer.createInitSegment(track) });
      this.emit('trackAdded', { trackId: track.id, key, mime });
    }
    for (const { key, init } of pendingInits) {
      await this.mse.append(key, init);
      this.counters.initSegments += 1;
    }
    const durationUs = this.mediaInfo?.durationUs;
    if (Number.isFinite(durationUs) && durationUs > 0) {
      try { await this.mse.setDuration?.(durationUs / 1_000_000); } catch { /* 直播流无时长 */ }
    }
    this._attachElementEvents();
    this._initialized = true;
    return this;
  }

  _keyOf(track) {
    return `${track.type === 'audio' ? 'a' : 'v'}${track.id}`;
  }

  /** 组装 SourceBuffer mime（video/mp4 或 audio/mp4 + codecs） */
  mimeFor(track) {
    if (this.options.mimeFor) return this.options.mimeFor(track);
    const container = track.type === 'audio' ? 'audio/mp4' : 'video/mp4';
    return buildMseMimeType(container, [track.codec]);
  }

  _attachElementEvents() {
    const el = this.element;
    if (!el || typeof el.addEventListener !== 'function') return;
    const bind = (type, handler) => {
      el.addEventListener(type, handler);
      this._elementOffs.push(() => el.removeEventListener(type, handler));
    };
    bind('loadeddata', () => this._emitFirstFrame());
    bind('canplay', () => this._emitFirstFrame());
    bind('waiting', () => this.emit('stall', { bufferedSec: this.bufferedAheadSec() }));
    bind('error', () => this.emit('error', decodeError('media element error', { code: el.error?.code })));
  }

  _emitFirstFrame() {
    if (this._firstFrameEmitted) return;
    this._firstFrameEmitted = true;
    this.emit('firstframe', { timestampUs: this.currentTimeUs });
  }

  /* ------------------------------ 输入 ------------------------------ */

  /** 消费一个样本（Player 的样本泵调用）。 */
  async pushSample(sample) {
    if (this.state === 'destroyed') return;
    const track = this._tracks.get(sample.trackId);
    if (!track) return;
    if (this.active[track.type] != null && this.active[track.type] !== track.id) return; // 非选中轨
    if (track.type === 'text') return this._emitCue(sample);
    if (track.type !== 'video' && track.type !== 'audio') return;

    const batch = this._pending.get(track.id) ?? [];
    batch.push(sample);
    this._pending.set(track.id, batch);
    this._pendingUs.set(track.id, (this._pendingUs.get(track.id) ?? 0) + (sample.duration ?? 0));
    this.counters.samples += 1;

    // GOP 边界 + 目标时长双条件成段：段首为关键帧，避免随机 tfdt 基准踩花屏
    const acc = this._pendingUs.get(track.id) ?? 0;
    if (acc >= this._segmentDurationUs && sample.keyframe !== false) {
      await this.flush(track.id);
    }
  }

  /** 把某轨待封装样本立即成段并 append（受缓冲水位背压）。 */
  async flush(trackId) {
    const track = this._tracks.get(trackId);
    const batch = this._pending.get(trackId) ?? [];
    if (!track || batch.length === 0) return null;
    this._pending.set(trackId, []);
    this._pendingUs.set(trackId, 0);
    const key = this._keyOf(track);
    await this._waitBuffer(key);
    const segment = this.remuxer.createMediaSegment(track, batch);
    try {
      await this.mse.append(key, segment.data);
    } catch (err) {
      const e = err?.code ? err : decodeError('appendBuffer 失败', { cause: err });
      this.emit('error', e);
      throw e;
    }
    this.counters.mediaSegments += 1;
    this.counters.bytes += segment.data.byteLength ?? 0;
    this.emit('segment', {
      trackId,
      sequenceNumber: segment.sequenceNumber,
      sampleCount: segment.sampleCount,
      baseMediaDecodeTimeUs: segment.baseMediaDecodeTimeUs,
      durationUs: segment.durationUs,
    });
    return segment;
  }

  /** 全部轨收尾：flush 后 endOfStream（不调用则元素永不触发 ended）。 */
  async end() {
    if (this.state === 'destroyed' || !this.mse) return;
    for (const id of [...this._pending.keys()]) {
      try { await this.flush(id); } catch { /* 错误已广播 */ }
    }
    try {
      await this.mse.endOfStream?.();
      this.emit('eos', { reason: 'endOfStream' });
    } catch (err) {
      this.emit('error', decodeError('endOfStream 失败', { cause: err }));
    }
  }

  /** 背压：缓冲水位超阈值时让出事件循环。 */
  async _waitBuffer(key) {
    const ahead = () => this.mse?.bufferedAhead?.(key) ?? 0;
    let guard = 0;
    while (ahead() > this._maxBufferAheadSec && guard < 256) {
      guard += 1;
      await new Promise((resolve) => this._schedule(resolve, 50));
    }
  }

  /**
   * 缓冲水位（µs）：取活动音视频轨 SourceBuffer 中最小者——木桶效应决定能否继续播。
   * MSE 未就绪或元素不提供 buffered 时返回 null（Player 侧跳过背压）。
   */
  get bufferedAheadUs() {
    if (!this.mse || typeof this.mse.bufferedAhead !== 'function') return null;
    let min = null;
    for (const track of this._tracks.values()) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      if (this.active[track.type] !== track.id) continue;
      const sec = this.mse.bufferedAhead(this._keyOf(track));
      if (Number.isFinite(sec)) min = min === null ? sec : Math.min(min, sec);
    }
    return min === null ? null : Math.round(min * 1_000_000);
  }

  /**
   * 已缓冲区间（µs）：逐活动轨取 SourceBuffer.buffered 并转微秒。
   * 多轨区间可能重叠，UI 需要时自行合并；无 MSE 返回 null。
   */
  getBufferedRanges() {
    if (!this.mse || typeof this.mse.buffered !== 'function') return null;
    const out = [];
    for (const track of this._tracks.values()) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      if (this.active[track.type] !== track.id) continue;
      const ranges = this.mse.buffered(this._keyOf(track));
      if (!ranges) continue;
      for (let i = 0; i < ranges.length; i++) {
        out.push({ startUs: Math.round(ranges.start(i) * 1_000_000), endUs: Math.round(ranges.end(i) * 1_000_000) });
      }
    }
    return out;
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

  /* ------------------------------ 生命周期 ------------------------------ */

  play() {
    if (this.state === 'destroyed') return;
    this.state = 'playing';
    try { this.element?.play?.(); } catch (err) { this.emit('error', decodeError('play() 被拒绝', { cause: err })); }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    try { this.element?.pause?.(); } catch { /* 元素未 ready 可忽略 */ }
  }

  /** @param {number} timestampUs 实际落点（整数微秒） */
  async seek(timestampUs) {
    this._pending.clear();
    this._pendingUs.clear();
    if (!this.mse) return;
    for (const track of this._tracks.values()) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      if (this.active[track.type] !== track.id) continue;
      try {
        await this.mse.resetTrack?.(this._keyOf(track), false);
      } catch (err) {
        this.emit('error', decodeError('seek 清缓冲失败', { cause: err }));
      }
    }
    if (this.element) this.element.currentTime = Math.round(timestampUs) / 1_000_000;
    this.emit('seeked', { timestampUs: Math.round(timestampUs) });
  }

  setVolume(v) { if (this.element) this.element.volume = v; }
  setMuted(m) { if (this.element) this.element.muted = Boolean(m); }
  setPlaybackRate(rate) { if (this.element) this.element.playbackRate = rate; }

  /**
   * 切换活动轨：MSE 下需为新轨建 SourceBuffer 并补写 init segment
   * （同轨已存在则只清缓冲，不重复建）。
   * @param {'video'|'audio'|'text'} type
   * @param {number} trackId
   */
  async selectTrack(type, trackId) {
    const track = this._tracks.get(trackId);
    if (!track || track.type !== type) throw stateError(`track not found: ${type}/${trackId}`);
    if (this.active[type] === trackId) return;
    const previousId = this.active[type];
    this.active[type] = trackId;
    // 旧轨待封装样本直接丢弃，避免串到新轨时间轴
    if (previousId != null) {
      this._pending.delete(previousId);
      this._pendingUs.delete(previousId);
    }
    if (type === 'video' || type === 'audio') {
      const key = this._keyOf(track);
      if (!this.mse?.tracks?.has?.(key) && !this.mse?.channels?.has?.(key)) {
        const mime = this.mimeFor(track);
        await this.mse.addTrack(key, mime);
        const init = this.remuxer.createInitSegment(track);
        await this.mse.append(key, init);
        this.counters.initSegments += 1;
      }
    }
    this.emit('trackchange', { type, trackId, codec: track.codec });
  }

  async destroy() {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    this._pending.clear();
    this._pendingUs.clear();
    for (const off of this._elementOffs) {
      try { off(); } catch { /* 忽略 */ }
    }
    this._elementOffs = [];
    try { this.mse?.destroy?.(); } catch { /* 忽略 */ }
    this.mse = null;
    this.remuxer = null;
  }

  /* ------------------------------ 时钟与统计 ------------------------------ */

  /** 主时钟（秒）：MSE 下直接取元素时间轴 */
  currentTimeSec() {
    const t = this.element?.currentTime;
    return Number.isFinite(t) ? t : 0;
  }

  get currentTimeUs() {
    return Math.round(this.currentTimeSec() * 1_000_000);
  }

  bufferedAheadSec(key = undefined) {
    const keys = key ? [key] : [...this._tracks.values()].map((t) => this._keyOf(t));
    let max = 0;
    for (const k of keys) max = Math.max(max, this.mse?.bufferedAhead?.(k) ?? 0);
    return max;
  }

  get stats() {
    return {
      ...this.counters,
      bufferedAheadSec: this.bufferedAheadSec(),
      underrunCount: 0,
    };
  }
}

/**
 * 生成 Player 可用的 MSE 管线工厂。
 * @param {object} [options] 覆盖 mediaElement / mse / remuxer / 分片策略
 * @returns {(ctx:{route:string,mediaInfo:MediaInfo,player:object,options:object}) => Promise<MsePipeline>}
 */
export function msePipelineFactory(options = {}) {
  return async function createPipeline(ctx) {
    const merged = { ...ctx.options, ...options };
    const pipeline = new MsePipeline({ ...ctx, options: merged });
    await pipeline.init();
    return pipeline;
  };
}
