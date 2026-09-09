/**
 * TsDemuxer —— MPEG-TS 解复用器（CONTRACTS v0.2 契约适配壳）
 *
 * 公开面（冻结 §12.3）：
 *   static probe(bytes) -> ProbeResult|null
 *   open() / readSample(trackId) / samples(trackId) / seek(us) / pause / resume / destroy
 *   兼容通道：push(chunk) / flush()（§2.4 迁移期，喂内部引擎）
 *   直播推送：start() 后经基类通道以 'sample' 事件吐包
 *   mediaInfo / tracks / metadata 属性；getBufferedRanges(trackId)
 *
 * 内部实现：push/flush 流式解析内核（./ts-stream-engine.js），对外边界完成
 *   ticks→整数微秒换算（§0.5）、codec string 经 core/src/codec-string.js 生成（§3）、
 *   Track/Sample/MediaInfo 使用 core/src/types.js 权威形状（§1）。
 *
 * 数据源（§2.1 双模，source 缺省容忍为空内存源——纯引擎/旧式用法不抛错）：
 *   - DataSource（随机读）：内部顺序泵读取，读到 EOF 自动收尾；
 *   - ChunkSource（流式）：构造时接管 write/end，把字节导入引擎。
 */

import {
  Demuxer,
  DEMUXER_STATES,
  MemoryDataSource,
  BlobDataSource,
  asDataSource,
  createProbeResult,
  createTrack,
  createSample,
  ticksToUs,
  buildAvcCodecString,
  buildHevcCodecString,
  aacCodecStringFromAsc,
  fallbackCodecString,
} from '../../core/src/index.js';
import { parseError, probeFailed, stateError, seekUnsupported } from '../../core/src/errors.js';
import { TsStreamEngine } from './ts-stream-engine.js';

/** 顺序泵的读取块大小 */
const PUMP_CHUNK = 64 * 1024;
const SYNC_BYTE_LOCAL = 0x47;

export class TsDemuxer extends Demuxer {
  static containerName = 'ts';

  /**
   * 同步嗅探（§2.2：不抛异常；命中 ProbeResult，否则 null）。
   * 强特征：前 4KiB 内存在步进 188/192 的 ≥3 个连续 0x47；
   * 弱特征：仅首字节 0x47（低置信度，交注册表比拼）。
   */
  static probe(bytes) {
    try {
      if (!bytes || bytes.byteLength < 8) return null;
      const limit = Math.min(bytes.byteLength, 4096);
      for (const stride of [188, 192]) {
        for (let i = 0; i < limit; i++) {
          if (bytes[i] !== SYNC_BYTE_LOCAL) continue;
          let hits = 0;
          for (let k = i; k + stride < limit; k += stride) {
            if (bytes[k] !== SYNC_BYTE_LOCAL) break;
            hits++;
            if (hits >= 3) return createProbeResult(0.92, 'ts');
          }
        }
      }
      if (bytes[0] === SYNC_BYTE_LOCAL) return createProbeResult(0.55, 'ts');
      return null;
    } catch {
      return null;
    }
  }

  /**
   * @param {DataSource|ChunkSource|Uint8Array|ArrayBuffer|Blob|File|null} source
   *   缺省/null 时以空内存源占位（纯引擎或旧式 push 用法，构造不抛错）。
   * @param {{initTimeoutMs?: number, liveLatencyUs?: number, lazySamples?: number,
   *          engineOptions?: {maxPesBufferBytes?: number}}} [options]
   */
  constructor(source, options = {}) {
    super(TsDemuxer._normalizeSource(source), options);
    this.engine = new TsStreamEngine(options.engineOptions);

    /** @type {Map<number, object[]>} 每轨待取样本队列（契约形状） */
    this._queues = new Map();
    /** @type {Map<number, number>} 轨内样本序号 */
    this._indexes = new Map();
    /** @type {Set<() => void>} 等待新数据的 resolver */
    this._waiters = new Set();
    /** @type {boolean} 引擎已冲刷（EOS） */
    this._eos = false;
    /** @type {'datasource'|'chunk'} */
    this._mode = 'datasource';
    /** @type {number} DataSource 顺序泵当前位置 */
    this._pos = 0;
    /** @type {boolean} 泵是否已读到 EOF */
    this._sourceEof = false;
    /** @type {Promise<void>|null} 单飞泵互斥 */
    this._pumping = null;
    /* ---- 直播推送模式（start()+'sample'，§2.2 可选入口） ---- */
    this._pushStarted = false;
    /** @type {Promise<void>[]} */
    this._pushTasks = [];
    /** @type {object|null} 引擎 metadata 缓存（时长回填用） */
    this._lastEngineMeta = null;

    this._wireEngine();
    this._attachChunkSource();
  }

  /* ------------------------------ 数据源接入 ------------------------------ */

  /** 归一化：裸字节/File→对应 DataSource；null→空内存源；ChunkSource 原样透传 */
  static _normalizeSource(source) {
    if (source == null) return new MemoryDataSource(new Uint8Array(0));
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
      return new MemoryDataSource(source);
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return new BlobDataSource(source);
    }
    if (typeof source?.read === 'function' || typeof source?.write === 'function') {
      return source;
    }
    throw stateError('TsDemuxer: 无法识别的数据源（需要 DataSource/ChunkSource/Uint8Array/File）');
  }

  /** ChunkSource 模式：接管 write/end 把字节导入引擎 */
  _attachChunkSource() {
    const src = /** @type {any} */ (this.source);
    if (typeof src?.write !== 'function') return;
    this._mode = 'chunk';
    const self = this;
    src.write = function patchedWrite(chunk) {
      self._feed(self.engine.push.bind(self.engine), chunk);
    };
    src.end = function patchedEnd(err) {
      if (err) self.emit('error', err);
      self._markEos();
    };
  }

  /** 统一喂入入口：异常转 error 事件（解析循环不被打断） */
  _feed(fn, chunk) {
    try {
      fn(chunk);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _wireEngine() {
    const engine = this.engine;
    engine.on('tracks', () => {
      this._syncQueues();
      this._refreshMediaInfoTracks();
      this._resolveWaiters();
    });
    engine.on('sample', (s) => {
      this._enqueue(s);
    });
    engine.on('metadata', (m) => {
      this._lastEngineMeta = m;
      this._applyDurationMeta();
      this._resolveWaiters();
    });
    engine.on('warn', (err) => {
      // 可恢复异常按契约归 warn 级：只发事件不打断管线
      this.emit('progress', { warning: err.message });
    });
    engine.on('error', (err) => {
      this.emit('error', err);
    });
    engine.on('complete', () => {
      this._resolveWaiters();
    });
  }

  /** 引擎轨道出现/更新时补建队列 */
  _syncQueues() {
    for (const t of this.engine.tracks) {
      if (!this._queues.has(t.id)) this._queues.set(t.id, []);
    }
  }

  /** 引擎样本（µs）入队并唤醒等待方 */
  _enqueue(s) {
    this._syncQueues();
    const q = this._queues.get(s.trackId);
    if (!q) return;
    const track = this._contractTrack(s.trackId);
    const idx = this._indexes.get(s.trackId) ?? 0;
    this._indexes.set(s.trackId, idx + 1);
    q.push(createSample({
      trackId: s.trackId,
      codec: track?.codec ?? '',
      timestamp: s.pts,
      duration: s.duration ?? 0,
      data: s.data,
      keyframe: !!s.keyframe,
      dts: s.dts,
      size: s.data.byteLength,
      index: idx,
    }));
    this._resolveWaiters();
  }

  /** 把引擎内部轨道映射刷新进 MediaInfo（open 前调用安全） */
  _refreshMediaInfoTracks() {
    if (!this.mediaInfoValue) return;
    this.mediaInfoValue.tracks = this.engine.tracks.map((t) => this._toContractTrack(t));
  }

  /** @returns {object|null} 契约 Track（缓存于 MediaInfo） */
  _contractTrack(trackId) {
    return this.mediaInfoValue?.tracks.find((t) => t.id === trackId) ?? null;
  }

  /**
   * 引擎内部轨道 → 契约 Track（§1.2）。
   * @param {object} t 引擎内部轨道
   * @param {{allowFallback?: boolean}} [opts] open 完成时允许家族降级串（§3：禁止编造 profile）
   */
  _toContractTrack(t, opts = {}) {
    const isAudio = t.type === 'audio';
    let codec = '';
    if (t.codec === 'h264') {
      codec = t.config ? buildAvcCodecString(t.config)
        : (opts.allowFallback ? fallbackCodecString('avc') : '');
    } else if (t.codec === 'hevc') {
      codec = t.config ? buildHevcCodecString(t.config)
        : (opts.allowFallback ? fallbackCodecString('hevc') : '');
    } else if (t.codec === 'aac') {
      // ADTS/LATM 均能取得真实 ASC；缺失时同样按契约降级
      codec = t.config ? aacCodecStringFromAsc(t.config)
        : (opts.allowFallback ? fallbackCodecString('aac') : '');
    }
    return createTrack({
      id: t.id,
      type: isAudio ? 'audio' : 'video',
      codec,
      description: t.config ?? null,
      bitstreamFormat: isAudio ? undefined : 'annexb',
      timescale: t.timescale,
      language: 'und',
      ...(isAudio
        ? { sampleRate: t.sampleRate, numberOfChannels: t.channelCount }
        : { width: t.width, height: t.height }),
    });
  }

  /** 把引擎估算时长写入给定 MediaInfo 形状；有值返回 true */
  _applyDurationInto(info) {
    const m = this._lastEngineMeta;
    if (!m || m.durationMs == null) return false;
    info.durationUs = Math.round(m.durationMs * 1000);
    for (const st of this.engine.trackState.values()) {
      if (st.firstDts != null && st.lastDtsRaw != null && st.lastDtsRaw > st.firstDts) {
        const t = info.tracks.find((x) => x.id === st.track.id);
        if (t) t.durationUs = Math.round(((st.lastDtsRaw - st.firstDts) / VIDEO_TIMESCALE_TS) * 1e6);
      }
    }
    return true;
  }

  /** 把引擎估算时长回填进已就位的 MediaInfo（流式场景事件到达时） */
  _applyDurationMeta() {
    const m = this._lastEngineMeta;
    if (!m || m.durationMs == null || !this.mediaInfoValue) return;
    this.mediaInfoValue.durationUs = Math.round(m.durationMs * 1000);
    for (const st of this.engine.trackState.values()) {
      if (st.firstDts != null && st.lastDtsRaw != null && st.lastDtsRaw > st.firstDts) {
        const t = this.mediaInfoValue.tracks.find((x) => x.id === st.track.id);
        if (t) t.durationUs = Math.round(((st.lastDtsRaw - st.firstDts) / VIDEO_TIMESCALE_TS) * 1e6);
      }
    }
  }

  /* ------------------------------ 打开 ------------------------------ */

  /**
   * 解析初始化段：驱动数据源直到 PAT/PMT 产出轨道，或流式等待。
   * @returns {Promise<object>} MediaInfo
   */
  async _doOpen() {
    const info = {
      container: 'ts',
      tracks: [],
      durationUs: null,       // TS 无容器级时长声明；EOS 后以时间跨度回填
      seekable: false,        // 无索引容器（§2.2）
      live: false,
      metadata: undefined,
    };

    if (this._mode === 'chunk') {
      await this._waitForTracks();
      info.tracks = this.engine.tracks.map((t) => this._toContractTrack(t, { allowFallback: true }));
      return info;
    }

    // DataSource 模式：泵到「有轨道且视频参数集到位」或 EOF。
    while (!this._openReady() && !this._sourceEof) {
      const progressed = await this._pumpOnce();
      if (!progressed) break;
    }
    if (this.engine.tracks.length === 0 && !this._psiSeen()) {
      if (this._sourceEof) {
        throw parseError('TS：数据先于任何 PAT/PMT 结束，未能识别出轨道');
      }
      await this._waitForTracks();     // 无进展但也没 EOF：等基类超时兜底
    }
    // 全损信息保留：即便没有受支持轨道，只要 PSI 解析过就以空轨成功打开
    info.tracks = this.engine.tracks.map((t) => this._toContractTrack(t, { allowFallback: true }));
    if (this._mode === 'datasource' && this._sourceEof && this._applyDurationInto(info)) {
      return info;
    }
    this._applyDurationMeta();
    return info;
  }

  /** open 完成条件：有轨道，且视频轨参数集已捕获（codec string 可生成） */
  _openReady() {
    const tracks = this.engine.tracks;
    if (tracks.length === 0) return false;
    return !tracks.some((t) => t.type === 'video' && !t.config);
  }

  /** 是否解析出过任意 PSI（PAT/PMT） */
  _psiSeen() {
    return this.engine.pmtVersions.size > 0 || this.engine.programNumber != null;
  }

  _waitForTracks() {
    if (this.engine.tracks.length > 0 || this.engine.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const offs = [
        this.engine.once('tracks', resolve),
        this.engine.once('complete', resolve),
      ];
      void offs;
    });
  }

  /* ------------------------------ 顺序泵（DataSource 模式） ------------------------------ */

  async _pumpOnce() {
    const src = /** @type {any} */ (this.source);
    if (this._sourceEof) return false;
    let want = PUMP_CHUNK;
    if (src.size != null && src.size !== Infinity) {
      want = Math.min(want, src.size - this._pos);
      if (want <= 0) {
        this._finishSource();
        return false;
      }
    }
    let data;
    try {
      data = await src.read(this._pos, want);
    } catch {
      this._finishSource();
      return false;
    }
    if (!data || data.length === 0) {
      this._finishSource();
      return false;
    }
    this._pos += data.length;
    this.emit('progress', { loadedBytes: this._pos, totalBytes: src.size ?? null });
    this._feed(this.engine.push.bind(this.engine), data);
    if (src.size != null && src.size !== Infinity && this._pos >= src.size) this._finishSource();
    else if (data.length < want) this._finishSource();
    return true;
  }

  _finishSource() {
    if (this._sourceEof) return;
    this._sourceEof = true;
    this._eos = true;
    if (!this.engine.complete) this.engine.flush();
    this._resolveWaiters();
  }

  /* ------------------------------ 样本迭代 ------------------------------ */

  async *_createTrackIterator(trackId) {
    this._syncQueues();
    while (true) {
      const q = this._queues.get(trackId);
      if (q && q.length > 0) {
        const smp = q.shift();
        // codec 串在产出时解析（序列头可能晚于样本入队到达）
        const t = this._contractTrack(trackId);
        if (t && smp.codec !== t.codec) smp.codec = t.codec;
        yield smp;
        continue;
      }
      // 本轨已空且源已尽 → 该轨 EOS（按轨独立，互不阻塞）
      if (this._eos) {
        const remain = this._queues.get(trackId);
        if (!remain || remain.length === 0) return;
      }
      if (this._mode === 'datasource' && !this._sourceEof) {
        await this._pumpOnce();
        continue;
      }
      await new Promise((resolve) => this._waiters.add(resolve));
    }
  }

  _resolveWaiters() {
    const waiters = [...this._waiters];
    this._waiters.clear();
    for (const w of waiters) w();
  }

  _markEos() {
    if (!this.engine.complete) this.engine.flush();
    this._eos = true;
    this._resolveWaiters();
  }

  /* ------------------------------ 旧式 push/flush 兼容通道（§2.4 迁移期） ------------------------------ */

  /**
   * 兼容通道：直接向内部引擎喂字节。idle 态首次调用将触发 fire-and-forget 的 open()，
   * 之后照常经 readSample/samples/start() 消费。
   * @param {Uint8Array|ArrayBuffer} chunk
   */
  push(chunk) {
    if (this.stateValue === DEMUXER_STATES.IDLE) {
      this.open().catch(() => {});          // 失败经 'error' 事件上报
    }
    this._feed(this.engine.push.bind(this.engine), chunk);
  }

  /** 兼容通道：标记流结束并冲刷引擎 */
  flush() {
    this._markEos();
  }

  /* ------------------------------ 直播推送模式 ------------------------------ */

  /**
   * 直播推送模式入口（§2.2【可选】）：start 后自动逐轨消费，
   * 样本经基类 readSample 通道以 'sample' 事件 {trackId,sample} 吐出；
   * pause() 暂停吐包（缓冲继续累积），resume() 恢复；destroy() 终止。
   */
  start() {
    if (this._pushStarted || !this._usable) return;
    this._pushStarted = true;
    for (const id of this.trackIds()) {
      const task = (async () => {
        try {
          for (;;) {
            if (!this._pushStarted) return;
            if (this.pausedFlag) {
              await new Promise((r) => setTimeout(r, 25));
              continue;
            }
            const s = await this.readSample(id);
            if (s === null) return;           // 该轨 EOS
          }
        } catch (err) {
          if (this.stateValue !== DEMUXER_STATES.DESTROYED) this.emit('error', err);
        }
      })();
      this._pushTasks.push(task);
    }
  }

  /* ------------------------------ 轨道与元数据 ------------------------------ */

  async _doSeek(_timestampUs) {
    throw seekUnsupportedTs('TS 为无索引容器，不支持 seek');
  }

  getBufferedRanges(_trackId) {
    return [];
  }

  /* ------------------------------ 生命周期扩展 ------------------------------ */

  /**
   * @deprecated 契约定稿名为 open()（§2.4 过渡别名，M2 接入波次后删除）。
   */
  parseInit() {
    return this.open();
  }

  /** 销毁：终止推送循环、拆除引擎监听；幂等由基类保证 */
  async destroy() {
    this._pushStarted = false;
    this.engine.removeAllListeners();
    this._resolveWaiters();
    await super.destroy();
  }
}

const VIDEO_TIMESCALE_TS = 90000;

/**
 * 工厂（契约 §10）：接受 url|Uint8Array|ArrayBuffer|File|Blob|DataSource|ChunkSource，
 * 内部完成构造+attach+open，返回已 ready 的 TsDemuxer；识别失败 reject PROBE_FAILED。
 * @param {any} source
 * @param {{initTimeoutMs?: number}} [options]
 */
export async function createTsDemuxer(source, options = {}) {
  let normalized = source;
  if (typeof source === 'string' || source instanceof URL) {
    const resp = await fetch(String(source));
    if (!resp.ok) {
      throw probeFailed(`TS：无法获取 ${source}（HTTP ${resp.status}）`);
    }
    normalized = new Uint8Array(await resp.arrayBuffer());
  }
  const bytesForProbe = await sniffBytes(normalized);
  if (!TsDemuxer.probe(bytesForProbe)) {
    throw probeFailed('TS：probe 未命中（非 0x47 同步特征的 MPEG-TS 流）');
  }
  const demuxer = new TsDemuxer(normalized, options);
  await demuxer.open();
  return demuxer;
}

/** 从各类源取出嗅探所需的前若干字节 */
async function sniffBytes(src) {
  if (src instanceof Uint8Array) return src.subarray(0, 4096);
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0, 4096));
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return new Uint8Array(await src.slice(0, 4096).arrayBuffer());
  }
  if (typeof src?.read === 'function') {
    const ds = asDataSource(src);
    return ds.read(0, Math.min(4096, ds.size ?? 4096));
  }
  return new Uint8Array(0);
}
