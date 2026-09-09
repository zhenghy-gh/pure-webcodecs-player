/**
 * nalu.js —— H.264 / H.265 NALU 级工具
 *
 * TS 中视频 ES 以 AnnexB（起始码 00 00 01 / 00 00 00 01）承载；
 * FLV 与 fMP4/MSE 以 4 字节长度前缀（AVCC）承载。
 * 本模块负责：起始码扫描、NALU 切分与分类、关键帧判定、
 * AnnexB ↔ AVCC 转换、avcC/hvcC 解码配置记录构造、SPS 宽高解析。
 */

import { BitReader } from './bits.js';

// ---------- H.264 ----------
export const H264_NAL_TYPES = {
  1: 'non-IDR slice', 2: 'slice-A', 3: 'slice-B', 4: 'slice-C',
  5: 'IDR slice', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD',
};

/** H.264 nal_unit_type = 第 1 字节低 5 位 */
export function h264NalType(nalu) {
  return nalu[0] & 0x1f;
}

/** H.264 关键帧：存在 IDR（type=5） */
export function isH264Keyframe(types) {
  return types.includes(5);
}

// ---------- H.265 ----------
export const HEVC_NAL_TYPES = {
  0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R',
  6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R',
  16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP',
  19: 'IDR_W_RADL', 20: 'IDR_N_LP', 21: 'CRA',
  32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 39: 'SEI_PREFIX', 40: 'SEI_SUFFIX',
};

/** HEVC nal_unit_type = (第 1 字节 >> 1) & 0x3f */
export function hevcNalType(nalu) {
  return (nalu[0] >> 1) & 0x3f;
}

/** HEVC IRAP（关键帧）：类型 16~23 */
export function isHevcKeyframe(types) {
  return types.some((t) => t >= 16 && t <= 23);
}

/**
 * 在缓冲内扫描下一个起始码（3 或 4 字节），返回 { start, length }；找不到返回 null。
 * @param {Uint8Array} bytes
 * @param {number} from
 */
export function findStartCode(bytes, from = 0) {
  const end = bytes.length - 3;
  for (let i = Math.max(from, 0); i <= end; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      const start = i > 0 && bytes[i - 1] === 0 ? i - 1 : i; // 回看是否为 4 字节码
      return { start, length: i - start + 3 };
    }
  }
  return null;
}

/**
 * 把一段 AnnexB ES 切分为 NALU 列表（不含起始码）。
 * 对非法数据尽力而为：无起始码时整块视为一个未知 NALU。
 * @param {Uint8Array} es
 * @returns {Array<{ type:number, data:Uint8Array }>}
 */
export function splitAnnexB(es) {
  const units = [];
  const cursor = findStartCode(es, 0);
  if (!cursor) {
    if (es.length > 0) units.push({ data: es });
    return units;
  }
  let pos = cursor.start + cursor.length;
  while (pos < es.length) {
    const next = findStartCode(es, pos);
    const unitEnd = next ? next.start : es.length;
    // 去掉前一个 NALU 尾部的零填充（trailing_zero_8bits）
    let cut = unitEnd;
    while (cut > pos && es[cut - 1] === 0) cut--;
    if (cut > pos) {
      const data = es.subarray(pos, cut);
      units.push({ data, h264Type: data[0] & 0x1f, hevcType: (data[0] >> 1) & 0x3f });
    }
    if (!next) break;
    pos = next.start + next.length;
  }
  return units;
}

/** 用统一字段标注 NALU 类型（codec 已知时调用） */
export function classify(units, codec) {
  return units.map((u) => ({
    ...u,
    type: codec === 'hevc' ? u.hevcType : u.h264Type,
  }));
}

/**
 * 序列化 NALU 列表为 AnnexB。
 * @param {Array<Uint8Array>} nalus
 */
export function nalusToAnnexB(nalus) {
  let size = 0;
  for (const n of nalus) size += 4 + n.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const n of nalus) {
    out[off] = out[off + 1] = 0;
    out[off + 2] = 0;
    out[off + 3] = 1;
    out.set(n, off + 4);
    off += 4 + n.length;
  }
  return out;
}

/**
 * AnnexB NALU 列表 → AVCC（每 NALU 前置 4 字节大端长度）。MSE/fMP4 需要该形态。
 * @param {Array<{data:Uint8Array}|Uint8Array>} nalus 不含起始码的 NALU 列表
 */
export function annexbToAvcc(nalus) {
  let size = 0;
  for (const n of nalus) size += 4 + (n.data ?? n).length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const n of nalus) {
    const bytes = n.data ?? n;
    view.setUint32(off, bytes.length);
    out.set(bytes, off + 4);
    off += 4 + bytes.length;
  }
  return out;
}

/**
 * 构造 AVCDecoderConfigurationRecord（avcC，ISO 14496-15）。
 * @param {Uint8Array[]} spsList
 * @param {Uint8Array[]} ppsList
 */
export function buildAvcc(spsList, ppsList) {
  const sps = spsList[0];
  if (!sps || sps.length < 4) throw new Error('buildAvcc: 缺少 SPS');
  let bodySize = 7;
  for (const s of spsList) bodySize += 2 + s.length;
  for (const p of ppsList) bodySize += 2 + p.length;

  const out = new Uint8Array(bodySize);
  const view = new DataView(out.buffer);
  out[0] = 1;                       // configurationVersion
  out[1] = sps[1];                  // AVCProfileIndication
  out[2] = sps[2];                  // profile_compatibility
  out[3] = sps[3];                  // AVCLevelIndication
  out[4] = 0xff;                    // reserved(6)+lengthSizeMinusOne=3 → 0b11111111
  out[5] = 0xe0 | spsList.length;   // reserved(3)+numOfSPS
  let off = 6;
  for (const s of spsList) {
    view.setUint16(off, s.length);
    out.set(s, off + 2);
    off += 2 + s.length;
  }
  out[off++] = ppsList.length;      // numOfPPS
  for (const p of ppsList) {
    view.setUint16(off, p.length);
    out.set(p, off + 2);
    off += 2 + p.length;
  }
  return out;
}

/**
 * 构造 HEVCDecoderConfigurationRecord（hvcC，ISO 14496-15）。
 * general_* 字段取自 SPS 内嵌的 profile_tier_level：
 *   SPS 布局 = NAL头(2B) + vps_id/nesting(1B) + PTL(12B: space/tier/idc(1)
 *   + compat(4) + constraints(6) + level(1)) …
 * 因此偏移为 sps[3] 起（reviewer round-1 修正：此前误读 sps[2] 起导致 level=0）。
 * @param {Uint8Array[]} vpsList
 * @param {Uint8Array[]} spsList
 * @param {Uint8Array[]} ppsList
 */
export function buildHvcc(vpsList, spsList, ppsList) {
  const sps = spsList[0];
  if (!sps || sps.length < 15) throw new Error('buildHvcc: 缺少 SPS');
  const arrays = [
    [32, vpsList],
    [33, spsList],
    [34, ppsList],
  ].filter(([, list]) => list.length > 0);

  let bodySize = 23;   // 固定头部区（configurationVersion ~ numOfArrays）
  for (const [, list] of arrays) {
    bodySize += 3;
    for (const nalu of list) bodySize += 2 + nalu.length;
  }
  const out = new Uint8Array(bodySize);
  const view = new DataView(out.buffer);
  let off = 0;
  out[off++] = 1;                                   // configurationVersion
  // ---- 从 SPS 提取 profile_tier_level（SPS 头 2 字节 + 1 字节标志之后开始）----
  out[off++] = sps[3];                              // profile_space/tier/profile_idc
  view.setUint32(off, ((sps[4] << 24) | (sps[5] << 16) | (sps[6] << 8) | sps[7]) >>> 0); off += 4; // compat flags
  for (let i = 0; i < 6; i++) out[off++] = sps[8 + i]; // constraint flags
  out[off++] = sps[14];                             // general_level_idc
  // min_spatial_segmentation(12)=0、parallelismType(2)=0 等
  out[off++] = 0xf0;                                // reserved+min_spatial hi
  out[off++] = 0x00;                                // min_spatial lo
  out[off++] = 0xfc;                                // reserved+parallelismType
  // chroma / bit depth / nesting 一律取自 SPS：硬编码 4:2:0+8bit 会让 main10、4:2:2 流坏掉
  const cfg = parseHevcSpsConfig(sps);
  const chroma = cfg ? cfg.chromaFormatIdc & 0x03 : 1;   // 解析失败回退 4:2:0
  const depthL = cfg ? cfg.bitDepthLumaMinus8 & 0x07 : 0;
  const depthC = cfg ? cfg.bitDepthChromaMinus8 & 0x07 : 0;
  const nested = cfg ? (cfg.temporalIdNesting ? 1 : 0) : 0;
  out[off++] = 0xfc | chroma;                       // reserved+chromaFormat
  out[off++] = 0xf8 | depthL;                       // reserved+bitDepthLuma-8
  out[off++] = 0xf8 | depthC;                       // reserved+bitDepthChroma-8
  view.setUint16(off, 0); off += 2;                 // avgFrameRate
  out[off++] = (0 << 6) | (1 << 3) | (nested << 2) | 3; // cfr/tlayers/nested/lengthSizeMinusOne=3
  out[off++] = arrays.length;                       // numOfArrays
  for (const [nalType, list] of arrays) {
    out[off++] = 0x80 | nalType;                    // array_completeness|reserved|type
    view.setUint16(off, list.length); off += 2;
    for (const nalu of list) {
      view.setUint16(off, nalu.length); off += 2;
      out.set(nalu, off); off += nalu.length;
    }
  }
  return out;
}

// ---------- SPS 宽高解析 ----------

/**
 * 解析 H.264 SPS 的分辨率（尽力而为，失败返回 null）。
 * @param {Uint8Array} sps 不含起始码
 * @returns {{ width:number, height:number }|null}
 */
export function parseH264SpsDimensions(sps) {
  try {
    const r = new BitReader(sps);
    r.readBits(8);            // NALU header
    const profileIdc = r.readBits(8);
    r.readBits(16);           // constraint flags + level
    const spsId = r.readUE();
    void spsId;

    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = r.readUE();
      if (chromaFormatIdc === 3) r.readFlag();     // separate_colour_plane_flag
      r.readUE();                                  // bit_depth_luma_minus8
      r.readUE();                                  // bit_depth_chroma_minus8
      r.readFlag();                                // qpprime_y_zero_transform_bypass
      const seqScaling = r.readFlag();             // seq_scaling_matrix_present
      if (seqScaling) {
        const lists = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < lists; i++) {
          if (r.readFlag()) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
    r.readUE();               // log2_max_frame_num_minus4
    const pocType = r.readUE();
    if (pocType === 0) {
      r.readUE();             // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      r.readFlag();           // delta_pic_order_always_zero
      r.readSE(); r.readSE(); r.readSE();
    }
    const maxRefFrames = r.readUE(); void maxRefFrames;
    r.readFlag();             // gaps_in_frame_num_value_allowed
    const widthInMbs = r.readUE() + 1;
    const heightInMapUnits = r.readUE() + 1;
    const frameMbsOnly = r.readFlag();
    if (!frameMbsOnly) r.readFlag();
    r.readFlag();             // direct_8x8_inference

    let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
    if (r.readFlag()) {       // frame_cropping
      cropL = r.readUE();
      cropR = r.readUE();
      cropT = r.readUE();
      cropB = r.readUE();
    }

    const subHCrop = chromaFormatIdc === 0 ? 0 : 2 ** (chromaFormatIdc === 3 ? 0 : 1);
    const subVCrop = chromaFormatIdc === 0 ? 0 : 2 ** (chromaFormatIdc !== 1 ? 0 : 1);
    const width = widthInMbs * 16 - (cropL + cropR) * subHCrop;
    const height = (2 - (frameMbsOnly ? 1 : 0)) * heightInMapUnits * 16 - (cropT + cropB) * subVCrop;
    return { width, height };
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

/**
 * 解析 HEVC SPS 的分辨率（支持常见单层 4:2:0 流；复杂语法返回 null）。
 * @param {Uint8Array} sps 不含起始码
 */
export function parseHevcSpsDimensions(sps) {
  try {
    const r = new BitReader(sps);
    r.readBits(16);                          // NALU header
    r.readBits(4);                           // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.readBits(3);
    r.readBits(1);                           // temporal_id_nesting
    skipProfileTierLevel(r, maxSubLayersMinus1);
    r.readUE();                              // sps_seq_parameter_set_id
    const chromaFormatIdc = r.readUE();
    if (chromaFormatIdc === 3) r.readFlag(); // separate_colour_plane
    const width = r.readUE();
    const height = r.readUE();
    if (r.readFlag()) {                      // conformance_window
      r.readUE(); r.readUE(); r.readUE(); r.readUE();
    }
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * 解析 HEVC SPS 的 hvcC 配置字段（评审 #4 残余项修复）。
 *
 * 旧实现把 chroma_format / bit_depth / temporal_id_nesting 硬编码为 4:2:0 + 8bit + 0，
 * 导致 4:2:2 / main10（10bit）流的 hvcC 描述与实际码流不符，解码器初始化必然失败。
 * 解析失败返回 null，调用方回退保守默认值并保留可诊断性。
 *
 * @param {Uint8Array} sps 含 NAL 头的 SPS（已去 EPB）
 * @returns {{chromaFormatIdc:number, bitDepthLumaMinus8:number, bitDepthChromaMinus8:number, temporalIdNesting:number}|null}
 */
export function parseHevcSpsConfig(sps) {
  try {
    const r = new BitReader(sps);
    r.readBits(16);                              // NALU header
    r.readBits(4);                               // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.readBits(3);
    const temporalIdNesting = r.readBits(1);
    skipProfileTierLevel(r, maxSubLayersMinus1); // 多层 SPS 以抛错形式降级 → null
    r.readUE();                                  // sps_seq_parameter_set_id
    const chromaFormatIdc = r.readUE();
    if (chromaFormatIdc === 3) r.readFlag();     // separate_colour_plane_flag
    r.readUE();                                  // pic_width_in_luma_samples
    r.readUE();                                  // pic_height_in_luma_samples
    if (r.readFlag()) {                          // conformance_window_flag
      r.readUE(); r.readUE(); r.readUE(); r.readUE();
    }
    const bitDepthLumaMinus8 = r.readUE();
    const bitDepthChromaMinus8 = r.readUE();
    if (![0, 1, 2, 3].includes(chromaFormatIdc)) return null;
    return { chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8, temporalIdNesting };
  } catch {
    return null;
  }
}

function skipProfileTierLevel(r, maxSubLayersMinus1) {
  r.readBits(2 + 1 + 5);   // profile_space/tier/profile_idc
  r.readBits(32);          // compatibility flags
  r.readBits(48);          // constraint indicator
  r.readBits(8);           // level_idc
  // 子层配置（主流流 max_sub_layers=1，直接跳过）
  if (maxSubLayersMinus1 > 0) throw new Error('多层 SPS 暂不支持宽高解析');
}
