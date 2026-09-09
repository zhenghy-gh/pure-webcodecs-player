/**
 * Demuxer 基类 —— CONTRACTS v0.2 §2.2 定稿骨架。
 *
 * 生命周期状态机（基类强制）：`idle → opening → ready ⇄ seeking → destroyed`，
 * 直播态叠加 paused 标志；非法迁移抛 PlayerError('STATE_ERROR')。
 *
 * 公开 API（冻结，§12.3）：
 *   static probe(bytes) -> ProbeResult|null   同步、无副作用、不抛异常
 *   constructor(source, options)              DataSource|ChunkSource 直接入参
 *   open()                                    解析初始化段，emit('media-info')
 *   readSample(trackId) -> Promise<Sample|null>   pull 主通道；EOS 为 null
 *   samples(trackId)                          异步迭代器糖层
 *   seek(timestampUs) -> Promise<{actualTimestampUs}>   仅 seekable
 *   pause() / resume() / start()【可选】
 *   destroy()                                 幂等；之后一切调用抛 STATE_ERROR
 *   mediaInfo / tracks / metadata 属性；getBufferedRanges(trackId)
 *
 * 事件（§2.3）：'error' / 'media-info' / 'sample'(直播推送) / 'progress' / 'end'
 *
 * 子类职责（受保护钩子）：
 *   _doOpen()                 解析容器头，返回 MediaInfo（时间基 µs）
 *   _createTrackIterator(id)  返回该轨的 AsyncGenerator<Sample>（µs、契约形状）
 *   _doSeek(timestampUs)      可选；默认 reject SEEK_UNSUPPORTED
 *   getBufferedRanges(id)     可选覆盖
 *
 * 时间基（§0.5）：边界一律整数微秒；ticks 只许存在于子类内部。
 */
import { Emitter } from './emitter.js';
import {
  stateError,
  timeoutError,
  seekUnsupported,
} from './errors.js';
import { sortTracks } from './types.js';
import { raceAbort, throwIfAborted } from './abort.js';

/** @typedef {'idle'|'opening'|'ready'|'seeking'|'destroyed'} DemuxerState */

export const DEMUXER_STATES = Object.freeze({
  IDLE: 'idle',
  OPENING: 'opening',
  READY: 'ready',
  SEEKING: 'seeking',
  DESTROYED: 'destroyed',
});

const LEGAL_TRANSITIONS = Object.freeze({
  idle: ['opening', 'destroyed'],
  opening: ['ready', 'destroyed'],
  ready: ['seeking', 'destroyed'],
  seeking: ['ready', 'destroyed'],
  destroyed: [],
});

export class Demuxer extends Emitter {
  static containerName = 'base';

  /**
   * 静态嗅探。契约：同步、无副作用、**不抛异常**；
   * 不命中返回 null，命中返回 ProbeResult（confidence ≥0.8 视为命中）。
   * @param {Uint8Array} bytes 至少 64B（调用方建议给满 4KiB）
   * @returns {ProbeResult|null}
   */
  static probe(bytes) {
    void bytes;
    return null;
  }

  /**
   * @param {DataSource|ChunkSource} source 随机读源或流式源
   * @param {{initTimeoutMs?: number, liveLatencyUs?: number, lazySamples?: boolean}} [options]
   */
  constructor(source, options = {}) {
    super();
    this.source = source ?? null;
    this.options = {
      initTimeoutMs: 10000,
      ...options,
    };
    /** @type {MediaInfo|null} */
    this.mediaInfoValue = null;
    /** @type {DemuxerState} */
    this.stateValue = DEMUXER_STATES.IDLE;
    this.pausedFlag = false;
    this._live = false;

    /** @type {Map<number, {gen: AsyncGenerator<Sample>, done: boolean}>} */
    this._trackIterators = new Map();
    this._openPromise = null;
  }

  /* ------------------------------ 状态机 ------------------------------ */

  get state() {
    return this.stateValue;
  }

  _transition(next) {
    const allowed = LEGAL_TRANSITIONS[this.stateValue] ?? [];
    if (!allowed.includes(next)) {
      throw stateError(`illegal demuxer state transition: ${this.stateValue} → ${next}`);
    }
    // ready ⇄ seeking 双向由白名单表达；其余单向
    this.stateValue = next;
    this.emit('statechange', this.stateValue);
  }

  _requireUsable(method) {
    if (this.stateValue === DEMUXER_STATES.DESTROYED || !this._usable) {
      throw stateError(`${method}: demuxer is not usable (state=${this.stateValue})`);
    }
  }

  /** ready 或 seeking 都算可用态 */
  get _usable() {
    return (
      this.stateValue === DEMUXER_STATES.READY ||
      this.stateValue === DEMUXER_STATES.SEEKING
    );
  }

  /* ------------------------------ 打开 ------------------------------ */

  /**
   * 打开并解析初始化段。幂等（并发调用共享同一 promise）。
   * 流式数据不足时等待，受 options.initTimeoutMs 约束，超时 reject TIMEOUT。
   * @returns {Promise<MediaInfo>}
   */
  open() {
    if (this.stateValue === DEMUXER_STATES.DESTROYED) {
      return Promise.reject(stateError('open(): demuxer already destroyed'));
    }
    if (this.stateValue === DEMUXER_STATES.OPENING && this._openPromise) {
      return this._openPromise;
    }
    if (this._usable) return Promise.resolve(this.mediaInfoValue);

    if (!this.source) {
      return Promise.reject(stateError('open(): no source (pass it to constructor or call attach())'));
    }
    this._transition(DEMUXER_STATES.OPENING);
    this._openPromise = Promise.race([
      (async () => {
        try {
          await this.source.open?.();
          const info = await this._doOpen();
          info.tracks = sortTracks(info.tracks);
          this.mediaInfoValue = info;
          this._live = info.live === true;
          this._transition(DEMUXER_STATES.READY);
          // 契约事件名 + 过渡期旧名双发（M2 接入波次移除旧名）
          this.emit('media-info', info);
          this.emit('mediaInfo', info);
          return info;
        } catch (err) {
          this._transitionSafe(DEMUXER_STATES.DESTROYED);
          this.emit('error', err);
          throw err;
        }
      })(),
      new Promise((_, reject) => {
        const t = setTimeout(() => {
          // 超时：回退到 idle 允许调用方换源重试
          if (this.stateValue === DEMUXER_STATES.OPENING) this.stateValue = DEMUXER_STATES.IDLE;
          reject(timeoutError(`open() timed out after ${this.options.initTimeoutMs}ms`));
        }, this.options.initTimeoutMs);
        // 不阻塞进程退出
        if (typeof t?.unref === 'function') t.unref();
      }),
    ]).then(
      (info) => info,
      (err) => {
        this._openPromise = null;
        throw err;
      },
    );
    return this._openPromise;
  }

  _transitionSafe(next) {
    try {
      this._transition(next);
    } catch {
      /* 已在终态时忽略 */
    }
  }

  /* ------------------------------ 读样本 ------------------------------ */

  /**
   * 拉取指定轨下一个样本（pull 主通道，天然背压）。EOS resolve null。
   *
   * @param {number} trackId
   * @param {{signal?:AbortSignal|null}} [options] 可选中断信号（§12.3「新增可选成员」演进项）。
   *   传入后可在样本读取挂起时主动取消，reject PlayerError('ABORTED')；
   *   **不传时行为与冻结版完全一致**。abort 不推进 `done`、不 emit('error')，
   *   中断后仍可继续 readSample 续读。
   */
  async readSample(trackId, options = undefined) {
    this._requireUsable('readSample');
    const signal = options?.signal ?? null;
    throwIfAborted(signal, `readSample(${trackId}) aborted`);
    let entry = this._trackIterators.get(trackId);
    if (!entry) {
      entry = { gen: this._createTrackIterator(trackId), done: false, pendingResult: null };
      this._trackIterators.set(trackId, entry);
    }
    if (entry.done) return null;
    let sample;
    try {
      let result;
      if (entry.pendingResult) {
        // 上次被中断、但迟到落地的样本：优先吐出，避免中断吞样本
        result = entry.pendingResult;
        entry.pendingResult = null;
      } else {
        const nextP = entry.gen.next();
        if (signal) {
          // 中断竞速期间已落地的样本不丢弃，缓存供下次续读（生成器 yield 一旦
          // 落地就无法回退，不缓存即永久丢帧；flac/wav 走「先读后推进游标」同理）
          nextP.then((r) => { if (r && !r.done) entry.pendingResult = r; }, () => {});
        }
        result = await raceAbort(nextP, signal, `readSample(${trackId}) aborted`);
      }
      ({ value: sample, done: entry.done } = result);
    } catch (err) {
      // abort 属调用方预期控制流，不进 'error' 事件面（见 core/src/abort.js 设计取舍）
      if (err?.code !== 'ABORTED') this.emit('error', err);
      throw err;
    }
    if (entry.done || !sample) {
      entry.done = true;
      await entry.gen.return?.(undefined);
      this._maybeEmitEnd();
      return null;
    }
    if (this.pausedFlag && this._live) {
      // 直播暂停：样本继续缓冲进上层，但通过事件通道保持语义一致
      void sample;
    }
    this.emit('sample', { trackId, sample });
    return sample;
  }

  /**
   * 异步迭代器糖层（等价循环 readSample）。
   * @param {number} [trackId] 缺省时按轨序串行消费全部轨
   * @param {{signal?:AbortSignal|null}} [options] 透传给 readSample 的可选中断信号
   */
  samples(trackId = undefined, options = undefined) {
    const self = this;
    async function* iterate() {
      self._requireUsable('samples');
      const ids = trackId !== undefined ? [trackId] : self.trackIds();
      for (const id of ids) {
        for (;;) {
          const s = await self.readSample(id, options);
          if (s === null) break;
          yield s;
        }
      }
    }
    return iterate();
  }

  trackIds() {
    return (this.mediaInfoValue?.tracks ?? []).map((t) => t.id);
  }

  /* ------------------------------ seek ------------------------------ */

  /**
   * seek 到目标微秒。清空各轨缓冲并把迭代起点对齐关键帧；
   * resolve 实际落点 {actualTimestampUs}。直播/无索引 reject SEEK_UNSUPPORTED。
   * @param {number} timestampUs 整数微秒
   */
  async seek(timestampUs) {
    this._requireUsable('seek');
    if (this.mediaInfoValue && !this.mediaInfoValue.seekable) {
      throw seekUnsupported('stream is not seekable (live or index-less)');
    }
    if (!Number.isFinite(timestampUs) || timestampUs < 0) {
      throw stateError(`seek(): invalid timestampUs ${timestampUs}`);
    }
    this._transition(DEMUXER_STATES.SEEKING);
    try {
      // 清空各轨缓冲与迭代器（子类 _doSeek 负责重定位内部游标）
      for (const entry of this._trackIterators.values()) {
        await entry.gen.return?.(undefined);
      }
      this._trackIterators.clear();
      const result = await this._doSeek(Math.round(timestampUs));
      return result ?? { actualTimestampUs: Math.round(timestampUs) };
    } finally {
      if (this.stateValue === DEMUXER_STATES.SEEKING) {
        this._transition(DEMUXER_STATES.READY);
      }
    }
  }

  /* ------------------------------ 直播推送控制 ------------------------------ */

  /** 【可选】直播推送模式入口，配合 'sample' 事件 */
  start() {}

  /** 直播推送模式暂停吐包（缓冲继续累积） */
  pause() {
    this.pausedFlag = true;
    this.emit('pause');
  }

  /** 恢复推送 */
  resume() {
    this.pausedFlag = false;
    this.emit('resume');
  }

  /* ------------------------------ 销毁 ------------------------------ */

  /**
   * 销毁：释放数据源与全部缓冲。幂等；之后一切调用抛 STATE_ERROR。
   *
   * 实时性保证：不再 `await gen.return()`——V8 异步生成器在 `await` 一个永不 resolve 的
   * 外部 promise（如网络读卡死）时，`return()` 需等该 promise 落地才能退出，会导致
   * destroy 挂起。这里仅标记各迭代器 `done` 并清空映射，in-flight `readSample` 最终落地
   * 后的样本由上层（Player）按 state==destroyed 丢弃；新 `readSample` 由 `_requireUsable`
   * 拒绝，避免在已关闭的数据源上创建新生成器。
   */
  async destroy() {
    if (this.stateValue === DEMUXER_STATES.DESTROYED) return;
    this._transitionSafe(DEMUXER_STATES.DESTROYED);
    for (const entry of this._trackIterators.values()) {
      entry.done = true;
    }
    this._trackIterators.clear();
    try {
      await this.source?.close?.();
    } catch {
      /* close 尽力而为 */
    }
    this.emit('end', { reason: 'aborted' });
    this.removeAllListeners();
  }

  /* ------------------------------ 属性 ------------------------------ */

  get mediaInfo() {
    return this.mediaInfoValue;
  }

  get tracks() {
    return this.mediaInfoValue?.tracks ?? [];
  }

  /** 快捷元信息视图 */
  get metadata() {
    const m = this.mediaInfoValue;
    if (!m) return null;
    return {
      container: m.container,
      durationUs: m.durationUs,
      live: m.live,
      seekable: m.seekable,
      ...(m.metadata?.title ? { title: m.metadata.title } : {}),
      ...m.metadata,
    };
  }

  /** @returns {Array<{startUs:number,endUs:number}>} 默认空实现 */
  getBufferedRanges(_trackId) {
    return [];
  }

  /* ------------------------------ 内部 ------------------------------ */

  _maybeEmitEnd() {
    const entries = [...this._trackIterators.values()];
    if (entries.length > 0 && entries.every((e) => e.done)) {
      this.emit('end', { reason: 'eos' });
    }
  }

  /* ------------------------------ 受保护钩子 ------------------------------ */

  /** 解析初始化段，返回契约 MediaInfo（µs）。 */
  async _doOpen() {
    throw stateError(`${this.constructor.name} must implement _doOpen()`);
  }

  /** 返回指定轨的样本生成器（契约 Sample 形状，µs）。 */
  _createTrackIterator(_trackId) {
    throw stateError(`${this.constructor.name} must implement _createTrackIterator()`);
  }

  /** 可选：按轨实现真实 seek；默认不支持。 */
  async _doSeek(_timestampUs) {
    throw seekUnsupported(`${this.constructor.name} does not support seeking`);
  }

  /* ------------------------------ 过渡别名（§2.4，M2 清理） ------------------------------ */

  /** @deprecated 别名：constructor 入参已含 source；此方法仅保留给旧调用方 */
  attach(dataSourceOrSourceLike) {
    if (this.stateValue !== DEMUXER_STATES.IDLE) {
      throw stateError('attach(): only allowed before open()');
    }
    this.source =
      typeof dataSourceOrSourceLike.read === 'function'
        ? dataSourceOrSourceLike
        : dataSourceOrSourceLike;
    return this;
  }

  /** @deprecated 别名定稿名为 open()（§2.4） */
  init() {
    return this.open();
  }

  /** @deprecated 旧的 getMediaInfo 访问器 */
  getMediaInfo() {
    return this.mediaInfoValue;
  }

  /** @deprecated 用 tracks 属性 */
  getTracks(type = undefined) {
    return type === undefined ? [...this.tracks] : this.tracks.filter((t) => t.type === type);
  }

  /** @deprecated 用 tracks 属性 */
  getTrack(trackId) {
    return this.tracks.find((t) => t.id === trackId) ?? null;
  }

  /** @deprecated 读取单个样本字节的便捷路径保留（lazy 场景） */
  async readSampleData(sample) {
    if (sample.data) return sample.data;
    if (!this.source) throw stateError('no source attached');
    sample.data = await this.source.read(sample.offset, sample.size);
    return sample.data;
  }
}
