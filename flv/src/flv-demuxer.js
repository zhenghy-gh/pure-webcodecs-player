/**
 * FlvDemuxer —— FLV 解复用器（CONTRACTS v0.2 契约适配壳 / 薄播放壳）
 *
 * 定位（【裁决-hls-flv重定位】）：FLV 解析地基 + 薄播放壳。解析器是 rtmp/
 * WebSocket-FLV 桥接（§9.4）的必选依赖；remux 能力保留服务 HTTP-FLV 播放壳。
 * 生产场景请使用 flv.js（见模块 README 声明）。
 *
 * 公开面（冻结 §12.3）：probe/open/readSample/samples/seek/pause/resume/destroy
 *   + mediaInfo/tracks/metadata 属性。内部实现为 push/flush 流式引擎（./flv-parser.js）。
 *
 * 契约要点：
 *   - 时间基：FLV 毫秒 → 整数微秒（×1000，精确，§0.5）；
 *   - Track.description = avcC/hvcC/ASC；视频 bitstreamFormat='avc'（AVCC 原样输出，
 *     含 CodecID=12 HEVC 与 Enhanced-FLV FourCC，§2.5）；
 *   - codec string 一律经 core/src/codec-string.js 生成（§3）；
 *   - seek：DataSource 模式基于线性解析期建立的关键帧索引；ChunkSource 流式不可回退 → SEEK_UNSUPPORTED。
 */

import {
  Demuxer,
  MemoryDataSource,
  BlobDataSource,
  createProbeResult,
  createTrack,
  createSample,
  buildAvcCodecString,
  buildHevcCodecString,
  aacCodecStringFromAsc,
} from '../../core/src/index.js';
import { parseError, probeFailed, seekUnsupported, stateError } from '../../core/src/errors.js';
import { FlvParser } from './flv-parser.js';
import { parseAvcConfig, parseHevcConfig, parseAscInfo } from './codec-info.js';

const PUMP_CHUNK = 64 * 1024;
export const VIDEO_TRACK_ID = 1;
export const AUDIO_TRACK_ID = 2;
const VIDEO_ID = VIDEO_TRACK_ID;
const AUDIO_ID = AUDIO_TRACK_ID;

export class FlvDemuxer extends Demuxer {
  static containerName = 'flv';

  /** 同步嗅探：'FLV' 魔数（不抛异常；命中 ProbeResult，否则 null） */
  static probe(bytes) {
    try {
      if (!bytes || bytes.byteLength < 3) return null;
      if (bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56) {
        return createProbeResult(0.95, 'flv');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * @param {DataSource|ChunkSource|Uint8Array|ArrayBuffer|Blob|File} source
   * @param {{initTimeoutMs?: number, liveLatencyUs?: number, lazySamples?: boolean}} [options]
   */
  constructor(source, options = {}) {
    // source 缺省容忍：以空内存源占位（纯引擎/旧式 push 用法）
    super(FlvDemuxer._normalizeSource(source ?? new Uint8Array(0)), options);
    this.parser = new FlvParser();

    /** @type {Map<number, object[]>} 每轨待取样本队列 */
    this._queues = new Map();
    /** @type {Set<() => void>} 等待新数据的 resolver */
    this._waiters = new Set();
    this._eos = false;
    /** @type {'datasource'|'chunk'} */
    this._mode = 'datasource';
    this._pos = 0;
    this._sourceEof = false;

    /* ---- 轨道构建状态（来自序列头） ---- */
    this._videoState = null;   // {codecFamily, config(avcC/hvcC), width, height, codecString}
    this._audioState = null;   // {config(ASC), sampleRate, channels, codecString}
    this._audioSeen = false;   // 出现过音频 Tag 但序列头未到
    this._fileMeta = null;     // onMetaData 对象
    this._durationUs = null;
    /** seek 代际号：使在途泵结果过期 */
    this._seekGeneration = 0;
    /* ---- 直播推送模式（start()+'sample'，§2.2 可选入口） ---- */
    this._pushStarted = false;
    /** @type {Promise<void>[]} */
    this._pushTasks = [];

    this._wireEngine();
    this._attachChunkSource();
  }

  /* ------------------------------ 数据源接入 ------------------------------ */

  static _normalizeSource(source) {
    if (source == null) return new MemoryDataSource(new Uint8Array(0));
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) return new MemoryDataSource(source);
    if (typeof Blob !== 'undefined' && source instanceof Blob) return new BlobDataSource(source);
    if (typeof source?.read === 'function' || typeof source?.write === 'function') return source;
    throw stateError('FlvDemuxer: 无法识别的数据源（需要 DataSource/ChunkSource/Uint8Array/File）');
  }

  _attachChunkSource() {
    const src = /** @type {any} */ (this.source);
    if (typeof src?.write !== 'function') return;
    this._mode = 'chunk';
    const self = this;
    src.write = function patchedWrite(chunk) { self._feedParser(chunk); };
    src.end = function patchedEnd(err) {
      if (err) self.emit('error', err);
      self._markEos();
    };
  }

  _feedParser(chunk) {
    try {
      // ChunkSource 场景无随机偏移语义；baseOffset 仅 DataSource 泵路径维护
      this.parser.push(chunk);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _wireEngine() {
    const p = this.parser;
    p.on('header', () => this._syncQueues());
    p.on('metadata', (obj) => {
      this._fileMeta = obj;
      if (typeof obj?.duration === 'number' && Number.isFinite(obj.duration)) {
        this._durationUs = Math.round(obj.duration * 1_000_000);
        if (this.mediaInfoValue) {
          this.mediaInfoValue.durationUs = this._durationUs;
          this.mediaInfoValue.seekable = this._canSeek();
        }
      }
      this._refreshMediaInfoTracks();
      this._resolveWaiters();
    });
    p.on('audio', (e) => { this._audioSeen = true; this._onAudioEvent(e); });
    p.on('video', (e) => this._onVideoEvent(e));
    p.on('error', (err) => this.emit('error', err));
    p.on('complete', () => this._resolveWaiters());
  }

  /* ------------------------------ 引擎事件 → 样本 ------------------------------ */

  _onVideoEvent(evt) {
    if (evt.packetType === 'config') {
      try {
        if (evt.codecFamily === 'avc') {
          const info = parseAvcConfig(evt.configBytes);
          this._videoState = {
            codecFamily: 'avc', config: evt.configBytes,
            width: info.width, height: info.height,
            codecString: buildAvcCodecString(evt.configBytes),
          };
        } else if (evt.codecFamily === 'hevc') {
          const info = parseHevcConfig(evt.configBytes);
          this._videoState = {
            codecFamily: 'hevc', config: evt.configBytes,
            width: info.width, height: info.height,
            codecString: buildHevcCodecString(evt.configBytes),
          };
        } else {
          // av01/vp09：配置透传；codec string 留空（禁止编造 profile，README 说明）
          this._videoState = {
            codecFamily: evt.codecFamily, config: evt.configBytes,
            width: null, height: null, codecString: '',
          };
        }
        this._syncQueues();
        this._refreshMediaInfoTracks();
      } catch (err) {
        this.emit('error', err);
      }
      return;
    }
    if (evt.packetType !== 'coded' || !evt.data) return;
    if (!this._videoState) {
      // 序列头缺失容错：按帧数据推断家族（信息不完整将体现在轨道上）
      this._videoState = { codecFamily: evt.codecFamily, config: null, width: null, height: null, codecString: '' };
      this.emit('error', new Error('FLV: 未收到视频序列头即出现帧数据，轨道信息不完整'));
    }
    const st = this._videoState;
    this._syncQueues();
    const q = this._ensureQueue(VIDEO_ID);
    const dtsMs = evt.timestamp;
    const ctsMs = evt.ctsMs ?? 0;
    const dtsUs = dtsMs * 1000;                       // 毫秒 → 微秒（精确）
    const ptsUs = dtsUs + ctsMs * 1000;
    q.push(createSample({
      trackId: VIDEO_ID,
      codec: st.codecString ?? '',
      timestamp: ptsUs,
      duration: 0,                                    // 视频时长未知填 0（§1.1）
      data: evt.data,                                 // AVCC 形态原样输出
      keyframe: !!evt.keyframe,
      dts: dtsUs,
      size: evt.data.byteLength,
      index: q._counter++,
    }));
    this._resolveWaiters();
  }

  _onAudioEvent(evt) {
    if (evt.packetType === 'config') {
      try {
        const info = parseAscInfo(evt.asc);
        this._audioState = {
          config: evt.asc,
          sampleRate: info.sampleRate,
          channels: info.channels,
          codecString: aacCodecStringFromAsc(evt.asc),
        };
        this._syncQueues();
        this._refreshMediaInfoTracks();
      } catch (err) {
        this.emit('error', err);
      }
      return;
    }
    if (!evt.data) return;
    if (!this._audioState && evt.soundFormat === 'aac') {
      this.emit('error', new Error('FLV: 未收到 AAC 序列头即出现音频帧'));
    }
    const st = this._audioState;
    const isAac = !!st && st.codecString.startsWith('mp4a');
    const sr = st?.sampleRate ?? evt.hint?.legacyRate ?? 44100;
    this._syncQueues();
    const q = this._ensureQueue(AUDIO_ID);
    const tsUs = evt.timestamp * 1000;
    q.push(createSample({
      trackId: AUDIO_ID,
      codec: isAac ? `mp4a.40.${(st.config[0] >> 3) & 0x1f}` : (st ? st.codecString : ''),
      timestamp: tsUs,
      duration: isAac ? Math.round((1024 * 1_000_000) / sr) : 0,
      data: evt.data,
      keyframe: true,
      dts: tsUs,
      size: evt.data.byteLength,
      index: q._counter++,
    }));
    this._resolveWaiters();
  }

  _ensureQueue(trackId) {
    let q = this._queues.get(trackId);
    if (!q) {
      q = [];
      q._counter = 0;
      this._queues.set(trackId, q);
    }
    return q;
  }

  _syncQueues() {
    if (this._videoState) this._ensureQueue(VIDEO_ID);
    if (this._audioState || this._audioSeen) this._ensureQueue(AUDIO_ID);
  }

  /* ------------------------------ 契约轨道 ------------------------------ */

  _buildContractTracks() {
    const tracks = [];
    const v = this._videoState;
    if (v) {
      tracks.push(createTrack({
        id: VIDEO_ID,
        type: 'video',
        codec: v.codecString ?? '',
        description: v.config ?? null,
        bitstreamFormat: v.config ? 'avc' : undefined,   // AVCC/HVCC 长度前缀形态
        timescale: 1000,                        // 诊断：FLV 原生毫秒域
        language: 'und',
        width: v.width ?? undefined,
        height: v.height ?? undefined,
        durationUs: this._durationUs ?? undefined,
      }));
    }
    const a = this._audioState;
    if (a) {
      tracks.push(createTrack({
        id: AUDIO_ID,
        type: 'audio',
        codec: a.codecString,
        description: a.config ?? null,
        timescale: a.sampleRate,
        language: 'und',
        sampleRate: a.sampleRate,
        numberOfChannels: a.channels,
        durationUs: this._durationUs ?? undefined,
      }));
    }
    return tracks;
  }

  _refreshMediaInfoTracks() {
    if (!this.mediaInfoValue) return;
    this.mediaInfoValue.tracks = this._buildContractTracks();
  }

  /* ------------------------------ 打开 ------------------------------ */

  async _doOpen() {
    const info = {
      container: 'flv',
      tracks: [],
      durationUs: null,
      seekable: false,
      live: false,
      metadata: this._stringMetadata(),
    };

    if (this._mode === 'chunk') {
      await this._waitForTracksOrEos();
      info.tracks = this._buildContractTracks();
      info.seekable = false;                    // 流式不可回退
      return info;
    }

    while (!this._hasOpenSignals() && !this._sourceEof) {
      const progressed = await this._pumpOnce();
      if (!progressed) break;
    }
    if (!this._hasOpenSignals()) {
      if (this._sourceEof) {
        throw parseError('FLV：文件先于任何可用轨道信息结束');
      }
      await this._waitForTracksOrEos();
    }
    info.tracks = this._buildContractTracks();
    info.durationUs = this._durationUs;
    info.seekable = this._canSeek();
    info.metadata = this._stringMetadata();
    return info;
  }

  /** open 所需的最小信号：任一轨道配置就绪 */
  _hasOpenSignals() {
    return !!(this._videoState?.config || this._audioState?.config);
  }

  _waitForTracksOrEos() {
    if (this._hasOpenSignals() || this._sourceEof) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = (() => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          this.parser.off('audio', onAudio);
          this.parser.off('video', onVideo);
          this.parser.off('complete', onComplete);
        };
      })();
      const onAudio = () => { cleanup(); resolve(); };
      const onVideo = () => { cleanup(); resolve(); };
      const onComplete = () => { cleanup(); resolve(); };
      this.parser.once('audio', onAudio);
      this.parser.once('video', onVideo);
      this.parser.once('complete', onComplete);
    });
  }

  _stringMetadata() {
    const m = this._fileMeta;
    if (!m) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'string') out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
    const gen = this._seekGeneration;
    let data;
    try {
      data = await src.read(this._pos, want);
    } catch {
      this._finishSource();
      return false;
    }
    if (gen !== this._seekGeneration) return true;   // seek 期间过期的读取：丢弃
    if (!data || data.length === 0) {
      this._finishSource();
      return false;
    }
    this._pos += data.length;
    this.emit('progress', { loadedBytes: this._pos, totalBytes: src.size ?? null });
    try {
      this.parser.baseOffset = this._pos - data.length;
      this.parser.push(data);
    } catch (err) {
      this.emit('error', err);
    }
    if (src.size != null && src.size !== Infinity && this._pos >= src.size) this._finishSource();
    else if (data.length < want) this._finishSource();
    return true;
  }

  _finishSource() {
    if (this._sourceEof) return;
    this._sourceEof = true;
    this._eos = true;
    if (!this.parser._finished) this.parser.flush();
    this._maybeUpdateSeekable();
    this._resolveWaiters();
  }

  /** 可 seek 判定：DataSource 模式 + 有视频关键帧索引 */
  _canSeek() {
    return this._mode === 'datasource' && this._videoState != null && this.parser.keyframeIndex.length > 0;
  }

  _maybeUpdateSeekable() {
    if (this.mediaInfoValue) this.mediaInfoValue.seekable = this._canSeek();
  }

  /* ------------------------------ 迭代与 EOS ------------------------------ */

  async *_createTrackIterator(trackId) {
    this._syncQueues();
    while (true) {
      const q = this._queues.get(trackId);
      if (q && q.length > 0) {
        yield q.shift();
        continue;
      }
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
    if (!this.parser._finished) this.parser.flush();
    this._eos = true;
    this._resolveWaiters();
  }

  /* ------------------------------ seek ------------------------------ */

  /**
   * 关键帧对齐 seek：取 ≤timestampUs 的最近索引点，重置引擎后从该字节偏移继续。
   * @param {number} timestampUs 整数微秒
   */
  async _doSeek(timestampUs) {
    if (this._mode !== 'datasource') {
      throw seekUnsupported('FLV 流式源（ChunkSource）不支持回退 seek');
    }
    const index = this.parser.keyframeIndex;
    if (!index || index.length === 0) {
      throw seekUnsupported('FLV: 尚未建立关键帧索引（无视频轨或未解析到关键帧）');
    }
    let target = index[0];
    for (const entry of index) {
      if (entry.timestampMs * 1000 <= timestampUs) target = entry;
      else break;
    }
    const actualUs = Math.round(target.timestampMs) * 1000;

    // 使在途读取过期 + 复位迭代上下文（基类 seek 已先清空迭代器）
    this._seekGeneration++;
    this.parser.prepareSeekResume({
      hasAudio: this.parser.hasAudio,
      hasVideo: this.parser.hasVideo,
    });
    for (const q of this._queues.values()) q.length = 0;
    this._pos = target.offset;
    this._sourceEof = false;
    this._eos = false;

    // 预泵一块让后续 readSample 立刻有数据
    await this._pumpOnce();
    return { actualTimestampUs: actualUs };
  }

  getBufferedRanges(trackId) {
    void trackId;
    if (!this.mediaInfoValue?.seekable) return [];
    const dur = this.mediaInfoValue.durationUs;
    if (dur == null) return [];
    return [{ startUs: 0, endUs: dur }];
  }

  /* ------------------------------ 生命周期扩展 ------------------------------ */

  /* ---- 旧式 push/flush 兼容通道（§2.4 迁移期） ---- */

  /** 兼容通道：直接向内部引擎喂字节（idle 态首次调用触发 open()） */
  push(chunk) {
    if (this.stateValue === 'idle') {
      this.open().catch(() => {});
    }
    try {
      this.parser.push(chunk);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** 兼容通道：标记流结束并冲刷引擎 */
  flush() {
    this._markEos();
  }

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
          if (this.stateValue !== 'destroyed') this.emit('error', err);
        }
      })();
      this._pushTasks.push(task);
    }
  }

  /**
   * @deprecated 契约定稿名为 open()（§2.4 过渡别名，M2 接入波次后删除）。
   */
  parseInit() {
    return this.open();
  }

  async destroy() {
    this._pushStarted = false;
    this.parser.removeAllListeners();
    this._resolveWaiters();
    await super.destroy();
  }
}

/**
 * 工厂（契约 §10）：接受 url|Uint8Array|ArrayBuffer|File|Blob|DataSource|ChunkSource，
 * 内部完成构造+attach+open；识别失败 reject PlayerError('PROBE_FAILED')。
 * @param {any} source
 * @param {{initTimeoutMs?: number}} [options]
 */
export async function createFlvDemuxer(source, options = {}) {
  let normalized = source;
  if (typeof source === 'string' || source instanceof URL) {
    // HTTP-FLV 直播流建议显式构造 ChunkSource + new FlvDemuxer；
    // 此处工厂对 URL 走 fetch 全量缓冲（点播文件场景）。
    let resp;
    try {
      resp = await fetch(String(source));
    } catch (err) {
      throw probeFailed(`FLV：无法连接 ${source}（${err.message ?? err}）。WebSocket-FLV 直播需网关支持`);
    }
    if (!resp.ok) {
      throw probeFailed(`FLV：无法获取 ${source}（HTTP ${resp.status}）`);
    }
    normalized = new Uint8Array(await resp.arrayBuffer());
  }
  const probeBytes = await sniffBytes(normalized);
  if (!FlvDemuxer.probe(probeBytes)) {
    throw probeFailed('FLV：probe 未命中（缺少 "FLV" 魔数）');
  }
  const demuxer = new FlvDemuxer(normalized, options);
  await demuxer.open();
  return demuxer;
}

async function sniffBytes(src) {
  if (src instanceof Uint8Array) return src.subarray(0, 4096);
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0, 4096));
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return new Uint8Array(await src.slice(0, 4096).arrayBuffer());
  }
  if (typeof src?.read === 'function') {
    return src.read(0, Math.min(4096, src.size ?? 4096));
  }
  return new Uint8Array(0);
}
