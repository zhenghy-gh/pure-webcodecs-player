/**
 * demuxer.js —— Matroska/WebM Demuxer（CONTRACTS v0.2 对齐实现）
 *
 * 公开面逐字对齐 docs/CONTRACTS.md §1/§2/§10：
 *   static probe(bytes) -> ProbeResult|null
 *   new MkvDemuxer(source /* DataSource *​/, options) → await open()
 *   readSample(trackId) / samples(trackId) / seek(timestampUs) / destroy()
 *   mediaInfo / tracks / metadata / getBufferedRanges(trackId)
 *   事件：'media-info' | 'error' | 'end' | 'progress'
 *
 * 说明：
 *   - 叶子件复用 core（PlayerError 十码 / Emitter / codec-string 构造器），
 *     遵守 §3「禁止自行拼串」；
 *   - 继承 core Demuxer 已完成（第二轮 I1 §29）：按《docs/review/mkv-base-class-alignment.md》
 *     **案 C** 落地 `extends Demuxer` + 状态机切 `stateValue`（ts 模块
 *     `TsDemuxer extends Demuxer` 为样板，见 ts/src/ts-demuxer.js:42）；
 *     `readSample/samples/seek` 与守卫、end 判定保留自实现（D3/D4 语义分歧）。
 *     与基类「完全同构」（案 A）属 D1–D12 跨模块统一议题，须 captain 裁决后
 *     收敛——文档明确「不建议跳过 C 直接 A」，禁止单模块擅改。
 *   - `open()` 仍覆写而非走 `_doOpen()` 钩子，系 **D2 裁决「保留模块既有可恢复性」**：
 *     失败回 `idle` 以保留 attach 换源重试路径（基类为 destroyed 终态，会令该路径失效），
 *     且 opening 重入抛 STATE_ERROR 而非共享 promise（D1）。
 *     基类自带的 initTimeoutMs 超时与 `'media-info'`+`'mediaInfo'` 双发已在此等价补齐
 *     （第五十波）。**勿因"看似与基类重复"而删**——删则超时保护与事件面双双回退。
 *   - 轨道排序由本模块自管（`#buildMediaInfo` 内 `TYPE_SORT_ORDER`，:387），与基类
 *     `sortTracks` 等价，非缺失。
 *
 * 解析内核（不变）：EBML 惰性头部扫描 → Segment(Info/Tracks/Cues/Cluster)
 *   → SimpleBlock/BlockGroup → 样本流；未知长度容器边界探测；Cues 定位，
 *   无 Cues 时线性扫簇时间码建索引兜底。
 */

import { Demuxer } from '../../core/src/demuxer.js';
import { PlayerError } from '../../core/src/errors.js';
import { raceAbort, throwIfAborted } from '../../core/src/abort.js';
import {
  readId, readSize, iterElements, decodeValueByType,
} from './ebml.js';
import { ID, SCHEMA, TRACK_TYPE_NAME } from './schema.js';
import { normalizeCodec } from './codecs.js';
import { decodeLacing } from './lacing.js';

const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const TYPE_SORT_ORDER = { video: 0, audio: 1, text: 2, metadata: 3, unknown: 4 };

/**
 * 解析 Block/SimpleBlock 头部：
 *   [轨道号 VINT][相对时间码 int16BE][flags] 后接帧数据。
 */
function parseBlockHeader(data) {
  // 一律抛 PlayerError(PARSE_ERROR)：调用方即使漏包 try 也不会有裸 Error 逃逸（§11.3）
  if (data.length < 4) throw new PlayerError('PARSE_ERROR', '块载荷过短');
  const trackVint = readSize(data, 0, data.length); // 轨道号是带标记位的普通 VINT
  if (!trackVint || trackVint.unknown) throw new PlayerError('PARSE_ERROR', '块轨道号 VINT 非法');
  let p = trackVint.length;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < p + 3) throw new PlayerError('PARSE_ERROR', '块头部不完整');
  const relTimecode = view.getInt16(p, false);
  p += 2;
  const flags = data[p];
  p += 1;
  return {
    trackNumber: trackVint.value,
    relTimecode,
    keyframe: !!(flags & 0x80),
    lacing: (flags >> 1) & 0x03,
    discardable: !!(flags & 0x01),
    bodyStart: p,
  };
}

/** EBML 头魔数（0x1A45DFA3）首 4 字节 */
function looksLikeEbml(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

export class MkvDemuxer extends Demuxer {
  /** 契约 §10：与 containerName 枚举一致的静态字段 */
  static containerName = 'mkv';

  /**
   * 静态嗅探（契约 §2.2：同步、无副作用、不抛异常；不命中返回 null）。
   * @param {Uint8Array} bytes 建议给满 4KiB，至少 4B
   * @returns {{confidence:number, container:string, codecsHint?:string[]}|null}
   */
  static probe(bytes) {
    try {
      if (!bytes || !looksLikeEbml(bytes)) return null;
      // 尝试在给定字节内读出 DocType 以区分 webm/matroska
      let docType = null;
      const rid = readId(bytes, 0, bytes.length);
      if (rid && bytes.length > rid.length) {
        const sizeInfo = readSize(bytes, rid.length, bytes.length);
        if (!sizeInfo.unknown) {
          const bodyEnd = Math.min(
            rid.length + sizeInfo.length + sizeInfo.value,
            bytes.length,
          );
          for (const el of iterElements(bytes, rid.length + sizeInfo.length, bodyEnd, SCHEMA)) {
            if (el.id === ID.DocType) {
              docType = decodeValueByType('s', bytes.subarray(el.contentStart, el.contentEnd));
              break;
            }
          }
        }
      }
      if (docType === 'webm') {
        return { confidence: 0.95, container: 'webm' };
      }
      if (docType === 'matroska') {
        return { confidence: 0.95, container: 'mkv' };
      }
      if (docType === null) return { confidence: 0.85, container: 'mkv' }; // 截断头部保守命中
      return null; // EBML 但 DocType 非 webm/matroska → 明确未命中（§10 口径）
    } catch {
      return null; // 契约要求 probe 永不抛
    }
  }

  /**
   * @param {object} source DataSource（{size|byteLength, read(offset,length), close?}）
   * @param {{lazySamples?:boolean}} [options]
   */
  constructor(source, options = {}) {
    super(source, options);
    if (!source || typeof source.read !== 'function') {
      throw new PlayerError('SOURCE_ERROR', 'MkvDemuxer 需要一个实现 read(offset,length) 的数据源');
    }
    this.options = options;
    /** 规范化 DataSource 形状（契约 §2.1：size 字段；兼容 byteLength 旧名） */
    this.dataSource = {
      get size() { return source.size ?? source.byteLength ?? null; },
      read: (o, l) => source.read(o, l),
      close: () => source.close?.(),
    };
    // 基类生命周期与内部规范化数据源保持同一引用。
    this.source = this.dataSource;

    // ── 解析产物（open 后可用）──
    this.docTypeRaw = null;        // 'webm' | 'matroska'（原始 DocType）
    this.timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;
    this.durationRaw = null; // Duration 原始值（按 TimecodeScale 缩放），待 TimecodeScale 已知后换算
    this.durationUs = null;
    this.title = null;
    this.dateUTCms = null;
    this.muxingApp = null;
    this.writingApp = null;
    /** @type {Array<object>} 内部轨道表（含解析辅助字段） */
    this.trackList = [];
    /** @type {Array<{timeNs:number, clusterOffsetInSegment:number}>} */
    this.cues = [];
    /** 线性扫描积累的簇索引（无 Cues 兜底） */
    this.clusterIndex = [];

    this.segmentDataStart = -1;
    this.segmentDataEnd = Infinity;
    this.firstClusterOffset = -1;
    /** 惰性停止标记（评审 §18.3）：Info/Tracks 已见则首个 Cluster 处终止顶层扫描 */
    this._infoSeen = false;
    this._tracksSeen = false;

    // ── 拉取状态 ──
    /** @type {Map<number, AsyncGenerator>} trackId → 迭代器 */
    this.#trackIterators = new Map();
    /** @type {Set<number>} 已 EOS 的轨道 */
    this.#eosedTracks = new Set();
    /**
     * @type {Map<number, {value:*, done:boolean}>} trackId → 被中断后迟到落地的样本
     * 缓存（与 core 基类 pendingResult 同语义：中断不吞样本，下次续读优先吐出）
     */
    this.#pendingResults = new Map();
    /** 拉取参数（seek 会重置） */
    this.#pullOpts = {};
    /** 轨内样本序号计数 */
    this.#sampleIndexByTrack = new Map();
    this.#endEmitted = false;

    // MediaInfo 缓存（公开访问经 getter 做 STATE 守卫）
    this._mediaInfo = null;
  }

  #trackIterators;
  #eosedTracks;
  #pendingResults;
  #pullOpts;
  #sampleIndexByTrack;
  #endEmitted;

  /** @returns {'idle'|'opening'|'ready'|'destroyed'} */
  get state() { return this.stateValue; }

  // ══════════════════════════════════════════════════════
  // 底层读取原语
  // ══════════════════════════════════════════════════════
  async #readExact(offset, length) {
    const u8 = await this.dataSource.read(offset, length);
    const limit = this.dataSource.size ?? Infinity;
    if (u8.length < length && offset + length <= limit) {
      throw new PlayerError('SOURCE_ERROR', `数据源短读: 需要 ${length} 字节，得到 ${u8.length}`);
    }
    return u8;
  }

  /**
   * 读 offset 处元素头；尾部残缺返回 null（视作流结束）。
   */
  async #peekHeader(offset) {
    const byteLength = this.dataSource.size ?? Infinity;
    if (offset >= byteLength || offset < 0) return null;

    let head = await this.#readExact(offset, Math.min(16, byteLength - offset));
    if (head.length === 0) return null;
    let rid;
    let sizeInfo;
    try {
      rid = readId(head, 0, head.length);
      if (!rid) throw new Error('空 ID');
      const need = rid.length + 8;
      while (head.length < need && (byteLength === Infinity || offset + head.length < byteLength)) {
        const want = Math.min(head.length + 8, byteLength - offset);
        const bigger = await this.#readExact(offset, want);
        if (bigger.length <= head.length) break;
        head = bigger;
      }
      sizeInfo = readSize(head, rid.length, head.length);
    } catch {
      return null;
    }
    const contentStart = offset + rid.length + sizeInfo.length;
    return {
      id: rid.id,
      size: sizeInfo.unknown ? -1 : sizeInfo.value,
      unknown: sizeInfo.unknown,
      contentStart,
      next: sizeInfo.unknown ? -1 : contentStart + sizeInfo.value,
    };
  }

  async #readElementPayload(header) {
    return this.#readExact(header.contentStart, header.size);
  }

  // ══════════════════════════════════════════════════════
  // open()：EBML 头 + Segment 头部扫描 → MediaInfo
  // ══════════════════════════════════════════════════════
  /** 完整 MediaInfo（open 前访问抛 STATE_ERROR） */
  get mediaInfo() {
    this.#assertReady('mediaInfo');
    return this._mediaInfo;
  }

  async open() {
    if (this.stateValue === 'destroyed') {
      throw new PlayerError('STATE_ERROR', 'demuxer 已销毁');
    }
    if (this.stateValue === 'ready') return this._mediaInfo;
    if (this.stateValue === 'opening') {
      throw new PlayerError('STATE_ERROR', 'open() 进行中，禁止重入');
    }
    this.stateValue = 'opening';
    // §2.4：initTimeoutMs 超时 reject TIMEOUT。基类 open() 自带该保护，但本类覆写了
    // open() 自行编排状态机，必须等价补齐——否则慢源/卡死源会让 open() 永久挂起。
    // 注意 mkv 构造函数用原始 options 覆盖了基类默认值，故此处需回落缺省。
    const initTimeoutMs = this.options?.initTimeoutMs ?? 10000;
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new PlayerError('TIMEOUT', `open() timed out after ${initTimeoutMs}ms`));
      }, initTimeoutMs);
      // 不阻塞进程退出
      if (typeof timer?.unref === 'function') timer.unref();
    });
    try {
      await Promise.race([
        (async () => {
          await this.#scanHeaders();
          this._mediaInfo = this.#buildMediaInfo();
        })(),
        guard,
      ]);
      this.stateValue = 'ready';
      // 契约事件名 + 过渡期旧名双发（与 core Demuxer.open() 保持一致）
      this.emit('media-info', this._mediaInfo);
      this.emit('mediaInfo', this._mediaInfo);
      return this._mediaInfo;
    } catch (err) {
      this.stateValue = 'idle';
      const pe = err instanceof PlayerError ? err : new PlayerError('PARSE_ERROR', err?.message ?? String(err));
      this.emit('error', pe);
      throw pe;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── §2.4 迁移期别名（定稿名=open；本组别名接入波次后清理）──
  /** @deprecated 旧名兼容别名，内部转调 open() */
  init() { return this.open(); }
  /** @deprecated 草案名兼容别名，语义合并进 open()（工厂已内置 attach） */
  parseInit() { return this.open(); }

  /**
   * @deprecated 旧形 attach(dataSource)+init 组合的兼容入口。
   * 契约定稿为构造函数直收 source + open()；此处仅转发以兼容旧调用方。
   */
  attach(dataSourceOrSourceLike) {
    if (this.stateValue !== 'idle') {
      throw new PlayerError('STATE_ERROR', 'attach 仅可在 idle 态调用（open 前构造期完成注入）');
    }
    const src = dataSourceOrSourceLike;
    if (!src || typeof src.read !== 'function') {
      throw new PlayerError('SOURCE_ERROR', 'attach 需要实现 read(offset,length) 的数据源');
    }
    const prev = this.dataSource.read;
    void prev;
    this.dataSource = {
      get size() { return src.size ?? src.byteLength ?? null; },
      read: (o, l) => src.read(o, l),
      close: () => src.close?.(),
    };
    return this;
  }

  async #scanHeaders() {
    const hdr = await this.#peekHeader(0);
    if (!hdr || hdr.id !== ID.EBML) {
      throw new PlayerError('PROBE_FAILED', '不是 EBML 文件：缺少 EBML 头（0x1A45DFA3）');
    }
    const ebmlBody = await this.#readElementPayload(hdr);
    for (const el of iterElements(ebmlBody, 0, ebmlBody.length, SCHEMA)) {
      if (el.id === ID.DocType) {
        this.docTypeRaw = decodeValueByType('s', ebmlBody.subarray(el.contentStart, el.contentEnd));
      }
    }

    // 定位 Segment（容忍中间 Void / 未知长度元素）
    let q = hdr.next === -1 ? await this.#probeUnknownMasterEnd(hdr) : hdr.next;
    let segHdr = await this.#peekHeader(q);
    while (segHdr && segHdr.id !== ID.Segment) {
      q = segHdr.next === -1 ? await this.#probeUnknownMasterEnd(segHdr, q) : segHdr.next;
      segHdr = await this.#peekHeader(q);
    }
    if (!segHdr || segHdr.id !== ID.Segment) {
      throw new PlayerError('PARSE_ERROR', '未找到 Segment 元素');
    }
    this.segmentDataStart = segHdr.contentStart;
    this.segmentDataEnd = segHdr.unknown ? Infinity : segHdr.next;

    // 扫描 Segment 直接子元素：只读头；仅 Info/Tracks/SeekHead 读体
    const scanStop = this.segmentDataEnd;
    let p = this.segmentDataStart;
    let cuesOffset = -1;
    let cuesPosFromSeekHead = -1;
    while (p >= 0 && p < scanStop) {
      const h = await this.#peekHeader(p);
      if (!h) break;
      switch (h.id) {
        case ID.Info:
          await this.#parseInfo(h);
          p = h.next;
          break;
        case ID.Tracks:
          await this.#parseTracks(h);
          p = h.next;
          break;
        case ID.SeekHead: {
          const body = await this.#readElementPayload(h);
          cuesPosFromSeekHead = this.#parseSeekHeadForCues(body);
          p = h.next;
          break;
        }
        case ID.Cues:
          if (cuesOffset < 0) cuesOffset = p;
          p = h.unknown ? await this.#probeUnknownMasterEnd(h, p) : h.next;
          break;
        case ID.Cluster:
          if (this.firstClusterOffset < 0) this.firstClusterOffset = p;
          // 惰性停止（评审 §18.3）：Info/Tracks 已见（合规布局均在簇前）即在此终止
          // 顶层扫描。簇之后唯一影响定位的是尾置 Cues —— 推迟到首次 seek 由
          // #ensureSeekIndex 一次性扫描发现（顺带建簇索引），避免 open 对未知尺寸
          // 簇做全量边界探测（流式 webm open 扫完整簇 / 无 Cues 文件双遍历）。
          p = this._infoSeen && this._tracksSeen ? scanStop
            : h.unknown ? await this.#probeUnknownMasterEnd(h, p) : h.next;
          break;
        default:
          p = h.unknown ? await this.#probeUnknownMasterEnd(h, p) : h.next;
          break;
      }
    }

    try {
      if (cuesOffset >= 0) await this.#parseCuesAt(cuesOffset);
      else if (cuesPosFromSeekHead >= 0) await this.#parseCuesAt(this.segmentDataStart + cuesPosFromSeekHead);
    } catch {
      /* Cues 解析失败不致命：seek 时走线性索引兜底 */
    }
  }

  #buildMediaInfo() {
    const container = this.docTypeRaw === 'webm' ? 'webm' : 'mkv';
    const tracks = [...this.trackList]
      .sort((a, b) => (TYPE_SORT_ORDER[a.type] ?? 9) - (TYPE_SORT_ORDER[b.type] ?? 9))
      .map((t) => t.publicView());
    const metadata = {};
    if (this.title != null) metadata.title = String(this.title);
    if (this.dateUTCms != null) metadata.dateUTC = new Date(this.dateUTCms).toISOString();
    if (this.muxingApp != null) metadata.muxingApp = String(this.muxingApp);
    if (this.writingApp != null) metadata.writingApp = String(this.writingApp);
    const anyCluster = this.firstClusterOffset >= 0;
    return {
      container,
      tracks,
      durationUs: this.durationUs,
      seekable: anyCluster,           // 有簇即可定位（无 Cues 可线性建索引）
      live: false,
      metadata,
    };
  }

  // ── Info / Tracks 解析 ────────────────────────────────
  async #parseInfo(hdr) {
    const body = await this.#readElementPayload(hdr);
    for (const el of iterElements(body, 0, body.length, SCHEMA)) {
      const val = () => decodeValueByType(el.type, body.subarray(el.contentStart, el.contentEnd));
      switch (el.id) {
        case ID.TimecodeScale:
          this.timecodeScaleNs = val();
          // Duration 可能先于 TimecodeScale 出现 → 用当前已知 scale 重算已缓存的原始值
          if (this.durationRaw != null) {
            this.durationUs = Math.round((this.durationRaw * this.timecodeScaleNs) / 1000);
          }
          break;
        case ID.Duration:
          // 按 RFC 9559，Duration 以 TimecodeScale 为单位；先存原始值，待 scale 已知后换算，
          // 避免 Duration 早于 TimecodeScale 时误用默认 1e6 scale（#4）。
          this.durationRaw = val();
          this.durationUs = Math.round((this.durationRaw * this.timecodeScaleNs) / 1000);
          break;
        case ID.Title: this.title = val(); break;
        case ID.DateUTC: this.dateUTCms = val(); break;
        case ID.MuxingApp: this.muxingApp = val(); break;
        case ID.WritingApp: this.writingApp = val(); break;
        default: break;
      }
    }
    this._infoSeen = true;
  }

  async #parseTracks(hdr) {
    const body = await this.#readElementPayload(hdr);
    for (const el of iterElements(body, 0, body.length, SCHEMA)) {
      if (el.id !== ID.TrackEntry) continue;
      this.trackList.push(this.#parseTrackEntry(body, el));
    }
    this._tracksSeen = true;
  }

  #parseTrackEntry(body, entryEl) {
    const t = {
      id: 0,
      uid: null,
      type: 'unknown',
      language: 'und',
      name: null,
      flagDefault: true,
      flagLacing: true,
      defaultDurationNs: null,
      codecId: null,
      codecPrivate: null,
      codecDelayNs: 0,
      seekPreRollNs: 0,
      encrypted: false,
      codec: '',
      family: null,
      supported: false,
      codecExtra: {},
      bitstreamFormat: undefined,
      width: null,
      height: null,
      displayWidth: null,
      displayHeight: null,
      frameRate: null,
      sampleRate: null,
      numberOfChannels: null,
      bitDepth: null,
    };
    for (const el of iterElements(body, entryEl.contentStart, entryEl.contentEnd, SCHEMA)) {
      const raw = () => body.subarray(el.contentStart, el.contentEnd);
      const val = () => decodeValueByType(el.type, raw());
      switch (el.id) {
        case ID.TrackNumber: t.id = val(); break;
        case ID.TrackUID: t.uid = val(); break;
        case ID.TrackType: t.type = TRACK_TYPE_NAME[val()] ?? 'unknown'; break;
        case ID.TrackLanguage:
          // LanguageIETF 必须优先于 legacy Language：一旦设过 IETF 就不允许被后续 Language 覆盖
          if (!t._ietfLang) t.language = val();
          break;
        case ID.LanguageIETF:
          t.language = val();
          t._ietfLang = true; // IETF 优先，且不被后续 legacy Language 覆盖
          break;
        case ID.TrackName: t.name = val(); break;
        case ID.FlagDefault: t.flagDefault = !!val(); break;
        case ID.FlagLacing: t.flagLacing = !!val(); break;
        case ID.DefaultDuration: t.defaultDurationNs = val(); break;
        case ID.CodecID: t.codecId = val(); break;
        case ID.CodecPrivate: t.codecPrivate = val().slice(); break;
        case ID.CodecDelay: t.codecDelayNs = val(); break;
        case ID.SeekPreRoll: t.seekPreRollNs = val(); break;
        case ID.ContentEncodings: t.encrypted = true; break; // 本期压缩/加密轨一律不支持
        case ID.Video:
          for (const v of iterElements(body, el.contentStart, el.contentEnd, SCHEMA)) {
            const vv = () => decodeValueByType(v.type, body.subarray(v.contentStart, v.contentEnd));
            if (v.id === ID.PixelWidth) t.width = vv();
            else if (v.id === ID.PixelHeight) t.height = vv();
            else if (v.id === ID.DisplayWidth) t.displayWidth = vv();
            else if (v.id === ID.DisplayHeight) t.displayHeight = vv();
          }
          break;
        case ID.Audio:
          for (const a of iterElements(body, el.contentStart, el.contentEnd, SCHEMA)) {
            const av = () => decodeValueByType(a.type, body.subarray(a.contentStart, a.contentEnd));
            if (a.id === ID.SamplingFrequency) t.sampleRate = av();
            else if (a.id === ID.OutputSamplingFrequency) t.sampleRate = av();
            else if (a.id === ID.Channels) t.numberOfChannels = av();
            else if (a.id === ID.BitDepth) t.bitDepth = av();
          }
          break;
        default: break;
      }
    }
    if (t.defaultDurationNs > 0) t.frameRate = 1e9 / t.defaultDurationNs;

    const norm = normalizeCodec(
      { codecId: t.codecId ?? '', codecPrivate: t.codecPrivate },
      { sampleRate: t.sampleRate, channels: t.numberOfChannels, bitDepth: t.bitDepth },
    );
    t.codec = norm.codec;
    t.family = norm.family;
    t.supported = norm.supported && !t.encrypted;
    t.codecExtra = norm.extra;
    t.bitstreamFormat = norm.bitstreamFormat;

    // 契约 Track 公开视图（description 为定稿名；codecPrivate 过渡别名）
    t.publicView = () => ({
      id: t.id,
      type: t.type,
      codec: t.codec,
      description: t.codecPrivate,          // Uint8Array|null（§1.2 定稿名）
      codecPrivate: t.codecPrivate,         // 过渡别名（E-8 接入波次后移除）
      ...(t.type === 'video' ? {
        width: t.width, height: t.height,
        frameRate: t.frameRate,
        ...(t.displayWidth != null ? { displayWidth: t.displayWidth } : {}),
        ...(t.displayHeight != null ? { displayHeight: t.displayHeight } : {}),
        ...(t.bitstreamFormat ? { bitstreamFormat: t.bitstreamFormat } : {}),
      } : {}),
      ...(t.type === 'audio' ? {
        sampleRate: t.sampleRate, numberOfChannels: t.numberOfChannels,
      } : {}),
      durationUs: this.durationUs ?? undefined,
      timescale: Math.round(1e9 / this.timecodeScaleNs), // 仅诊断（§0.5）
      language: t.language || 'und',
      flagDefault: t.flagDefault,
      encrypted: t.encrypted || undefined,
      supported: t.supported,
      extensions: { mkvCodecId: t.codecId, codecExtra: t.codecExtra }, // Matroska 特有诊断
    });
    return t;
  }

  #parseSeekHeadForCues(body) {
    let cuesPos = -1;
    for (const seek of iterElements(body, 0, body.length, SCHEMA)) {
      if (seek.id !== ID.Seek) continue;
      let targetId = null;
      let pos = null;
      for (const el of iterElements(body, seek.contentStart, seek.contentEnd, SCHEMA)) {
        if (el.id === ID.SeekID) targetId = readId(body, el.contentStart, el.contentEnd)?.id ?? null;
        else if (el.id === ID.SeekPosition) pos = decodeValueByType('u', body.subarray(el.contentStart, el.contentEnd));
      }
      if (targetId === ID.Cues && pos !== null) cuesPos = pos;
    }
    return cuesPos;
  }

  async #parseCuesAt(offset) {
    const h = await this.#peekHeader(offset);
    if (!h || h.id !== ID.Cues) return;
    const end = h.unknown ? await this.#probeUnknownMasterEnd(h, offset) : h.next;
    const body = await this.#readExact(h.contentStart, end - h.contentStart);
    this.cues = [];
    for (const point of iterElements(body, 0, body.length, SCHEMA)) {
      if (point.id !== ID.CuePoint) continue;
      let timeNs = null;
      for (const el of iterElements(body, point.contentStart, point.contentEnd, SCHEMA)) {
        if (el.id === ID.CueTime) {
          // Matroska 规范：CueTime 以 TimecodeScale 为单位（tick），实际纳秒 = CueTime × TimecodeScale。
          // 此前直接把 CueTime 当 ns，导致与 locate() 的 targetNs(=us×1000) 单位错位、
          // 二分命中错误簇（默认 scale=1e6 时偏差 1e6 倍）。
          const cueTimeTicks = decodeValueByType('u', body.subarray(el.contentStart, el.contentEnd));
          timeNs = cueTimeTicks * this.timecodeScaleNs;
        } else if (el.id === ID.CueTrackPositions) {
          // 单个 CuePoint 可含多个 CueTrackPositions（多轨）；按 CueTrack 分别保留，
          // 不可被后者覆盖（#3）。同一 CuePoint 的 timeNs 对所有轨一致。
          let clusterPos = null;
          let track = null;
          for (const tp of iterElements(body, el.contentStart, el.contentEnd, SCHEMA)) {
            if (tp.id === ID.CueClusterPosition) {
              clusterPos = decodeValueByType('u', body.subarray(tp.contentStart, tp.contentEnd));
            } else if (tp.id === ID.CueTrack) {
              track = decodeValueByType('u', body.subarray(tp.contentStart, tp.contentEnd));
            }
          }
          if (timeNs !== null && clusterPos !== null) {
            this.cues.push({ timeNs, clusterOffsetInSegment: clusterPos, track });
          }
        }
      }
    }
    this.cues.sort((a, b) => a.timeNs - b.timeNs);
  }

  // ── 未知长度 Master 边界探测 ──────────────────────────
  async #probeUnknownMasterEnd(hdr) {
    let p = hdr.contentStart;
    const outerLimit = this.segmentDataEnd === Infinity
      ? (this.dataSource.size ?? Infinity)
      : this.segmentDataEnd;
    const isSegmentLevel = hdr.id === ID.Segment;
    while (p >= 0 && p < outerLimit) {
      const h = await this.#peekHeader(p);
      if (!h) break;
      let legal;
      if (isSegmentLevel) {
        legal = SCHEMA.has(h.id);
      } else if (hdr.id === ID.Cluster) {
        legal = h.id === ID.ClusterTimecode || h.id === ID.ClusterPrevSize
          || h.id === ID.SimpleBlock || h.id === ID.BlockGroup
          || h.id === ID.Void || h.id === ID.CRC32;
      } else {
        legal = h.id === ID.Void || h.id === ID.CRC32;
      }
      if (!legal) break;
      p = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
    }
    return p < 0 ? hdr.contentStart : p;
  }

  // ══════════════════════════════════════════════════════
  // 契约属性
  // ══════════════════════════════════════════════════════
  get tracks() {
    this.#assertReady('tracks');
    return this.mediaInfo?.tracks ?? [];
  }

  get metadata() {
    this.#assertReady('metadata');
    const mi = this.mediaInfo;
    return {
      container: mi.container,
      durationUs: mi.durationUs,
      live: mi.live,
      seekable: mi.seekable,
      title: mi.metadata.title ?? null,
      ...mi.metadata,
    };
  }

  /** 契约可选成员：点播整文件场景给出全段范围 */
  getBufferedRanges(trackId) {
    void trackId;
    if (this.stateValue !== 'ready') return [];
    return this.mediaInfo.durationUs != null
      ? [{ startUs: 0, endUs: this.mediaInfo.durationUs }]
      : [];
  }

  #assertReady(what) {
    if (this.stateValue === 'destroyed') throw new PlayerError('STATE_ERROR', `demuxer 已销毁，不可访问 ${what}`);
    if (this.stateValue !== 'ready') throw new PlayerError('STATE_ERROR', `须先完成 open() 才能访问 ${what}`);
  }

  getTrackById(id) {
    return this.trackList.find((t) => t.id === id) ?? null;
  }

  // ══════════════════════════════════════════════════════
  // readSample / samples —— pull 主通道
  // ══════════════════════════════════════════════════════
  /**
   * 拉取指定轨下一个样本；EOS 返回 null。
   * @param {number} trackId
   * @param {{signal?:AbortSignal|null}} [options] 可选中断信号（§12.3 新增可选成员）；
   *   abort 时 reject PlayerError('ABORTED')，不推进 EOS 标记、不 emit('error')，
   *   中断后仍可续读。不传时行为与冻结版一致。
   * @returns {Promise<Sample|null>}
   */
  async readSample(trackId, options = undefined) {
    this.#assertReady(`readSample(${trackId})`);
    const signal = options?.signal ?? null;
    throwIfAborted(signal, `readSample(${trackId}) aborted`);
    const track = this.getTrackById(trackId);
    if (!track) {
      throw new PlayerError('PARSE_ERROR', `未知轨道号 ${trackId}`);
    }
    if (track.encrypted) {
      throw new PlayerError('NOT_SUPPORTED', `轨道 #${trackId} 含 ContentEncodings（加密/压缩轨本期不支持）`);
    }
    if (!this.#trackIterators.has(trackId)) {
      this.#trackIterators.set(trackId, this.#iterateTrack(trackId));
    }
    const it = this.#trackIterators.get(trackId);
    let result;
    if (this.#pendingResults.has(trackId)) {
      // 上次被中断、但迟到落地的样本：优先吐出，避免中断吞样本
      result = this.#pendingResults.get(trackId);
      this.#pendingResults.delete(trackId);
    } else {
      const nextP = it.next();
      if (signal) {
        // 与 core 基类 pendingResult 同款：竞速期间已落地的样本缓存续读
        nextP.then((r) => { if (r && !r.done) this.#pendingResults.set(trackId, r); }, () => {});
      }
      result = await raceAbort(nextP, signal, `readSample(${trackId}) aborted`);
    }
    const { value, done } = result;
    if (done) {
      this.#eosedTracks.add(trackId);
      this.#maybeEmitEnd();
      return null;
    }
    return value;
  }

  /** 异步迭代器糖层（等价循环 readSample） */
  samples(trackId, options = undefined) {
    // 同步快速失败语义与 readSample 一致
    this.#assertReady(`samples(${trackId})`);
    const self = this;
    return (async function* gen() {
      for (;;) {
        const s = await self.readSample(trackId, options);
        if (s === null) return;
        yield s;
      }
    })();
  }

  /**
   * 单轨迭代内核：文件序过滤本轨，产出契约 Sample 形状。
   */
  async *#iterateTrack(trackId) {
    for await (const s of this.samplesInternal({ ...this.#pullOpts, trackIds: [trackId] })) {
      const idx = this.#sampleIndexByTrack.get(trackId) ?? 0;
      this.#sampleIndexByTrack.set(trackId, idx + 1);
      yield {
        trackId: s.trackId,
        codec: s.track.codec,
        timestamp: s.timestampUs,
        duration: s.durationUs ?? 0,
        data: s.data,
        keyframe: s.keyframe, // 音频/文本轨在 emit 处恒 true（契约 §1.1）
        dts: s.timestampUs,   // MKV 无独立 DTS：解码序=呈现序
        size: s.data.length,
        index: idx,
        // DiscardPadding（Matroska：BlockGroup 内 sint，单位 ns）：Opus/AAC 首尾填充裁剪依据。
        // 内部 #emitBlockFrames 已解析为 µs，此前该字段在映射层被丢弃，上层拿不到裁剪信息。
        discardPaddingUs: s.discardPaddingUs ?? 0,
        discardable: s.discardable ?? false,
      };
    }
  }

  /**
   * 契约 §2.3：全部轨 EOS 才发 'end'(eos)。
   * 判定：每个可读轨道都已有迭代器且均已 EOS（未被拉取的轨视为尚未结束）。
   */
  #maybeEmitEnd() {
    if (this.#endEmitted) return;
    const readable = this.trackList.filter((t) => !t.encrypted);
    if (!readable.length) return;
    for (const t of readable) {
      if (!this.#trackIterators.has(t.id) || !this.#eosedTracks.has(t.id)) return;
    }
    this.#endEmitted = true;
    this.emit('end', { reason: 'eos' });
  }

  // ══════════════════════════════════════════════════════
  // seek
  // ══════════════════════════════════════════════════════
  /**
   * seek（整数微秒）。清空各轨拉取进度并把起点对齐到 ≤target 的最近
   * 寻址点（优先 Cues，否则线性扫簇时间码建索引）；resolve 实际落点。
   */
  async seek(timestampUs) {
    this.#assertReady('seek');
    if (!Number.isFinite(timestampUs) || timestampUs < 0) {
      throw new PlayerError('PARSE_ERROR', `非法 seek 目标: ${timestampUs}`);
    }
    if (!this.mediaInfo.seekable) {
      throw new PlayerError('SEEK_UNSUPPORTED', '无可寻址簇（直播或空段）');
    }

    await this.#ensureSeekIndex();
    const off = await this.locate(timestampUs);
    if (off < 0) throw new PlayerError('SEEK_UNSUPPORTED', '无法定位目标时间');

    // 清空各轨缓冲并设置新拉取窗口（含中断迟到缓存：旧落点样本不得跨越 seek 生效）
    this.#trackIterators.clear();
    this.#pendingResults.clear();
    this.#eosedTracks.clear();
    this.#sampleIndexByTrack.clear();
    this.#endEmitted = false;
    this.#pullOpts = { startFileOffset: off, fromUs: timestampUs };

    // 实际落点：从落点簇向前找首个 ≥ target 的样本时间戳（有界探测）
    const actual = await this.#peekActualTimestamp(off, timestampUs);
    return { actualTimestampUs: actual };
  }

  /**
   * 无 Cues 时（或 open 惰性停止未及尾置 Cues 时）线性扫全部顶层元素建索引。
   * 幂等；顺带发现尾置 Cues 则解析后直接返回（seek 走 Cues 二分，优于簇索引）。
   * 评审 §18.3：open 已在首个 Cluster 处惰性终止，本方法成为簇后区间的唯一一次
   * 扫描（消除 open + seek 双遍历），且仅在有 seek 需求时才付出代价。
   */
  async #ensureSeekIndex() {
    if (this.cues.length || this.clusterIndex.length || this.firstClusterOffset < 0) return;
    const limit = this.segmentDataEnd;
    let p = this.firstClusterOffset;
    while (p >= 0 && p < limit) {
      const h = await this.#peekHeader(p);
      if (!h) break;
      if (h.id === ID.Cues && !this.cues.length) {
        // 惰性发现尾置 Cues：解析成功即切走 Cues 二分定位
        const before = this.cues.length;
        await this.#parseCuesAt(p);
        if (this.cues.length > before) return;
      }
      if (h.id === ID.Cluster) {
        const clusterEnd = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
        const tc = await this.#readClusterTimecode(h);
        if (tc !== null) this.clusterIndex.push({ timeNs: tc, fileOffset: p });
        p = clusterEnd;
      } else {
        p = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
      }
    }
    this.clusterIndex.sort((a, b) => a.timeNs - b.timeNs);
  }

  /** 时间(µs) → 目标簇文件偏移；找不到 -1 */
  async locate(us) {
    const targetNs = us * 1000;
    if (this.cues.length) {
      // 二分：取 ≤targetNs 的最后一个 CuePoint（cues 已按 timeNs 升序）
      let lo = 0;
      let hi = this.cues.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.cues[mid].timeNs <= targetNs) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return this.segmentDataStart + this.cues[ans].clusterOffsetInSegment;
    }
    const idx = this.clusterIndex;
    if (idx.length) {
      let lo = 0;
      let hi = idx.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (idx[mid].timeNs <= targetNs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return idx[ans].fileOffset;
    }
    return -1;
  }

  async #peekActualTimestamp(startFileOffset, targetUs) {
    for await (const s of this.samplesInternal({
      startFileOffset, fromUs: targetUs,
    })) {
      return s.timestampUs;
    }
    // 落点之后无样本（EOF 方向）：回退用时长钳制
    return this.durationUs ?? targetUs;
  }

  // ══════════════════════════════════════════════════════
  // 直播推送模式桩（点播 DataSource 场景不适用，保留冻结方法名）
  // ══════════════════════════════════════════════════════
  pause() { /* 点播 pull 模式无需暂停吐包 */ }
  resume() { /* 同上 */ }
  start() { /* MKV 为点播容器，无直播推送入口 */ }

  // ══════════════════════════════════════════════════════
  // destroy
  // ══════════════════════════════════════════════════════
  async destroy() {
    if (this.stateValue === 'destroyed') return; // 幂等
    this.stateValue = 'destroyed';
    this.#trackIterators.clear();
    this.#pendingResults.clear();
    this.#eosedTracks.clear();
    try { this.dataSource.close?.(); } catch { /* 关闭失败不影响销毁 */ }
    this.emit('end', { reason: 'aborted' });
  }

  // ══════════════════════════════════════════════════════
  // 内核：簇遍历与块展开（内部表示，µs 在此换算完成）
  // ══════════════════════════════════════════════════════
  /**
   * 内部顺序产出（文件序交织）。
   * @param {{trackIds?:number[], fromUs?:number, stopUs?:number, startFileOffset?:number}} opts
   * @yields {{trackId, track, timestampUs, durationUs, keyframe, discardable, discardPaddingUs, data}}
   */
  async *samplesInternal(opts = {}) {
    if (this.stateValue !== 'ready') {
      throw new PlayerError('STATE_ERROR', 'samplesInternal 需要 ready 态');
    }
    const filter = opts.trackIds ? new Set(opts.trackIds) : null;
    const scale = this.timecodeScaleNs;
    let p = opts.startFileOffset ?? (this.firstClusterOffset >= 0 ? this.firstClusterOffset : this.segmentDataStart);
    const limit = this.segmentDataEnd;

    while (p >= 0 && p < limit) {
      const h = await this.#peekHeader(p);
      if (!h) break;
      if (h.id === ID.Cluster) {
        const clusterEnd = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
        const clusterTimeNs = await this.#readClusterTimecode(h);
        yield* this.#walkClusterBlocks(h, clusterEnd, clusterTimeNs ?? 0, scale, filter, opts);
        p = clusterEnd;
      } else {
        p = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
      }
    }
  }

  async #readClusterTimecode(clusterHdr) {
    const limit = clusterHdr.unknown ? Infinity : clusterHdr.next;
    let p = clusterHdr.contentStart;
    while (p >= 0 && p < limit) {
      const h = await this.#peekHeader(p);
      if (!h) return null;
      if (h.id === ID.ClusterTimecode) {
        const body = await this.#readElementPayload(h);
        return decodeValueByType('u', body);
      }
      if (h.unknown) return null;
      p = h.next;
    }
    return null;
  }

  async *#walkClusterBlocks(clusterHdr, clusterEnd, clusterTimeNs, scale, filter, opts) {
    let p = clusterHdr.contentStart;
    while (p >= 0 && p < clusterEnd) {
      const h = await this.#peekHeader(p);
      if (!h) break;

      if (h.id === ID.SimpleBlock) {
        const payload = await this.#readElementPayload(h);
        yield* this.#emitBlockFrames(payload, {
          isSimple: true, clusterTimeNs, scale, filter, opts,
        });
        p = h.next;
      } else if (h.id === ID.BlockGroup) {
        const groupEnd = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
        const group = await this.#readExact(h.contentStart, groupEnd - h.contentStart);
        let blockPayload = null;
        let blockDurationUnits = null;
        let hasReference = false;
        let discardPaddingNs = 0;
        for (const el of iterElements(group, 0, group.length, SCHEMA)) {
          if (el.id === ID.Block) blockPayload = group.subarray(el.contentStart, el.contentEnd).slice();
          else if (el.id === ID.BlockDuration) blockDurationUnits = decodeValueByType('u', group.subarray(el.contentStart, el.contentEnd));
          else if (el.id === ID.ReferenceBlock) hasReference = true;
          else if (el.id === ID.DiscardPadding) discardPaddingNs = decodeValueByType('i', group.subarray(el.contentStart, el.contentEnd));
        }
        if (blockPayload) {
          yield* this.#emitBlockFrames(blockPayload, {
            isSimple: false,
            forceKeyframe: !hasReference, // Block 无关键帧位：有 ReferenceBlock 即增量帧
            clusterTimeNs,
            scale,
            filter,
            opts,
            durationUnits: blockDurationUnits,
            discardPaddingNs,
          });
        }
        p = groupEnd;
      } else if (h.id === ID.Void || h.id === ID.CRC32 || h.id === ID.ClusterPrevSize
                 || h.id === ID.ClusterTimecode) {
        p = h.next;
      } else {
        // 簇内非白名单的未知/不相关元素（如 deprecated Position 0xA7）：跳过其 payload
        // 并继续，避免 break 导致整簇剩余块/样本被静默丢弃（#2）。
        p = h.unknown ? await this.#probeUnknownMasterEnd(h) : h.next;
      }
    }
  }

  async *#emitBlockFrames(payload, ctx) {
    const {
      isSimple, forceKeyframe = false, clusterTimeNs, scale, filter,
      opts, durationUnits = null, discardPaddingNs = 0,
    } = ctx;
    const fromUs = opts.fromUs ?? -Infinity;
    const stopUs = opts.stopUs ?? Infinity;

    let bh;
    try {
      bh = parseBlockHeader(payload);
    } catch (err) {
      // 块头不可解析=流结构损坏（无法定位下一块边界），按契约 §11.3 双通道上抛
      const pe = new PlayerError('PARSE_ERROR', `块头解析失败（文件可能截断或损坏）: ${err?.message ?? err}`);
      this.emit('error', pe);
      throw pe;
    }
    if (filter && !filter.has(bh.trackNumber)) return;
    const track = this.getTrackById(bh.trackNumber);

    const tsNsBase = clusterTimeNs + bh.relTimecode;
    const timestampUs = Math.round((tsNsBase * scale) / 1000);
    if (timestampUs < fromUs || timestampUs >= stopUs) return;

    let frames;
    try {
      ({ frames } = decodeLacing(bh.lacing, payload.subarray(bh.bodyStart)));
    } catch (err) {
      // 单帧坏块不拖垮整条流：warn 并跳过（§11.4 warn=可恢复异常）
      console.warn('[mkv-demuxer] 块解码失败，已跳过:', err?.message ?? err);
      return;
    }

    const frameDurations = [];
    // BlockDuration 分摊：整数 µs 均分，余数补给末帧（避免先除后舍的精度漂移）
    if (durationUnits !== null) {
      const totalUs = Math.round((durationUnits * scale) / 1000);
      const n = frames.length;
      const base = Math.floor(totalUs / n);
      for (let i = 0; i < n; i++) {
        frameDurations.push(i === n - 1 ? totalUs - base * (n - 1) : base);
      }
    }
    // 契约 §1.1：关键帧标志——视频按块标志/参考块规则；音频/文本轨恒 true
    const keyframe = track?.type === 'video' ? (isSimple ? bh.keyframe : forceKeyframe) : true;

    let fi = -1;
    for (const frame of frames) {
      fi++;
      if (frame.length === 0) continue;
      yield {
        trackId: bh.trackNumber,
        track,
        timestampUs,
        durationUs: durationUnits !== null ? frameDurations[fi] ?? 0 : 0,
        keyframe,
        discardable: bh.discardable,
        discardPaddingUs: discardPaddingNs ? Math.round(discardPaddingNs / 1000) : 0,
        data: frame.slice(), // 拷贝脱离宿主缓冲
      };
    }
  }
}
