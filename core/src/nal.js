/**
 * AnnexB ↔ AVCC NAL 单元格式互转。
 *
 * - AnnexB（H.264/H.265 裸流）：起始码 00 00 01 或 00 00 00 01 分隔 NAL 单元。
 *   用途：TS/FLV/裸 .h264 文件、WebCodecs `avc.format: 'annexb'`。
 * - AVCC / length-prefixed：每单元前有 N 字节长度（通常 4，即 avcC 的 lengthSizeMinusOne+1）。
 *   用途：MP4 样本、MSE fMP4。
 */
import { parseError } from './errors.js';

/** H.264 NAL 类型（nal_unit_type = 第 1 字节低 5 位） */
export function h264NalType(nalu) {
  return nalu.length > 0 ? nalu[0] & 0x1f : -1;
}

/** H.265 NAL 类型（第 1 字节 bit6 + 第 2 字节高 2 位，共 6 位） */
export function hevcNalType(nalu) {
  if (nalu.length < 2) return -1;
  return ((nalu[0] & 0x7e) >> 1) & 0x3f;
}

/** H.264 IDR 帧（type=5）或参数集之外的帧内片 */
export function isH264Idr(nalu) {
  return h264NalType(nalu) === 5;
}

/** H.265 IRAP 帧（16~23，含 BLA/IDR/CRA）视为关键帧 */
export function isHevcIrap(nalu) {
  const t = hevcNalType(nalu);
  return t >= 16 && t <= 23;
}

/**
 * 去除 emulation prevention bytes（00 00 03 → 00 00），得到 RBSP。
 * @param {Uint8Array} nalu 不含起始码
 */
export function removeEmulationPrevention(nalu) {
  const out = new Uint8Array(nalu.byteLength);
  let len = 0;
  let zeros = 0;
  for (let i = 0; i < nalu.byteLength; i++) {
    const b = nalu[i];
    if (zeros === 2 && b === 0x03 && i + 1 < nalu.byteLength && (nalu[i + 1] & 0xfc) === 0) {
      // 丢弃 EPB；仅当后续两比特为 0（防止误伤真正的 000003 数据）
      zeros = 0;
      continue;
    }
    out[len++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, len);
}

/**
 * 为 RBSP 加回 emulation prevention bytes（写 SPS/PPS 时使用）。
 */
export function addEmulationPrevention(rbsp) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.byteLength; i++) {
    const b = rbsp[i];
    if (zeros === 2 && b <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/**
 * 扫描 AnnexB 流中的全部 NAL 单元。
 * @param {Uint8Array} data
 * @returns {{offset:number, size:number}[]} 每个单元的载荷区间（不含起始码）
 */
export function scanAnnexBNalUnits(data) {
  const units = [];
  let i = 0;
  let currentStart = -1;
  while (i + 2 < data.byteLength) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // 命中 3 字节起始码；若是 4 字节码（前置多一个 0），闭合上一单元时会把
      // 归属起始码的前导零剔除。
      if (currentStart >= 0) {
        let end = i;
        while (end > currentStart && data[end - 1] === 0) end -= 1;
        units.push({ offset: currentStart, size: end - currentStart });
      }
      currentStart = i + 3;
      i += 3;
      continue;
    }
    i += 1;
  }
  if (currentStart >= 0) {
    units.push({ offset: currentStart, size: data.byteLength - currentStart });
  }
  if (units.some((u) => u.size <= 0)) {
    throw parseError('invalid annex-b stream: empty nal unit');
  }
  return units;
}

/** AnnexB → NAL 单元视图数组（零拷贝切片） */
export function splitAnnexB(data) {
  return scanAnnexBNalUnits(data).map(({ offset, size }) => data.subarray(offset, offset + size));
}

/**
 * AnnexB → AVCC（length-prefixed）。输出为新分配的连续缓冲。
 * @param {Uint8Array} annexb
 * @param {number} [lengthSize] 长度字段字节数（1~4，默认 4）
 */
export function annexbToAvcc(annexb, lengthSize = 4) {
  if (lengthSize < 1 || lengthSize > 4) {
    throw parseError(`invalid nal length size: ${lengthSize}`);
  }
  const units = scanAnnexBNalUnits(annexb);
  let total = 0;
  for (const u of units) total += lengthSize + u.size;

  const out = new Uint8Array(total);
  let pos = 0;
  for (const u of units) {
    let size = u.size;
    for (let k = lengthSize - 1; k >= 0; k--) {
      out[pos + k] = size & 0xff;
      size >>>= 8;
    }
    pos += lengthSize;
    out.set(annexb.subarray(u.offset, u.offset + u.size), pos);
    pos += u.size;
  }
  return out;
}

/**
 * AVCC → NAL 单元视图数组。
 * @param {Uint8Array} avccData
 * @param {number} [lengthSize]
 */
export function splitAvcc(avccData, lengthSize = 4) {
  if (lengthSize < 1 || lengthSize > 4) {
    throw parseError(`invalid nal length size: ${lengthSize}`);
  }
  const units = [];
  let pos = 0;
  while (pos + lengthSize <= avccData.byteLength) {
    let size = 0;
    for (let k = 0; k < lengthSize; k++) {
      size = size * 256 + avccData[pos + k];
    }
    pos += lengthSize;
    if (size === 0 || pos + size > avccData.byteLength) {
      throw parseError(`corrupt avcc stream at ${pos}: size=${size}`);
    }
    units.push(avccData.subarray(pos, pos + size));
    pos += size;
  }
  if (pos !== avccData.byteLength) {
    throw parseError(`trailing garbage in avcc stream: ${avccData.byteLength - pos} bytes`);
  }
  return units;
}

/** AVCC → AnnexB（WebCodecs annexb 输出、调试 dump 用） */
export function avccToAnnexb(avccData, lengthSize = 4, longStartCode = true) {
  const units = splitAvcc(avccData, lengthSize);
  const scLen = longStartCode ? 4 : 3;
  let total = 0;
  for (const u of units) total += scLen + u.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const u of units) {
    if (longStartCode) out.set([0, 0, 0, 1], pos);
    else out.set([0, 0, 1], pos);
    pos += scLen;
    out.set(u, pos);
    pos += u.byteLength;
  }
  return out;
}
