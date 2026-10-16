/**
 * Mp4Demuxer：ISO-BMFF 解复用（CONTRACTS v0.2 对齐）。
 *
 * 能力：
 * - 渐进式顶层扫描：只读 box 头，mdat 载荷不读入（天然支持 HTTP Range 与"moov 在尾部"）；
 * - 普通 MP4：由 stbl 展开完整样本表；
 * - fMP4（存在 mvex）：顺序遍历 moof/mdat 片段产出样本（单遍、按文件序）；
 * - seek(timestampUs) 返回 {actualTimestampUs}，对齐 ≤ 目标的最近视频关键帧 DTS。
 *
 * 契约边界（§0.5）：内部采样表保持原生 ticks，**产出 Sample 一律整数微秒**
 * （ticksToUs 就近取整）；Track.timescale 仅诊断保留。
 *
 * 约束：
 * - 分片模式共享 moof 扫描结果，但各轨独立消费样本游标，支持交错或并发读取；
 * - 不解密：加密 sample entry（encv/enca）直接抛 NOT_SUPPORTED。
 */
import {
  Demuxer,
  ByteStream,
  TrackType,
  BitstreamFormat,
  createTrack,
  createSample,
  buildAvcCodecString,
  buildHevcCodecString,
  aacCodecStringFromAsc,
  ticksToUs,
  usToTicks,
  createProbeResult,
  DEFAULT_MAX_MOOV_BYTES,
  DEFAULT_MAX_SAMPLE_BYTES,
  assertByteLength,
} from '../../core/src/index.js';

/**
 * 受上界保护的读取（评审 I5：防畸形长度字段触发超大 Range 请求/内存分配）。
 * mov/src/demuxer.js 复用同一实现。
 *
 * @param {{read:(o:number,l:number)=>Promise<Uint8Array>}} source
 * @param {number} offset
 * @param {number} length
 * @param {{max:number, what:string}} opts
 */
export async function readCapped(source, offset, length, { max, what }) {
  assertByteLength(length, max, what);
  return source.read(offset, length);
}
import { parseError, stateError, notSupported } from '../../core/src/errors.js';
import { iterateBoxes, parseMoov, parseTfhd, parseTrun } from './box-parser.js';

const TOP_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'sidx', 'pnot']);
const ENCRYPTED_ENTRIES = new Set(['encv', 'enca']);
const AVC_ENTRIES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1']);

export class Mp4Demuxer extends Demuxer {
  static containerName = 'mp4';

  /**
   * 魔数嗅探（契约 §2.2：同步、不抛异常；命中 ProbeResult，否则 null）。
   * QuickTime 特征置信度压低，让位给 mov 的 MovDemuxer。
   */
  static probe(bytes) {
    try {
      if (!bytes || bytes.byteLength < 8) return null;
      const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
      if (!TOP_BOXES.has(type)) return null;
      if (type === 'wide') {
        return createProbeResult(0.5, 'mp4');
      }
      if (type === 'ftyp') {
        const brand =
          bytes.byteLength >= 12
            ? String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
            : '';
        if (brand === 'qt  ') return createProbeResult(0.5, 'mov');
        return createProbeResult(
          0.95,
          'mp4',
          ['avc1', 'mp4a.40.2'],
        );
      }
      if (type === 'styp') return createProbeResult(0.85, 'mp4'); // fMP4 分片
      return createProbeResult(0.82, 'mp4');
    } catch {
      return null;
    }
  }

  /**
   * @param {DataSource} source
   * @param {{initTimeoutMs?: number, liveLatencyUs?: number, lazySamples?: boolean,
   *          maxMoovBytes?: number, maxSampleBytes?: number}} [options]
   *   maxMoovBytes/maxSampleBytes：I5 畸形输入防护的字节上界
   */
  constructor(source, options = {}) {
    super(source, options);
    /** moov/moof 单次读入上界（I5） */
    this.maxMoovBytes = options.maxMoovBytes ?? DEFAULT_MAX_MOOV_BYTES;
    /** 单样本字节上界（I5） */
    this.maxSampleBytes = options.maxSampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES;
    /** @type {{type:string,start:number,end:number,contentStart:number}[]} */
    this._topLevelBoxes = [];
    /** @type {Map<number, {track:object, samples:Array, keyframes:Array, trex?:object}>} 内部表（ticks）*/
    this._trackState = new Map();
    this._fragmented = false;
    this._fragCursorIndex = 0;
    this._fragmentScanPromise = null;
  }

  /* ------------------------------ 打开 ------------------------------ */

  async _doOpen() {
    await this._scanTopLevel();

    const moovBox = this._topLevelBoxes.find((b) => b.type === 'moov');
    if (!moovBox) {
      throw parseError('MP4: moov box not found (file truncated?)');
    }
    const moovBytes = await readCapped(this.source, moovBox.start, moovBox.end - moovBox.start, {
      max: this.maxMoovBytes,
      what: 'MP4 moov',
    });
    const moov = parseMoov(moovBytes);
    this._moov = moov;
    this._fragmented = !!moov.mvex;

    const ftypBox = this._topLevelBoxes.find((b) => b.type === 'ftyp');
    let brands = null;
    if (ftypBox) {
      const ftypBytes = await this.source.read(ftypBox.start, Math.min(ftypBox.end - ftypBox.start, 256));
      brands = parseFtypSafe(ftypBytes);
    }

    /** @type {Track[]} 契约形状 */
    const tracks = [];
    for (const trak of moov.traks) {
      const track = this._buildTrack(trak);
      if (track) {
        tracks.push(track);
        this._prepareTrackState(track, trak, moov.mvhd.timescale);
      }
    }

    const timescale = moov.mvhd.timescale;
    const hasProgressiveEdits = this._usesProgressiveEditTimeline() && !this._fragmented &&
      moov.traks.some((trak) => trak.elst?.entries?.length > 0);
    const knownDurationTicks = this._fragmented
      ? moov.mvex?.mehd?.fragmentDuration ?? moov.mvhd.duration
      : moov.mvhd.duration;
    const live = false; // 本仓 MP4 均为点播文件/渐进流
    const editedMovieDurationUs = hasProgressiveEdits
      ? moov.traks.reduce((duration, trak) => {
        const track = tracks.find((candidate) => candidate.id === trak.tkhd?.trackId);
        const trackDuration = track?.presentationDurationUs ??
          (trak.tkhd?.duration != null && trak.tkhd.duration !== 0xffffffff
            ? ticksToUs(trak.tkhd.duration, timescale)
            : 0);
        return Math.max(duration, trackDuration);
      }, 0)
      : null;
    const durationUs = hasProgressiveEdits
      ? editedMovieDurationUs || null
      : !this._fragmented || moov.mvex?.mehd?.fragmentDuration
        ? ticksToUs(knownDurationTicks || 0, timescale) || null
        : null;

    return {
      container: 'mp4',
      tracks,
      durationUs: durationUs > 0 ? durationUs : null,
      seekable: true,
      live,
      fragmented: this._fragmented,
      ...(brands ? { brands } : {}),
    };
  }

  /** 只读头部的顶层扫描（Range 友好）；幂等，可被子类先调用 */
  async _scanTopLevel() {
    if (this._topLevelBoxes.length > 0) return;
    const ds = this.source;
    const total = typeof ds.size === 'number' ? ds.size : await ds.size;
    const boxes = [];
    let pos = 0;
    while (pos < total) {
      const head = await ds.read(pos, Math.min(16, total - pos));
      if (head.byteLength < 8) throw parseError(`truncated box header at ${pos}`);
      const bs = new ByteStream(head);
      let size = bs.readU32();
      const type = bs.readFourCC();
      let headerSize = 8;
      if (size === 1) {
        if (head.byteLength < 16) throw parseError(`largesize truncated at ${pos}`);
        size = bs.readU64Number();
        headerSize = 16;
      } else if (size === 0) {
        size = total - pos;
      }
      if (size < headerSize || pos + size > total) {
        throw parseError(`invalid top-level box '${type}' size=${size} at ${pos} (total=${total})`);
      }
      boxes.push({ type, start: pos, end: pos + size, contentStart: pos + headerSize });
      pos += size;
    }
    this._totalSize = total;
    this._topLevelBoxes = boxes;
  }

  /** trak 结构树 → 契约 Track（µs 时间基字段） */
  _usesProgressiveEditTimeline() { return true; }

  _buildTrack(trak) {
    const { tkhd, mdhd, hdlr, sampleEntry } = trak;
    if (!tkhd || !mdhd || !hdlr) return null;

    let type = TrackType.METADATA;
    if (hdlr.handlerType === 'vide') type = TrackType.VIDEO;
    else if (hdlr.handlerType === 'soun') type = TrackType.AUDIO;
    else if (['text', 'sbtl', 'subt', 'clcp'].includes(hdlr.handlerType)) type = TrackType.TEXT;

    if (sampleEntry && ENCRYPTED_ENTRIES.has(sampleEntry.type)) {
      throw notSupported(`track ${tkhd.trackId}: encrypted sample entry (${sampleEntry.type})`, {
        trackId: tkhd.trackId,
      });
    }

    const track = createTrack({
      id: tkhd.trackId,
      type,
      language: mdhd.language && mdhd.language !== 'XXX' ? mdhd.language : 'und',
      timescale: mdhd.timescale, // 诊断保留
      durationUs: ticksToUs(mdhd.duration || 0, mdhd.timescale),
      width: tkhd.width || undefined,
      height: tkhd.height || undefined,
    });

    if (sampleEntry && !sampleEntry.raw) {
      track.sampleEntryType = sampleEntry.type;
      if (sampleEntry.avcC) {
        track.description = sampleEntry.avcC.bytes;
        track.codec = buildAvcCodecString(sampleEntry.avcC.bytes, sampleEntry.type);
      } else if (sampleEntry.hvcC) {
        track.description = sampleEntry.hvcC.bytes;
        track.codec = buildHevcCodecString(sampleEntry.hvcC.bytes, sampleEntry.type);
      } else if (sampleEntry.esds?.audioSpecificConfig) {
        track.description = sampleEntry.esds.audioSpecificConfig;
        track.codec = aacCodecStringFromAsc(sampleEntry.esds.audioSpecificConfig);
      }
      // MP4 码流为长度前缀形态（AVCC/HVCC），WebCodecs 直接吃 description
      if (type === TrackType.VIDEO && AVC_ENTRIES.has(sampleEntry.type)) {
        track.bitstreamFormat = BitstreamFormat.AVC;
      }
      if (type === TrackType.AUDIO) {
        track.sampleRate = sampleEntry.sampleRate;
        track.numberOfChannels = sampleEntry.channelCount;
      }
    }
    return track;
  }

  /**
   * 准备轨状态：渐进模式展开完整样本表（内部 ticks）；分片模式记录 trex 默认值。
   */
  _prepareTrackState(track, trak, movieTimescale) {
    if (this._fragmented) {
      const trex = this._moov.mvex.trexByTrack[track.id] ?? {};
      this._trackState.set(track.id, { track, samples: [], keyframes: [], trex, resumeIndex: 0, fragmentReadIndex: 0 });
      return;
    }
    const table = expandSampleTable(trak.stbl);
    let edits = null;
    if (this._usesProgressiveEditTimeline() && trak.elst?.entries?.length) {
      try {
        edits = buildProgressiveEditMap(table.samples, trak.elst.entries, track.timescale, movieTimescale);
        track.presentationDurationUs = edits.durationUs;
        track.editListApplied = true;
      } catch (error) {
        const fallbackReasons = new Set([
          'elst mapping requires variable composition offsets',
          'elst mapping does not support negative composition offsets',
          'elst media edit 终点不得裁切样本',
          'elst media edit 终点必须精确落在样本边界',
          'elst 映射后的样本时间非法或 DTS 为负',
          '渐进 MP4 暂不支持多个非空 elst media edit',
          'elst empty edit 仅支持出现在 media edit 之前',
        ]);
        if (error?.code !== 'NOT_SUPPORTED' || !fallbackReasons.has(error.message)) throw error;
        track.editListApplied = false;
        track.editListUnsupportedReason = error.message;
        track.presentationDurationUs = table.samples.reduce((duration, sample) =>
          Math.max(duration, ticksToUs(sample.dts + sample.cts + sample.delta, track.timescale)),
        track.durationUs ?? 0);
      }
    }
    this._trackState.set(track.id, {
      track,
      samples: table.samples, // {offset,size,dts,cts,delta,keyframe} ticks
      editMap: edits?.bySample ?? null,
      keyframes: table.samples
        .map((s, i) => (s.keyframe && (!edits || edits.bySample.get(i)?.visible) ? i : -1))
        .filter((i) => i >= 0),
      resumeIndex: 0, // seek 续读起点（样本表 index），由 _doSeek 写入、迭代器生成时消费
    });
  }

  /* ------------------------------ 读样本 ------------------------------ */

  /** 契约钩子：返回某轨的样本生成器（输出 µs 契约 Sample） */
  _createTrackIterator(trackId) {
    const self = this;
    async function* iterate() {
      if (self.stateValue === 'destroyed') throw stateError('demuxer destroyed');
      if (self._fragmented) {
        yield* self._iterateFragments(trackId);
        return;
      }
      yield* self._iterateProgressive(trackId);
    }
    return iterate();
  }

  async *_iterateProgressive(trackId) {
    const state = this._requireTrack(trackId);
    const { track } = state;
    const ts = track.timescale || 1000;
    const lazy = this.options.lazySamples === true;
    // seek 续读：从 resumeIndex（最近关键帧或对应时间样本）起步；
    // 跳过的样本不读数据。表在 open 时已完整，index 保持原表编号。
    for (let index = state.resumeIndex ?? 0; index < state.samples.length; index++) {
      const raw = state.samples[index];
      const edit = state.editMap?.get(index);
      if (state.editMap && !edit) continue;
      const sample = createSample({
        trackId,
        codec: track.codec,
        timestamp: edit?.timestampUs ?? ticksToUs(raw.dts + raw.cts, ts),
        duration: edit?.durationUs ?? ticksToUs(raw.delta, ts),
        keyframe: raw.keyframe,
        dts: edit?.dtsUs ?? ticksToUs(raw.dts, ts),
        size: raw.size,
        index,
        offset: raw.offset,
        dataState: undefined,
        data: null,
      });
      if (!lazy) {
        sample.data = await readCapped(this.source, sample.offset, sample.size, {
          max: this.maxSampleBytes,
          what: `MP4 样本(track ${trackId}, index ${sample.index})`,
        });
        sample.dataState = 'loaded';
      } else {
        delete sample.data;
        sample.dataState = 'lazy';
      }
      yield sample;
    }
  }

  /** 按轨消费 moof/mdat 样本缓存；共享扫描队列只解析每个 fragment 一次 */
  async *_iterateFragments(trackId) {
    const state = this._trackState.get(trackId);
    if (!state) throw parseError('unknown track ' + trackId);
    const lazy = this.options.lazySamples === true;
    state.fragmentReadIndex ??= 0;

    for (;;) {
      while (state.fragmentReadIndex < state.samples.length) {
        const sampleIndex = state.fragmentReadIndex;
        const sample = state.samples[sampleIndex];
        if (lazy) {
          delete sample.data;
          sample.dataState = 'lazy';
        } else if (sample.dataState !== 'loaded') {
          sample.data = await readCapped(this.source, sample.offset, sample.size, {
            max: this.maxSampleBytes,
            what: 'MP4 分片样本(track ' + trackId + ', index ' + sample.index + ')',
          });
          sample.dataState = 'loaded';
        }
        state.fragmentReadIndex = sampleIndex + 1;
        yield sample;
      }
      // A scan advances the box cursor before its asynchronous read completes. Join that scan
      // before deciding EOS or another track can miss samples from the final moof.
      if (!(await this._scanNextFragment())) return;
    }
  }

  /** Shared fragment scan: parse each moof once and cache metadata for every track. */
  _scanNextFragment() {
    if (this._fragmentScanPromise) return this._fragmentScanPromise;
    const scan = this._scanNextFragmentInternal();
    this._fragmentScanPromise = scan;
    scan.then(
      () => { if (this._fragmentScanPromise === scan) this._fragmentScanPromise = null; },
      () => { if (this._fragmentScanPromise === scan) this._fragmentScanPromise = null; },
    );
    return scan;
  }

  async _scanNextFragmentInternal() {
    while (this._fragCursorIndex < this._topLevelBoxes.length) {
      const box = this._topLevelBoxes[this._fragCursorIndex++];
      if (box.type !== 'moof') continue;
      const moofBytes = await readCapped(this.source, box.start, box.end - box.start, {
        max: this.maxMoovBytes,
        what: 'MP4 moof',
      });
      const mdatBoxes = this._findMdatsAfter(this._fragCursorIndex);
      if (mdatBoxes.length === 0) throw parseError('moof at ' + box.start + ': no following mdat');

      // moofBytes is an independent slice; sample offsets are relative to its 8-byte box header.
      const frags = parseMoofTracks(moofBytes, 8, moofBytes.byteLength);
      const decodeTimeByTraf = new Map();
      const dataEndByTraf = new Map();
      let previousTrafEnd = box.start;
      let activeTrafIndex = -1;
      for (const frag of frags) {
        if (frag.trafIndex !== activeTrafIndex) {
          if (activeTrafIndex !== -1) previousTrafEnd = dataEndByTraf.get(activeTrafIndex) ?? previousTrafEnd;
          activeTrafIndex = frag.trafIndex;
        }
        const trackState = this._trackState.get(frag.trackId);
        const track = trackState?.track;
        const trex = trackState?.trex ?? this._moov.mvex?.trexByTrack?.[frag.trackId] ?? {};
        const ts = track?.timescale || 1000;
        let dts = decodeTimeByTraf.get(frag.trafIndex) ?? frag.baseMediaDecodeTime;
        const baseOffset = frag.baseDataOffset ??
          (frag.defaultBaseIsMoof || frag.trafIndex === 0 ? box.start : previousTrafEnd);
        let runOffset;
        if (frag.dataStartOffset !== null) {
          runOffset = baseOffset - box.start + frag.dataStartOffset;
        } else {
          runOffset = (dataEndByTraf.get(frag.trafIndex) ?? baseOffset) - box.start;
        }
        for (let i = 0; i < frag.samples.length; i++) {
          const rec = frag.samples[i];
          const durationTicks = rec.duration ?? frag.defaultSampleDuration ?? trex.defaultSampleDuration ?? 0;
          const size = rec.size ?? frag.defaultSampleSize ?? trex.defaultSampleSize ?? 0;
          const sampleOffset = box.start + runOffset;
          const sampleEnd = sampleOffset + size;
          const sampleMdat = mdatBoxes.find((mdat) =>
            sampleOffset >= mdat.contentStart && sampleEnd <= mdat.end
          );
          if (!sampleMdat) {
            throw parseError(
              'fragment sample(track ' + frag.trackId + ') range [' + sampleOffset + ', ' + sampleEnd + ') is outside following mdat payloads',
            );
          }
          const flags = rec.flags ?? (i === 0 ? frag.firstSampleFlags : undefined) ?? frag.defaultSampleFlags ?? trex.defaultSampleFlags ?? 0;
          const keyframe = (flags & 0x00010000) === 0;
          const cts = rec.cts ?? 0;
          const sample = createSample({
            trackId: frag.trackId,
            codec: track?.codec ?? '',
            timestamp: ticksToUs(dts + cts, ts),
            duration: ticksToUs(durationTicks, ts),
            dts: ticksToUs(dts, ts),
            keyframe,
            size,
            index: trackState?.samples.length ?? i,
            offset: sampleOffset,
            data: null,
            dataState: 'lazy',
            dtsRaw: dts,
          });
          if (trackState?.keyframes) {
            trackState.samples.push(sample);
            if (keyframe) trackState.keyframes.push(sample.index);
          }
          dts += durationTicks;
          runOffset += size;
        }
        decodeTimeByTraf.set(frag.trafIndex, dts);
        dataEndByTraf.set(frag.trafIndex, box.start + runOffset);
      }
      return true;
    }
    return false;
  }


  _findMdatsAfter(index) {
    const mdats = [];
    for (let i = index; i < this._topLevelBoxes.length; i++) {
      const b = this._topLevelBoxes[i];
      if (b.type === 'moof') break;
      if (b.type === 'mdat') mdats.push(b);
    }
    return mdats;
  }

  /* ------------------------------ seek ------------------------------ */

  /**
   * @param {number} timestampUs 整数微秒
   * @returns {Promise<{actualTimestampUs:number}>}
   * 契约（core demuxer）：_doSeek 负责重定位内部游标——各轨 resumeIndex 写为
   * 「DTS ≤ 目标时间的最后样本」index（目标轨按单调 DTS 定位关键帧），seek 后新迭代器
   * 从 resumeIndex 续读。渐进表 open 时完整；分片表随扫描建立，仅能落在已扫
   * 区间内（未扫到的部分由后续扫描自然接续）。
   */
  async _doSeek(timestampUs) {
    const targetId =
      this.tracks.find((t) => t.type === 'video')?.id ?? this.tracks[0]?.id;
    if (targetId === undefined) return { actualTimestampUs: 0 };

    const state = this._trackState.get(targetId);
    if (!state || state.keyframes.length === 0) {
      // 索引未建立：resumeIndex 归 0（有表则整表重放）、共享游标不动，
      // 后续从当前扫描位置继续（分片模式索引随消费建立，属既定限制）。
      if (state) {
        state.resumeIndex = 0;
        if (this._fragmented) state.fragmentReadIndex = 0;
      }
      return { actualTimestampUs: 0 };
    }

    const ts = state.track.timescale || 1000;
    const searchableKeyframes = state.editMap
      ? state.keyframes.filter((index) => state.editMap.has(index))
      : state.keyframes;
    if (searchableKeyframes.length === 0) return { actualTimestampUs: 0 };
    // The seek contract is a decode-time RAP: DTS is monotone in sample order even when ctts reorders PTS.
    let lo = 0;
    let hi = searchableKeyframes.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const index = searchableKeyframes[mid];
      const dtsUs = state.editMap?.get(index)?.dtsUs ??
        ticksToUs(kfDtsTicks(state.samples[index], ts), ts);
      if (dtsUs <= timestampUs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const pickIdx = searchableKeyframes[found >= 0 ? found : 0];
    const pickedDtsUs = state.editMap?.get(pickIdx)?.dtsUs ??
      ticksToUs(kfDtsTicks(state.samples[pickIdx], ts), ts);
    state.resumeIndex = pickIdx;
    if (this._fragmented) state.fragmentReadIndex = pickIdx;
    const mappedDtsUs = state.editMap?.get(pickIdx)?.dtsUs;
    const actualUs = found >= 0 ? pickedDtsUs :
      (mappedDtsUs !== undefined && timestampUs < mappedDtsUs ? timestampUs : 0);
    // 多轨必须相对视频实际 DTS 落点定位，而不是原始请求时间；
    // 否则关键帧回退时音频也会从请求时间才开始，MSE 轨道间出现时间缺口。
    for (const [id, st] of this._trackState) {
      if (id !== targetId) {
        st.resumeIndex = _locateResumeIndex(st, actualUs);
        if (this._fragmented) st.fragmentReadIndex = st.resumeIndex;
      }
    }
    this.emit('seek', { timestampUs, trackId: targetId });
    return { actualTimestampUs: Math.min(actualUs, timestampUs) };
  }

  _requireTrack(trackId) {
    const state = this._trackState.get(trackId);
    if (!state) throw stateError(`unknown trackId ${trackId}`);
    return state;
  }
}

/* ------------------------------ 辅助函数 ------------------------------ */

/**
 * Map progressive samples through the rate-1 edit-list subset. Empty edits
 * advance movie time; media edits select presentation timestamps in their range.
 */
function buildProgressiveEditMap(samples, entries, mediaTimescale, movieTimescale) {
  if (!Number.isSafeInteger(mediaTimescale) || mediaTimescale <= 0 ||
      !Number.isSafeInteger(movieTimescale) || movieTimescale <= 0) {
    throw notSupported('elst media/movie timescale 非法');
  }
  let movieCursor = 0;
  let mediaEditSeen = false;
  let presentationDurationUs = null;
  const bySample = new Map();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const { segmentDuration, mediaTime, mediaRateInteger, mediaRateFraction } = entries[entryIndex];
    if (!Number.isSafeInteger(segmentDuration) || segmentDuration < 0 ||
        !Number.isSafeInteger(mediaTime) ||
        !Number.isInteger(mediaRateInteger) || !Number.isInteger(mediaRateFraction)) {
      throw notSupported('elst entry 字段非法');
    }
    if (mediaRateInteger !== 1 || mediaRateFraction !== 0) {
      throw notSupported(`elst media rate 不支持: ${mediaRateInteger}.${mediaRateFraction}`);
    }
    if (mediaTime < 0 && mediaTime !== -1) {
      throw notSupported(`elst empty edit media_time 非法: ${mediaTime}`);
    }
    if (mediaTime === -1) {
      if (mediaEditSeen) throw notSupported('elst empty edit 仅支持出现在 media edit 之前');
    } else {
      const openEnded = segmentDuration === 0;
      if (openEnded && entryIndex !== entries.length - 1) {
        throw notSupported('零时长 elst media edit 必须是最后一项');
      }
      if (mediaEditSeen) throw notSupported('渐进 MP4 暂不支持多个非空 elst media edit');
      const mediaEndDenominator = BigInt(movieTimescale);
      const lastPresentationEnd = samples.reduce((end, sample) =>
        Math.max(end, sample.dts + sample.cts + sample.delta), mediaTime);
      const mediaEndTicks = openEnded ? lastPresentationEnd : null;
      const mediaEndNumerator = openEnded
        ? BigInt(mediaEndTicks) * mediaEndDenominator
        : BigInt(mediaTime) * mediaEndDenominator + BigInt(segmentDuration) * BigInt(mediaTimescale);
      if (mediaEndNumerator > BigInt(Number.MAX_SAFE_INTEGER) * mediaEndDenominator) {
        throw notSupported('elst media 时间范围溢出');
      }
      const cts = samples[0]?.cts ?? 0;
      if (samples.some((sample) => sample.cts !== cts)) {
        throw notSupported('elst mapping requires variable composition offsets');
      }
      if (cts < 0) throw notSupported('elst mapping does not support negative composition offsets');
      const firstIndex = samples.findIndex((sample) => sample.dts + sample.cts === mediaTime);
      if (firstIndex < 0 || mediaEndNumerator <= BigInt(mediaTime) * mediaEndDenominator) {
        throw notSupported('elst media edit 起点必须精确落在样本 presentation boundary');
      }
      const endsAtSampleBoundary = samples.some((sample) =>
        BigInt(sample.dts + sample.cts + sample.delta) * mediaEndDenominator === mediaEndNumerator);
      if (!endsAtSampleBoundary) throw notSupported('elst media edit 终点必须精确落在样本边界');
      if (!samples[firstIndex].keyframe) {
        throw notSupported('elst media edit 起点必须是 sync sample（不支持额外 decode preroll）');
      }
      const selected = [];
      for (let index = firstIndex; index < samples.length; index++) {
        if (BigInt(samples[index].dts + samples[index].cts) * mediaEndDenominator >= mediaEndNumerator) break;
        selected.push(index);
      }
      let previous = null;
      for (const index of selected) {
        const sample = samples[index];
        const timestampUs = editTimeToUs(movieCursor, movieTimescale, sample.dts + sample.cts - mediaTime, mediaTimescale);
        const dtsUs = editTimeToUs(movieCursor, movieTimescale, sample.dts - mediaTime, mediaTimescale);
        const endUs = editTimeToUs(movieCursor, movieTimescale, sample.dts + sample.delta - mediaTime, mediaTimescale);
        const durationUs = endUs - dtsUs;
        if (!Number.isSafeInteger(timestampUs) || !Number.isSafeInteger(dtsUs) ||
            !Number.isSafeInteger(durationUs) || durationUs <= 0 || dtsUs < 0) {
          throw notSupported('elst 映射后的样本时间非法或 DTS 为负');
        }
        if (previous && (sample.dts !== previous.dts + previous.delta || dtsUs !== previous.endUs)) {
          throw notSupported('elst 映射后的样本 DTS 不连续或倒退');
        }
        bySample.set(index, { timestampUs, dtsUs, durationUs, visible: true });
        previous = { dts: sample.dts, delta: sample.delta, endUs };
      }
      mediaEditSeen = true;
      if (openEnded) {
        presentationDurationUs = editTimeToUs(movieCursor, movieTimescale, mediaEndTicks - mediaTime, mediaTimescale);
      }
    }
    movieCursor += segmentDuration;
    if (!Number.isSafeInteger(movieCursor)) throw notSupported('elst segmentDuration 累计溢出');
  }
  return { bySample, durationTicks: movieCursor, durationUs: presentationDurationUs ?? ticksToUs(movieCursor, movieTimescale) };
}

function editTimeToUs(movieTicks, movieTimescale, mediaTicks, mediaTimescale) {
  const movieScale = BigInt(movieTimescale);
  const mediaScale = BigInt(mediaTimescale);
  const numerator = BigInt(movieTicks) * 1_000_000n * mediaScale +
    BigInt(mediaTicks) * 1_000_000n * movieScale;
  const denominator = movieScale * mediaScale;
  const rounded = numerator >= 0n
    ? (numerator + denominator / 2n) / denominator
    : -((-numerator + denominator / 2n) / denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw notSupported('elst timestamp 转 microseconds 超出安全整数范围');
  }
  return Number(rounded);
}

/**
 * 按解码时间定位轨的 seek 续读起点：DTS ≤ 目标时间的最后一个样本 index。
 * 表按 sample index 展开且 DTS 单调，故扫描全部已知样本。
 * 回退 0（从表头重放）。返回值写入 state.resumeIndex。
 */
function _locateResumeIndex(state, timestampUs) {
  const ts = state.track.timescale || 1000;
  const target = timestampUs;
  let found = -1;
  for (let i = 0; i < state.samples.length; i++) {
    if (state.editMap && !state.editMap.has(i)) continue;
    const dtsUs = state.editMap?.get(i)?.dtsUs ?? ticksToUs(kfDtsTicks(state.samples[i], ts), ts);
    if (dtsUs <= target) found = i;
  }
  if (found >= 0) return found;
  return state.editMap ? (state.editMap.keys().next().value ?? state.samples.length) : 0;
}

/** 条目 DTS（ticks）：渐进表为原始 ticks 结构；分片表为契约 Sample（dts 为 µs，需回转） */
function kfDtsTicks(entry, timescale) {
  // 原始行（渐进表）没有 timestamp 字段，dts 即 ticks；
  // 契约样本（分片表）timestamp/dts 为 µs，优先用 dtsRaw 精确回转。
  if (entry.timestamp === undefined) return entry.dts ?? 0;
  if (entry.dtsRaw !== undefined) return entry.dtsRaw;
  return usToTicks(entry.dts ?? entry.timestamp, timescale);
}

function parseFtypSafe(bytes) {
  try {
    let out = null;
    iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
      if (h.type !== 'ftyp') return true;
      const s = new ByteStream(bytes, h.contentStart, h.end - h.contentStart);
      out = { majorBrand: s.readFourCC(), minorVersion: s.readU32(), compatible: [] };
      while (s.remaining >= 4) out.compatible.push(s.readFourCC());
      return false;
    });
    return out;
  } catch {
    return null;
  }
}

/**
 * 展开 stbl 采样表为样本描述数组（内部 ticks 表示）。
 * 无 stss 时按规范约定"全部样本均为 sync sample"处理。
 * @returns {{samples: {offset:number,size:number,dts:number,cts:number,delta:number,keyframe:boolean}[]}}
 */
export function expandSampleTable(stbl) {
  const stsz = stbl.stsz ?? stbl.stz2;
  const stts = stbl.stts;
  const stsc = stbl.stsc;
  const stco = stbl.stco ?? stbl.co64;
  if (!stsz || !stts || !stsc || !stco) {
    throw parseError('incomplete stbl tables (missing stsz/stts/stsc/stco)');
  }

  const count = stsz.sizes ? stsz.sizes.length : stsz.sampleCount;
  const sizes = stsz.sizes ?? new Array(count).fill(stsz.defaultSize);

  const entries = stsc.entries;
  const samplesPerChunkOf = (chunkIndex) => {
    for (let e = entries.length - 1; e >= 0; e--) {
      if (entries[e].firstChunk <= chunkIndex) return entries[e].samplesPerChunk;
    }
    return 0;
  };

  const offsets = new Array(count);
  let si = 0;
  for (let c = 0; c < stco.offsets.length && si < count; c++) {
    let off = stco.offsets[c];
    const spc = samplesPerChunkOf(c);
    for (let k = 0; k < spc && si < count; k++) {
      offsets[si] = off;
      off += sizes[si];
      si++;
    }
  }
  if (si < count) {
    throw parseError(`sample table inconsistent: ${count} sizes but only ${si} placed into chunks`);
  }

  const samples = new Array(count);
  let dts = 0;
  let idx = 0;
  for (const run of stts.runs) {
    for (let i = 0; i < run.count && idx < count; i++, idx++) {
      samples[idx] = { offset: offsets[idx], size: sizes[idx], dts, delta: run.delta, cts: 0, keyframe: false };
      dts += run.delta;
    }
  }
  while (idx < count) {
    // stts 游程短于样本数：沿用最后 delta 容错补齐
    const prevDelta = samples[idx - 1]?.delta ?? 0;
    samples[idx] = { offset: offsets[idx], size: sizes[idx], dts, delta: prevDelta, cts: 0, keyframe: false };
    dts += prevDelta;
    idx++;
  }

  if (stbl.ctts) {
    let j = 0;
    for (const run of stbl.ctts.runs) {
      for (let i = 0; i < run.count && j < count; i++, j++) {
        samples[j].cts = run.offset;
      }
    }
  }
  if (stbl.stss) {
    for (const kf of stbl.stss.indices) {
      if (kf >= 0 && kf < count) samples[kf].keyframe = true;
    }
  } else if (count > 0) {
    for (const s of samples) s.keyframe = true;
  }
  return { samples };
}

/** 解析一个 moof 内的全部 traf → 每个 trun 一条带 track 默认值的 run 记录。 */
export function parseMoofTracks(moofBytes, contentStart, end) {
  const frags = [];
  let trafIndex = -1;
  iterateBoxes(moofBytes, contentStart, end, (h) => {
    if (h.type !== 'traf') return;
    const currentTrafIndex = ++trafIndex;
    let tfhd = null;
    let baseMediaDecodeTime = 0;
    const truns = [];
    iterateBoxes(moofBytes, h.contentStart, h.end, (sh) => {
      const s = new ByteStream(moofBytes, sh.contentStart, sh.end - sh.contentStart);
      if (sh.type === 'tfhd') tfhd = parseTfhd(s);
      else if (sh.type === 'tfdt') baseMediaDecodeTime = readTfdt(s);
      else if (sh.type === 'trun') truns.push(parseTrun(s));
    });
    if (!tfhd || truns.length === 0) return;
    for (const trun of truns) {
      frags.push({
        trackId: tfhd.trackId,
        trafIndex: currentTrafIndex,
        baseMediaDecodeTime,
        baseDataOffset: tfhd.baseDataOffset,
        defaultBaseIsMoof: tfhd.defaultBaseIsMoof,
        defaultSampleDuration: tfhd.defaultSampleDuration,
        defaultSampleSize: tfhd.defaultSampleSize,
        defaultSampleFlags: tfhd.defaultSampleFlags,
        firstSampleFlags: trun.firstSampleFlags,
        dataStartOffset: trun.dataOffset === null ? null : trun.dataOffset,
        samples: trun.samples,
      });
    }
  });
  return frags;
}

/** tfdt 的 base_media_decode_time（version 决定 32/64 位） */
function readTfdt(s) {
  const version = s.bytes[0]; // fullbox 第 0 字节是 version
  s.skip(4); // version+flags
  return version === 1 ? s.readU64Number() : s.readU32();
}
