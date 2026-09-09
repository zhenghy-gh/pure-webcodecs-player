/**
 * codec-info.js —— AVC/HEVC 解码配置记录（avcC / hvcC）解析
 *
 * 从 FLV 序列头中拿到的 avcC / hvcC 里提取：
 *   SPS/PPS(/VPS)、分辨率（尽力解析）等参数。
 * 注意：codec string 的生成已按 CONTRACTS v0.2 §3 收敛到 core/src/codec-string.js，
 * 本文件不再自行拼串（原 codecString 字段移除）。
 * SPS 宽高解析逻辑与 ts/src/nalu.js 同源（两模块刻意零依赖，保持独立可拷贝；
 * 若后续 architect 抽取 core/ 公共层，可合并）。
 */

import { BitReader } from './bits-lite.js';

/**
 * 解析 AVCDecoderConfigurationRecord。
 * @param {Uint8Array} avcC
 * @returns {{ profile:number, compat:number, level:number, naluLengthSize:number,
 *             spsList:Uint8Array[], ppsList:Uint8Array[],
 *             width:number|null, height:number|null }}
 */
export function parseAvcConfig(avcC) {
  if (!avcC || avcC.length < 7 || avcC[0] !== 1) throw new Error('非法 avcC');
  const profile = avcC[1];
  const compat = avcC[2];
  const level = avcC[3];
  const naluLengthSize = (avcC[4] & 0x03) + 1;
  const numOfSps = avcC[5] & 0x1f;
  let off = 6;
  const spsList = [];
  for (let i = 0; i < numOfSps && off + 2 <= avcC.length; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    spsList.push(avcC.slice(off + 2, off + 2 + len));
    off += 2 + len;
  }
  const numOfPps = avcC[off++] ?? 0;
  const ppsList = [];
  for (let i = 0; i < numOfPps && off + 2 <= avcC.length; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    ppsList.push(avcC.slice(off + 2, off + 2 + len));
    off += 2 + len;
  }

  let width = null;
  let height = null;
  if (spsList[0]) {
    const dims = parseH264SpsDimensions(spsList[0]);
    if (dims) ({ width, height } = dims);
  }
  return {
    profile, compat, level, naluLengthSize, spsList, ppsList, width, height,
  };
}

/**
 * 解析 HEVCDecoderConfigurationRecord。
 * @returns {{ profileSpace:number, profileIdc:number, levelIdc:number,
 *             naluLengthSize:number, vpsList, spsList, ppsList,
 *             width:number|null, height:number|null }}
 */
export function parseHevcConfig(hvcC) {
  if (!hvcC || hvcC.length < 23 || hvcC[0] !== 1) throw new Error('非法 hvcC');
  const profileSpace = hvcC[1] >> 6;
  const profileIdc = hvcC[1] & 0x1f;
  const levelIdc = hvcC[12];
  const naluLengthSize = (hvcC[21] & 0x03) + 1;
  const numOfArrays = hvcC[22];
  let off = 23;
  const vpsList = [];
  const spsList = [];
  const ppsList = [];
  for (let a = 0; a < numOfArrays && off + 3 <= hvcC.length; a++) {
    const nalType = hvcC[off] & 0x3f;
    const numNalus = (hvcC[off + 1] << 8) | hvcC[off + 2];
    off += 3;
    for (let i = 0; i < numNalus && off + 2 <= hvcC.length; i++) {
      const len = (hvcC[off] << 8) | hvcC[off + 1];
      const nalu = hvcC.slice(off + 2, off + 2 + len);
      if (nalType === 32) vpsList.push(nalu);
      else if (nalType === 33) spsList.push(nalu);
      else if (nalType === 34) ppsList.push(nalu);
      off += 2 + len;
    }
  }
  let width = null;
  let height = null;
  if (spsList[0]) {
    const dims = parseHevcSpsDimensions(spsList[0]);
    if (dims) ({ width, height } = dims);
  }
  // MSE 常用的简化 HEVC codec string：tier/profile/constraints/level
  const tier = (hvcC[1] >> 5) & 0x01 ? 'H' : 'L';
  const constraints = ((hvcC[7] << 16) | (hvcC[8] << 8) | hvcC[9]).toString(16).toUpperCase();
  return {
    profileSpace, profileIdc, levelIdc, naluLengthSize, vpsList, spsList, ppsList,
    width, height,
  };
}

/** 解析 AudioSpecificConfig 的关键参数 */
export function parseAscInfo(asc) {
  const r = new BitReader(asc);
  let aot = r.readBits(5);
  if (aot === 31) aot = 32 + r.readBits(6);
  const idx = r.readBits(4);
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const sampleRate = idx === 0x0f ? r.readBits(24) : RATES[idx] ?? 0;
  let channels = r.readBits(4);
  if (channels === 0) channels = 2;
  return { aot, sampleRate, channels };
}

// ---------- SPS 尺寸解析（与 ts 模块同源） ----------


export function parseH264SpsDimensions(sps) {
  try {
    const r = new BitReader(sps);
    r.readBits(8);
    const profileIdc = r.readBits(8);
    r.readBits(16);
    void r.readUE();
    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = r.readUE();
      if (chromaFormatIdc === 3) r.readFlag();
      r.readUE();
      r.readUE();
      r.readFlag();
      if (r.readFlag()) {
        const lists = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < lists; i++) {
          if (r.readFlag()) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
    r.readUE();
    const pocType = r.readUE();
    if (pocType === 0) {
      r.readUE();
    } else if (pocType === 1) {
      r.readFlag();
      r.readSE(); r.readSE(); r.readSE();
    }
    void r.readUE();   // max_num_ref_frames
    void r.readFlag(); // gaps_in_frame_num_value_allowed
    const widthInMbs = r.readUE() + 1;
    const heightInMapUnits = r.readUE() + 1;
    const frameMbsOnly = r.readFlag();
    if (!frameMbsOnly) r.readFlag();
    r.readFlag();

    let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
    if (r.readFlag()) {
      cropL = r.readUE(); cropR = r.readUE(); cropT = r.readUE(); cropB = r.readUE();
    }
    const subHCrop = chromaFormatIdc === 0 ? 0 : 2 ** (chromaFormatIdc === 3 ? 0 : 1);
    const subVCrop = chromaFormatIdc === 0 ? 0 : 2 ** (chromaFormatIdc !== 1 ? 0 : 1);
    return {
      width: widthInMbs * 16 - (cropL + cropR) * subHCrop,
      height: (2 - (frameMbsOnly ? 1 : 0)) * heightInMapUnits * 16 - (cropT + cropB) * subVCrop,
    };
  } catch {
    return null;
  }
}

function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = reader.readSE();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

export function parseHevcSpsDimensions(sps) {
  try {
    const r = new BitReader(sps);
    r.readBits(16);
    r.readBits(4);
    const maxSubLayersMinus1 = r.readBits(3);
    r.readBits(1);
    r.readBits(2 + 1 + 5);
    r.readBits(32);
    r.readBits(48);
    r.readBits(8);
    if (maxSubLayersMinus1 > 0) return null;   // 多层流暂不支持
    void r.readUE();
    const chromaFormatIdc = r.readUE();
    if (chromaFormatIdc === 3) r.readFlag();
    const width = r.readUE();
    const height = r.readUE();
    if (r.readFlag()) { r.readUE(); r.readUE(); r.readUE(); r.readUE(); }
    return { width, height };
  } catch {
    return null;
  }
}
