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

/** 四字符 tag 转 ASCII */
export function boxType(buf, off) {
  return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
}

/**
 * 读单个 box 头。
 * @returns {{type:string,size:number,headerSize:number}|null} size 含头；null 表示数据不足
 */
export function readBoxHeader(buf, off = 0) {
  if (buf.length < off + 8) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = dv.getUint32(off);
  const type = boxType(buf, off);
  let headerSize = 8;
  if (size === 1) {
    // largesize：64 位
    if (buf.length < off + 16) return null;
    size = Number(dv.getBigUint64(off + 8));
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
export function parsePrft(buf, contentStart) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { version } = readVersionFlags(buf, contentStart);
  let p = contentStart + 4;
  const referenceTrackId = dv.getUint32(p); p += 4;
  const referenceTimescale = dv.getUint32(p); p += 4;
  if (version === 1) {
    const producerTime = Number(dv.getBigUint64(p)); p += 8;
    const mediaTime = Number(dv.getBigUint64(p));
    return { referenceTrackId, referenceTimescale, mediaTimeTicks: mediaTime, producerTimeTicks: producerTime };
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
  const { version } = readVersionFlags(buf, contentStart);
  let p = contentStart + 4;
  const referenceId = dv.getUint32(p); p += 4;
  const timescale = dv.getUint32(p); p += 4;
  let ept;
  let firstOffset;
  if (version === 1) {
    ept = Number(dv.getBigUint64(p)); p += 8;
    firstOffset = Number(dv.getBigUint64(p)); p += 8;
  } else {
    ept = dv.getUint32(p); p += 4;
    firstOffset = dv.getUint32(p); p += 4;
  }
  p += 2; // reserved
  const referenceCount = dv.getUint16(p); p += 2;
  /** @type {Array<object>} */
  const references = [];
  for (let i = 0; i < referenceCount && p + 12 <= contentEnd; i++) {
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
  const { version, flags } = readVersionFlags(buf, contentStart);
  let p = contentStart + 4;
  const sampleCount = dv.getUint32(p); p += 4;
  const hasDataOffset = !!(flags & 0x000001);
  const hasDuration = !!(flags & 0x000100);
  const hasSize = !!(flags & 0x000200);
  const hasFlags = !!(flags & 0x000400);
  const hasCts = !!(flags & 0x000800);
  let dataOffset = 0;
  if (hasDataOffset) {
    dataOffset = dv.getInt32(p); p += 4;
  }
  // first_sample_flags 存在时不计入每行字段（仅覆盖首样本标志）
  const hasFirstSampleFlags = !!(flags & 0x000004);

  const rows = [];
  for (let i = 0; i < sampleCount; i++) {
    const row = { duration: 0, size: 0, flags: 0, cts: 0 };
    if (hasDuration) { row.duration = dv.getUint32(p); p += 4; }
    if (hasSize) { row.size = dv.getUint32(p); p += 4; }
    if (hasFlags) { row.flags = dv.getUint32(p); p += 4; }
    else if (i === 0 && hasFirstSampleFlags) { /* 首样本标志单独处理 */ }
    if (hasCts) {
      row.cts = version === 0 ? dv.getUint32(p) : dv.getInt32(p);
      p += 4;
    }
    rows.push(row);
  }
  return { sampleCount, dataOffset, rows };
}

/** 解析 tfdt → baseMediaDecodeTime */
export function parseTfdt(buf, contentStart) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { version } = readVersionFlags(buf, contentStart);
  if (version === 1) return Number(dv.getBigUint64(contentStart + 4));
  return dv.getUint32(contentStart + 4);
}

/** 解析 tfhd → {trackId, defaultSampleDuration, defaultSampleSize, defaultSampleFlags, baseDataOffset} */
export function parseTfhd(buf, contentStart, contentEnd) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { flags } = readVersionFlags(buf, contentStart);
  let p = contentStart + 4;
  const out = {
    trackId: dv.getUint32(p),
    baseDataOffset: null,
    defaultSampleDuration: null,
    defaultSampleSize: null,
    defaultSampleFlags: null,
  };
  p += 4;
  if (flags & 0x000001) { out.baseDataOffset = Number(dv.getBigUint64(p)); p += 8; }
  if (flags & 0x000002) p += 4; // sample_description_index
  if (flags & 0x000008) { out.defaultSampleDuration = dv.getUint32(p); p += 4; }
  if (flags & 0x000010) { out.defaultSampleSize = dv.getUint32(p); p += 4; }
  if (flags & 0x000020) { out.defaultSampleFlags = dv.getUint32(p); p += 4; }
  void contentEnd;
  return out;
}

/** 解析 mfhd → sequenceNumber */
export function parseMfhd(buf, contentStart) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
    const info = { trackId: 0, baseTime: 0, trun: null, defaults: {} };
    for (const sub of iterateBoxes(buf, traf.contentStart, traf.contentEnd)) {
      if (sub.type === 'tfhd') {
        const tfhd = parseTfhd(buf, sub.contentStart, sub.contentEnd);
        info.trackId = tfhd.trackId;
        info.defaults = tfhd;
      } else if (sub.type === 'tfdt') {
        info.baseTime = parseTfdt(buf, sub.contentStart);
      } else if (sub.type === 'trun') {
        info.trun = parseTrun(buf, sub.contentStart, sub.contentEnd);
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
  const top = [...iterateBoxes(initSegment)];
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const stsdPos = findTagInBuf(initSegment, moov.contentStart, moov.contentEnd, 'stsd');
  if (stsdPos < 0) return null;
  // stsd 内容里第一个样本描述项即 entryType（avc1/hev1/hvc1/av01/vp09…）
  const entryTypes = ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'];
  for (const t of entryTypes) {
    const pos = findTagInBuf(initSegment, stsdPos, moov.contentEnd, t);
    if (pos >= 0) {
      // 在 entry 内找配置 box
      for (const cfgTag of ['avcC', 'hvcC', 'dvcC', 'vpcC']) {
        const cfgPos = findTagInBuf(initSegment, pos, moov.contentEnd, cfgTag);
        if (cfgPos >= 0) {
          const dv = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
          const boxSize = dv.getUint32(cfgPos - 4); // box 头中的尺寸字段
          return {
            entryType: t,
            fourcc: cfgTag,
            // 只取 box 内容（不含 8 字节头），与 WebCodecs VideoDecoderConfig.description 对齐
            description: initSegment.slice(cfgPos + 4, cfgPos + boxSize),
          };
        }
      }
      return { entryType: t, fourcc: null, description: null };
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
 * 策略：定位 esds 后扫描 0x05（DSI tag）+ 变长长度。
 */
export function findAudioSpecificConfig(initSegment) {
  const pos = findTagInBuf(initSegment, 0, initSegment.length, 'esds');
  if (pos < 0) return null;
  const end = Math.min(initSegment.length, pos + 512);
  for (let i = pos; i < end - 1; i++) {
    if (initSegment[i] === 0x05) {
      // 变长长度
      let len = 0;
      let j = i + 1;
      for (; j < end; j++) {
        len = (len << 7) | (initSegment[j] & 0x7f);
        if (!(initSegment[j] & 0x80)) break;
      }
      if (len > 0 && len < 32) {
        return initSegment.slice(j + 1, j + 1 + len);
      }
    }
  }
  return null;
}
