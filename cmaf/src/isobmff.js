/**
 * isobmff.js —— 面向 CMAF 的最小 ISO-BMFF 解析件
 *
 * 范围（刻意收敛，避免与 mp4/ 全量解析器重复）：
 *  - box 树遍历（含 64-bit largesize）；
 *  - CMAF 关键路径：ftyp/styp、moov(trak/mdia/minf/stbl/stsd)、
 *    moof(mfhd/traf(tfhd/tfdt/trun))、mdat、sidx(索引头信息)、prft/emsg；
 *  - 从 stsd 提取解码配置（avcC/hvcC/dvcC/vpcC 原始字节、esds 内的 ASC）。
 *
 * 【契约对齐说明】docs/CONTRACTS.md §12.2 为本模块预留了"ISO-BMFF 复用意见"
 * 槽位：建议把 box 遍历器与 sample table 逻辑沉淀为 core/src/isobmff-*，
 * cmaf 以 sidx/styp 扩展复用，mp4 复用同一遍历件。本文件即按该方向的
 * 过渡实现——待 core 沉淀后迁移，接口保持稳定。
 */

import { notSupported } from '../../core/src/errors.js';
import { DEFAULT_MAX_TRUN_SAMPLES } from '../../core/src/limits.js';

/** 四字符 tag 转 ASCII */
export function boxType(buf, off) {
  return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
}

/**
 * 读单个 box 头。
 * @returns {{type:string,size:number,headerSize:number}|null} size 含头；null 表示数据不足
 */
export function readBoxHeader(buf, off = 0) {
  if (!Number.isSafeInteger(off) || off < 0) throw notSupported(`ISO-BMFF box 偏移非法: ${off}`);
  if (off > buf.length || buf.length - off < 8) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = dv.getUint32(off);
  const type = boxType(buf, off);
  let headerSize = 8;
  if (size === 1) {
    // largesize：64 位
    if (buf.length < off + 16) return null;
    const largeSize = dv.getBigUint64(off + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw notSupported(`ISO-BMFF box 尺寸超出安全范围: ${type}`);
    size = Number(largeSize);
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - off; // 到文件尾
  }
  if (size < headerSize) throw notSupported(`ISO-BMFF box 尺寸非法: ${type} size=${size}`);
  return { type, size, headerSize };
}

/**
 * 浅层迭代某缓冲内的顶层 box。
 * @param {Uint8Array} buf
 * @param {number} [start]
 * @param {number} [end]
 * @yields {{type:string,size:number,contentStart:number,contentEnd:number}}
 */
export function* iterateBoxes(buf, start = 0, end = buf.length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > buf.length) {
    throw notSupported(`ISO-BMFF box 范围非法: ${start}..${end}`);
  }
  let off = start;
  while (off < end) {
    const head = readBoxHeader(buf, off);
    if (!head || off + head.size > end) {
      // 数据不完整或被截断：交由上层决定是否等待更多数据
      return;
    }
    yield {
      type: head.type,
      size: head.size,
      boxStart: off,
      headerSize: head.headerSize,
      contentStart: off + head.headerSize,
      contentEnd: off + head.size,
    };
    off += head.size;
  }
}

/**
 * 解析 prft（Producer Reference Time，ISO 14496-12 §8.16.5）—— LL 方向的
 * 生产者时钟参考。timestamp 域为 reference_track_timescale 的 ticks，
 * µs 换算由调用方按轨 timescale 进行（契约 §0.5）。
 * @returns {{referenceTrackId:number, referenceTimescale:number,
 *            mediaTimeTicks:number, producerTimeTicks:number}}
 */
export function parsePrft(buf, contentStart, contentEnd = buf.byteLength) {
  if (!Number.isSafeInteger(contentStart) || contentStart < 0 ||
      !Number.isSafeInteger(contentEnd) || contentEnd < contentStart || contentEnd > buf.byteLength) {
    throw notSupported(`PRFT 内容边界非法: ${contentStart}..${contentEnd}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (contentStart + 12 > contentEnd) throw notSupported('PRFT 头部截断');
  const { version } = readVersionFlags(buf, contentStart);
  if (version !== 0 && version !== 1) throw notSupported(`PRFT version 不支持: ${version}`);
  let p = contentStart + 4;
  const referenceTrackId = dv.getUint32(p); p += 4;
  const referenceTimescale = dv.getUint32(p); p += 4;
  if (!referenceTimescale) throw notSupported('PRFT timescale 非法');
  const payloadBytes = version === 1 ? 16 : 8;
  if (p + payloadBytes > contentEnd) {
    throw notSupported(`PRFT v${version} 内容截断`);
  }
  if (version === 1) {
    const producerTimeNtp = dv.getBigUint64(p); p += 8;
    const mediaTime = dv.getBigUint64(p);
    if (mediaTime > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw notSupported(`PRFT media_time 超出安全整数范围: ${mediaTime}`);
    }
    return {
      referenceTrackId,
      referenceTimescale,
      mediaTimeTicks: Number(mediaTime),
      producerTimeNtp,
      // Backward-compatible numeric view; use producerTimeNtp for lossless fixed-point time.
      producerTimeTicks: Number(producerTimeNtp),
    };
  }
  const producerTime = dv.getUint32(p); p += 4;
  const mediaTime = dv.getUint32(p);
  return { referenceTrackId, referenceTimescale, mediaTimeTicks: mediaTime, producerTimeTicks: producerTime };
}

/** 在 box 列表中找指定类型（首个） */
export function findBox(buf, start, end, type) {
  for (const b of iterateBoxes(buf, start, end)) {
    if (b.type === type) return b;
  }
  return null;
}

/**
 * 解析 sidx（Segment Index，ISO 14496-12 §8.16.3）—— CMAF 分段寻址索引。
 * @returns {{referenceId:number, timescale:number,
 *            earliestPresentationTimeTicks:number, firstOffset:number,
 *            references:Array<{referenceType:number,size:number,
 *                              durationTicks:number,startsWithSAP:boolean,sapType:number}>}}
 */
export function parseSidx(buf, contentStart, contentEnd) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!Number.isSafeInteger(contentStart) || contentStart < 0 ||
      !Number.isSafeInteger(contentEnd) || contentEnd < contentStart || contentEnd > buf.byteLength) {
    throw notSupported(`sidx 内容边界非法: ${contentStart}..${contentEnd}`);
  }
  if (contentStart + 4 > contentEnd) throw notSupported('sidx fullbox header 被截断');
  const { version, flags } = readVersionFlags(buf, contentStart);
  if (version !== 0 && version !== 1) throw notSupported(`sidx version 不支持: ${version}`);
  if (flags !== 0) throw notSupported(`sidx flags 不支持: ${flags}`);
  let p = contentStart + 4;
  const requireBytes = (count, field) => {
    if (p + count > contentEnd) throw notSupported(`sidx ${field} 字段被截断`);
  };
  requireBytes(8, 'reference_ID/timescale');
  const referenceId = dv.getUint32(p); p += 4;
  const timescale = dv.getUint32(p); p += 4;
  if (timescale === 0) throw notSupported('sidx timescale 非法');
  let ept;
  let firstOffset;
  if (version === 1) {
    requireBytes(16, 'earliest_presentation_time/first_offset');
    const eptBig = dv.getBigUint64(p); p += 8;
    const offsetBig = dv.getBigUint64(p); p += 8;
    if (eptBig > BigInt(Number.MAX_SAFE_INTEGER) || offsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw notSupported('sidx 64 位时间或偏移超出安全整数范围');
    }
    ept = Number(eptBig);
    firstOffset = Number(offsetBig);
  } else {
    requireBytes(8, 'earliest_presentation_time/first_offset');
    ept = dv.getUint32(p); p += 4;
    firstOffset = dv.getUint32(p); p += 4;
  }
  requireBytes(4, 'reserved/reference_count');
  p += 2; // reserved
  const referenceCount = dv.getUint16(p); p += 2;
  requireBytes(referenceCount * 12, 'references');
  /** @type {Array<object>} */
  const references = [];
  for (let i = 0; i < referenceCount; i++) {
    const refWord = dv.getUint32(p); p += 4;
    const duration = dv.getUint32(p); p += 4;
    const sapWord = dv.getUint32(p); p += 4;
    references.push({
      referenceType: (refWord >>> 31) & 1,
      size: refWord & 0x7fffffff,
      durationTicks: duration,
      startsWithSAP: ((sapWord >>> 31) & 1) === 1,
      sapType: (sapWord >>> 28) & 0x07,
    });
  }
  void ept; // earliest_presentation_time 以 ticks 返回，µs 换算由调用方按 timescale 进行
  return {
    referenceId,
    timescale,
    earliestPresentationTimeTicks: ept,
    firstOffset,
    references,
  };
}

/* ------------------------------------------------------------------ */
/* fullBox version/flags                                               */
/* ------------------------------------------------------------------ */

function readVersionFlags(buf, contentStart) {
  const v = buf[contentStart];
  const flags = (buf[contentStart + 1] << 16) | (buf[contentStart + 2] << 8) | buf[contentStart + 3];
  return { version: v, flags };
}

/* ------------------------------------------------------------------ */
/* 结构化解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解析 trun（样本表）。
 * @returns {{sampleCount:number,dataOffset:number,
 *            rows:Array<{duration:number,size:number,flags:number,cts:number}>}}
 */
export function parseTrun(buf, contentStart, contentEnd) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const requireBytes = (count, field) => {
    if (p + count > contentEnd) throw notSupported(`trun ${field} 字段被截断`);
  };
  let p = contentStart;
  requireBytes(4, 'fullbox header');
  const { version, flags } = readVersionFlags(buf, contentStart);
  if (version !== 0 && version !== 1) throw notSupported(`trun version 不支持: ${version}`);
  p += 4;
  requireBytes(4, 'sample_count');
  const sampleCount = dv.getUint32(p); p += 4;
  const hasDataOffset = !!(flags & 0x000001);
  const hasDuration = !!(flags & 0x000100);
  const hasSize = !!(flags & 0x000200);
  const hasFlags = !!(flags & 0x000400);
  const hasCts = !!(flags & 0x000800);
  let dataOffset = 0;
  if (hasDataOffset) {
    requireBytes(4, 'data_offset');
    dataOffset = dv.getInt32(p); p += 4;
  }
  // first-sample-flags-present（0x000004）：data_offset 之后、样本行之前还有
  // 一个 4 字节 first_sample_flags，它不属于任何样本行。此前未消费，导致
  // 所有样本行整体错位 4 字节（首行 duration 被读成 first_sample_flags）。
  const hasFirstSampleFlags = !!(flags & 0x000004);
  let firstSampleFlags = null;
  if (hasFirstSampleFlags) {
    requireBytes(4, 'first_sample_flags');
    firstSampleFlags = dv.getUint32(p);
    p += 4;
  }

  const rows = [];
  // 敌意 sample_count 防御：限制无逐样本字段时的隐式行数，并要求有逐样本
  // 字段时每个声明行都完整存在于 trun box 内。不能静默截断，否则样本会丢失且
  // 后续 tfdt/轨道时间轴表面正常但实际不完整。
  const perSampleBytes =
    (hasDuration ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCts ? 4 : 0);
  const maxByBytes = perSampleBytes > 0
    ? Math.min(DEFAULT_MAX_TRUN_SAMPLES, Math.floor((contentEnd - p) / perSampleBytes))
    : DEFAULT_MAX_TRUN_SAMPLES;
  if (sampleCount > maxByBytes) {
    throw notSupported(`trun sample_count 超出安全范围或完整样本行不足: count=${sampleCount}, max=${maxByBytes}`);
  }
  const rowCount = sampleCount;
  for (let i = 0; i < rowCount; i++) {
    const row = { duration: 0, size: 0, flags: 0, cts: 0 };
    if (hasDuration) { row.duration = dv.getUint32(p); p += 4; }
    if (hasSize) { row.size = dv.getUint32(p); p += 4; }
    if (hasFlags) { row.flags = dv.getUint32(p); p += 4; }
    else if (i === 0 && firstSampleFlags !== null) {
      // sample-flags 不存在时首样本标志取 first_sample_flags
      row.flags = firstSampleFlags;
    }
    if (hasCts) {
      row.cts = version === 0 ? dv.getUint32(p) : dv.getInt32(p);
      p += 4;
    }
    rows.push(row);
  }
  return { sampleCount, dataOffset, hasDataOffset, hasDuration, hasSize, hasFlags, hasCts, firstSampleFlags, rows };
}

/** 解析 tfdt → baseMediaDecodeTime */
export function parseTfdt(buf, contentStart, contentEnd = buf.byteLength) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (contentStart + 4 > contentEnd) throw notSupported('tfdt fullbox header 被截断');
  const { version } = readVersionFlags(buf, contentStart);
  if (version !== 0 && version !== 1) throw notSupported('tfdt version 不支持: ' + version);
  const timeBytes = version === 1 ? 8 : 4;
  if (contentStart + 4 + timeBytes > contentEnd) throw notSupported('tfdt baseMediaDecodeTime 字段被截断');
  if (version === 1) {
    const ticks = dv.getBigUint64(contentStart + 4);
    if (ticks > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw notSupported(`tfdt baseMediaDecodeTime 超出安全整数范围: ${ticks}`);
    }
    return Number(ticks);
  }
  return dv.getUint32(contentStart + 4);
}

/** 解析 tfhd → {trackId, defaultSampleDuration, defaultSampleSize, defaultSampleFlags, baseDataOffset} */
export function parseTfhd(buf, contentStart, contentEnd) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (contentStart + 4 > contentEnd) throw notSupported('tfhd fullbox header 被截断');
  const { version, flags } = readVersionFlags(buf, contentStart);
  if (version !== 0) throw notSupported(`tfhd version 不支持: ${version}`);
  let p = contentStart + 4;
  const requireBytes = (count, field) => {
    if (p + count > contentEnd) throw notSupported(`tfhd ${field} 字段被截断`);
  };
  requireBytes(4, 'track_ID');
  const out = {
    trackId: dv.getUint32(p),
    baseDataOffset: null,
    defaultSampleDuration: null,
    defaultSampleSize: null,
    defaultSampleFlags: null,
  };
  p += 4;
  if (flags & 0x000001) {
    requireBytes(8, 'base_data_offset');
    const offset = dv.getBigUint64(p);
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw notSupported(`tfhd base_data_offset 超出安全整数范围: ${offset}`);
    out.baseDataOffset = Number(offset);
    p += 8;
  }
  if (flags & 0x000002) { requireBytes(4, 'sample_description_index'); p += 4; }
  if (flags & 0x000008) { requireBytes(4, 'default_sample_duration'); out.defaultSampleDuration = dv.getUint32(p); p += 4; }
  if (flags & 0x000010) { requireBytes(4, 'default_sample_size'); out.defaultSampleSize = dv.getUint32(p); p += 4; }
  if (flags & 0x000020) { requireBytes(4, 'default_sample_flags'); out.defaultSampleFlags = dv.getUint32(p); p += 4; }
  return out;
}

/** 解析 mfhd → sequenceNumber */
export function parseMfhd(buf, contentStart, contentEnd = buf.byteLength) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (contentStart + 8 > contentEnd) throw notSupported('mfhd fullbox header/sequence_number 字段被截断');
  const { version } = readVersionFlags(buf, contentStart);
  if (version !== 0) throw notSupported('mfhd version 不支持: ' + version);
  return dv.getUint32(contentStart + 4);
}

/**
 * 解析一个 movie fragment（moof）：可能含多 traf，这里取全部轨。
 * @returns {Array<{trackId:number, baseTime:number, trun:Object, defaults:Object}>}
 */
export function parseMoof(buf, contentStart, contentEnd) {
  const trafs = [];
  for (const traf of iterateBoxes(buf, contentStart, contentEnd)) {
    if (traf.type !== 'traf') continue;
    const info = { trackId: 0, baseTime: 0, trun: null, truns: [], defaults: {} };
    for (const sub of iterateBoxes(buf, traf.contentStart, traf.contentEnd)) {
      if (sub.type === 'tfhd') {
        const tfhd = parseTfhd(buf, sub.contentStart, sub.contentEnd);
        info.trackId = tfhd.trackId;
        info.defaults = tfhd;
      } else if (sub.type === 'tfdt') {
        info.baseTime = parseTfdt(buf, sub.contentStart, sub.contentEnd);
      } else if (sub.type === 'trun') {
        const parsed = parseTrun(buf, sub.contentStart, sub.contentEnd);
        info.truns.push(parsed);
        info.trun = parsed; // compatibility: retain the last-run alias
      }
    }
    if (info.trun) trafs.push(info);
  }
  return trafs;
}

/** 判断 sample flags 是否关键帧（ISO 14496-12 §8.8.3.1） */
export function isKeyframeFlag(flags) {
  const dependsOn = (flags >> 24) & 0x03;
  const nonSync = (flags >> 16) & 0x01;
  return dependsOn === 2 || nonSync === 0;
}

/**
 * 从 stsd 提取视频解码配置（avcC/hvcC/dvcC/vpcC）。
 * @returns {{entryType:string, fourcc:string, description:Uint8Array|null}|null}
 */
export function findVideoDecoderConfig(initSegment) {
  const moov = [...iterateBoxes(initSegment)].find((box) => box.type === 'moov');
  if (!moov) return null;
  const entryTypes = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09']);
  const configTypes = new Set(['avcC', 'hvcC', 'dvcC', 'vpcC']);
  const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);

  for (const trak of iterateBoxes(initSegment, moov.contentStart, moov.contentEnd)) {
    if (trak.type !== 'trak') continue;
    for (const mdia of iterateBoxes(initSegment, trak.contentStart, trak.contentEnd)) {
      if (mdia.type !== 'mdia') continue;
      for (const minf of iterateBoxes(initSegment, mdia.contentStart, mdia.contentEnd)) {
        if (minf.type !== 'minf') continue;
        for (const stbl of iterateBoxes(initSegment, minf.contentStart, minf.contentEnd)) {
          if (stbl.type !== 'stbl') continue;
          for (const stsd of iterateBoxes(initSegment, stbl.contentStart, stbl.contentEnd)) {
            if (stsd.type !== 'stsd' || stsd.contentStart + 8 > stsd.contentEnd) continue;
            const entryCount = view.getUint32(stsd.contentStart + 4);
            const entriesStart = stsd.contentStart + 8;
            let entryIndex = 0;
            for (const entry of iterateBoxes(initSegment, entriesStart, stsd.contentEnd)) {
              if (entryIndex++ >= entryCount) break;
              if (!entryTypes.has(entry.type)) continue;
              const childStart = entry.contentStart + 78; // VisualSampleEntry fixed fields
              if (childStart > entry.contentEnd) return null;
              const children = [...iterateBoxes(initSegment, childStart, entry.contentEnd)];
              const parsedEnd = children.length ? children[children.length - 1].contentEnd : childStart;
              if (parsedEnd !== entry.contentEnd) return null;
              const foundConfig = children.find((child) => configTypes.has(child.type)) ?? null;
              if (foundConfig) {
                return {
                  entryType: entry.type,
                  fourcc: foundConfig.type,
                  description: initSegment.slice(foundConfig.contentStart, foundConfig.contentEnd),
                };
              }
              return { entryType: entry.type, fourcc: null, description: null };
            }
          }
        }
      }
    }
  }
  return null;
}

/** 在 [start,end) 中搜索四字符标签位置（返回 type 字段起点） */
export function findTagInBuf(buf, start, end, tag) {
  for (let i = start; i + 4 <= Math.min(end, buf.length); i++) {
    if (
      buf[i] === tag.charCodeAt(0) &&
      buf[i + 1] === tag.charCodeAt(1) &&
      buf[i + 2] === tag.charCodeAt(2) &&
      buf[i + 3] === tag.charCodeAt(3)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * 提取 esds 内嵌的 AudioSpecificConfig（ASC）。
 * 只从 ES_Descriptor / DecoderConfigDescriptor 的嵌套结构读取 DSI。
 */
function findMp4aEsds(buf, moov) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (const trak of iterateBoxes(buf, moov.contentStart, moov.contentEnd)) {
    if (trak.type !== 'trak') continue;
    for (const mdia of iterateBoxes(buf, trak.contentStart, trak.contentEnd)) {
      if (mdia.type !== 'mdia') continue;
      for (const minf of iterateBoxes(buf, mdia.contentStart, mdia.contentEnd)) {
        if (minf.type !== 'minf') continue;
        for (const stbl of iterateBoxes(buf, minf.contentStart, minf.contentEnd)) {
          if (stbl.type !== 'stbl') continue;
          for (const stsd of iterateBoxes(buf, stbl.contentStart, stbl.contentEnd)) {
            if (stsd.type !== 'stsd' || stsd.contentStart + 8 > stsd.contentEnd) continue;
            const entryCount = view.getUint32(stsd.contentStart + 4);
            let pos = stsd.contentStart + 8;
            for (let i = 0; i < entryCount && pos + 8 <= stsd.contentEnd; i++) {
              const size = view.getUint32(pos);
              const type = boxType(buf, pos);
              const headerSize = size === 1 ? 16 : 8;
              if (size < headerSize || pos + size > stsd.contentEnd) break;
              if (type === 'mp4a') {
                // AudioSampleEntry v0 has a 28-byte body prefix; v1 adds 16 bytes before child boxes.
                const entryContent = pos + headerSize;
                const entryEnd = pos + size;
                if (entryContent + 10 > entryEnd) break;
                const soundVersion = view.getUint16(entryContent + 8);
                const prefixSize = soundVersion === 0 ? 28 : soundVersion === 1 ? 44 : null;
                if (prefixSize === null || entryContent + prefixSize > entryEnd) break;
                const childStart = entryContent + prefixSize;
                for (const child of iterateBoxes(buf, childStart, entryEnd)) {
                  if (child.type === 'esds') return child;
                }
              }
              pos += size;
            }
          }
        }
      }
    }
  }
  return null;
}
export function findAudioSpecificConfig(initSegment) {
  const topBoxes = [...iterateBoxes(initSegment)];
  const moov = topBoxes.find((box) => box.type === 'moov');
  // In a real init segment, only accept esds as a child of an mp4a sample entry.
  // Keep compatibility for callers passing a standalone top-level esds box.
  const esdsBox = moov ? findMp4aEsds(initSegment, moov) : topBoxes.find((box) => box.type === 'esds');
  if (!esdsBox) return null;
  const boxEnd = esdsBox.contentEnd;
  if (esdsBox.contentStart + 4 > boxEnd) return null;
  const version = initSegment[esdsBox.contentStart];
  const fullBoxFlags = (initSegment[esdsBox.contentStart + 1] << 16) |
    (initSegment[esdsBox.contentStart + 2] << 8) | initSegment[esdsBox.contentStart + 3];
  if (version !== 0 || fullBoxFlags !== 0) return null;
  const descriptorStart = esdsBox.contentStart + 4; // skip validated esds FullBox version/flags
  const end = Math.min(boxEnd, descriptorStart + 512);
  const es = readDescriptor(initSegment, descriptorStart, end);
  if (!es || es.tag !== 0x03 || es.end !== boxEnd) return null;
  let childStart = es.payloadStart;
  if (childStart + 3 > es.end) return null;
  const flags = initSegment[childStart + 2];
  childStart += 3; // ES_ID and flags
  if (flags & 0x80) childStart += 2;
  if (flags & 0x40) {
    if (childStart >= es.end) return null;
    childStart += 1 + initSegment[childStart];
  }
  if (flags & 0x20) childStart += 2;
  if (childStart > es.end) return null;

  while (childStart < es.end) {
    const child = readDescriptor(initSegment, childStart, es.end);
    if (!child || child.end <= childStart) return null;
    if (child.tag === 0x04) {
      if (child.payloadStart + 13 > child.end) return null;
      const objectTypeIndication = initSegment[child.payloadStart];
      const streamTypeAndFlags = initSegment[child.payloadStart + 1];
      const streamType = streamTypeAndFlags >>> 2;
      const isAacObjectType = objectTypeIndication === 0x40 ||
        objectTypeIndication === 0x66 || objectTypeIndication === 0x67 ||
        objectTypeIndication === 0x68 || objectTypeIndication === 0x69;
      if (!isAacObjectType || streamType !== 5 || !(streamTypeAndFlags & 1)) return null;
      const decoderDataStart = child.payloadStart + 13;
      let descriptorStart = decoderDataStart;
      let decoderSpecificInfo = null;
      while (descriptorStart < child.end) {
        const descriptor = readDescriptor(initSegment, descriptorStart, child.end);
        if (!descriptor || descriptor.end <= descriptorStart) return null;
        if (descriptor.tag === 0x05 && descriptor.end > descriptor.payloadStart) {
          decoderSpecificInfo = initSegment.slice(descriptor.payloadStart, descriptor.end);
        }
        descriptorStart = descriptor.end;
      }
      if (decoderSpecificInfo) return decoderSpecificInfo;
      return null;
    }
    childStart = child.end;
  }
  return null;
}

function readDescriptor(bytes, start, limit) {
  if (start + 2 > limit) return null;
  const tag = bytes[start];
  let length = 0;
  let cursor = start + 1;
  let complete = false;
  for (let count = 0; count < 4 && cursor < limit; count++) {
    const byte = bytes[cursor++];
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) {
      complete = true;
      break;
    }
  }
  const payloadStart = cursor;
  const end = payloadStart + length;
  if (!complete || end > limit) return null;
  return { tag, payloadStart, end };
}
