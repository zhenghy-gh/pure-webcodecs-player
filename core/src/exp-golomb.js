/**
 * exp-Golomb 编解码：H.264 SPS/PPS、H.265 参数集的核心原语。
 *
 * ue(v): 前导零个数 k → 值 = 2^k - 1 + 后 k 位
 * se(v): 映射 ue 值 → 有符号：0→0, 1→+1, 2→-1, 3→+2 ...
 *
 * 另附 H.264 SPS 尺寸解析（parseH264Sps）：WebCodecs/MSE 场景下
 * 经常需要在没有完整 demux 元数据时拿到分辨率与 profile/level。
 */
import { BitReader } from './bit-reader.js';
import { parseError } from './errors.js';
import { removeEmulationPrevention } from './nal.js';

export class ExpGolombReader {
  /** @param {BitReader|Uint8Array} source */
  constructor(source) {
    this.reader = source instanceof BitReader ? source : new BitReader(source);
  }

  readBits(n) {
    return this.reader.readBits(n);
  }

  readBool() {
    return this.reader.readBits(1) === 1;
  }

  /** 无符号指数哥伦布 ue(v) */
  readUEG() {
    let leadingZeros = 0;
    while (this.reader.readBit() === 0) {
      leadingZeros += 1;
      if (leadingZeros > 32) {
        throw parseError('invalid exp-Golomb code (>32 leading zeros)');
      }
    }
    if (leadingZeros === 0) return 0;
    // 用 2**n 而非 (1 << n)：leadingZeros >= 31 时 << 会溢出 32 位有符号整数
    // （实测 (1<<31) = -2147483648，导致 ue 值返回负数）。2**n 在 n<=52 内精确。
    return (2 ** leadingZeros) - 1 + this.reader.readBits(leadingZeros);
  }

  /** 有符号指数哥伦布 se(v) */
  readSEG() {
    const ue = this.readUEG();
    if (ue === 0) return 0;
    return ue & 1 ? (ue + 1) >>> 1 : -(ue >>> 1);
  }

  /** 是否仍有 rbsp 数据（排除 stop bit 与对齐零） */
  moreRbspData() {
    const reader = this.reader;
    const remaining = reader.bitsRemaining;
    if (remaining <= 0) return false;
    // 扫描剩余位：只要还有非零位就视为有数据（rbsp trailing 对齐零全为 0）
    const saved = reader.bitPosition;
    try {
      while (reader.hasMoreData()) {
        if (reader.readBit() === 1) return true; // 还有新的起始位
      }
      return false;
    } finally {
      reader.seekToBit(saved);
    }
  }
}

// 给 BitReader 补一个内部用 seek（不对外扩散 API）

/**
 * 去除 H.264 emulation prevention（00 00 03 → 00 00），得到 RBSP。
 * @param {Uint8Array} nalu 不含起始码的 NAL 单元
 */
export function stripEmulationPrevention(nalu) {
  return removeEmulationPrevention(nalu);
}

/** scaling_list 解析（SPS 中出现 scaling_matrix_flag 时必须跳过才能继续） */
function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = reader.readSEG();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/**
 * 解析 H.264 SPS（可传入含 NAL header 的原始单元或已去 EPB 的 RBSP），
 * 返回 {profileIdc, levelIdc, width, height, chromaFormatIdc, numRefFrames}。
 * 宽高按 spec 的 crop 换算（frame_mbs_only=0 时高度翻倍）。
 */
export function parseH264Sps(naluBytes) {
  // 统一去 EPB；SPS NAL 的第 0 字节是 NAL header，从 bit 8 开始读参数
  const rbsp = removeEmulationPrevention(naluBytes);
  const nalType = rbsp[0] & 0x1f;
  if (nalType !== 7) {
    throw parseError(`not an SPS NAL unit (type=${nalType})`);
  }
  const reader = new ExpGolombReader(new BitReader(rbsp, 8)); // 跳过 1 字节 NAL header
  const profileIdc = reader.readBits(8);
  const constraintFlags = reader.readBits(8);
  const levelIdc = reader.readBits(8);
  reader.readUEG(); // seq_parameter_set_id

  const chromaFormatSupported =
    profileIdc === 100 ||
    profileIdc === 110 ||
    profileIdc === 122 ||
    profileIdc === 244 ||
    profileIdc === 44 ||
    profileIdc === 83 ||
    profileIdc === 86 ||
    profileIdc === 118 ||
    profileIdc === 128 ||
    profileIdc === 138 ||
    profileIdc === 139 ||
    profileIdc === 134 ||
    profileIdc === 135;

  let chromaFormatIdc = 1;
  let separateColourPlaneFlag = 0;
  if (chromaFormatSupported) {
    chromaFormatIdc = reader.readUEG();
    if (chromaFormatIdc === 3) separateColourPlaneFlag = reader.readBits(1);
    reader.readUEG(); // bit_depth_luma_minus8
    reader.readUEG(); // bit_depth_chroma_minus8
    reader.readBits(1); // qpprime_y_zero_transform_bypass
    if (reader.readBool()) {
      // seq_scaling_matrix_present_flag
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (reader.readBool()) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }
  reader.readUEG(); // log2_max_frame_num_minus4
  const picOrderCntType = reader.readUEG();
  if (picOrderCntType === 0) {
    reader.readUEG(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    reader.readBits(1); // delta_pic_order_always_zero
    reader.readSEG(); // offset_for_non_ref_pic
    reader.readSEG(); // offset_for_top_to_bottom_field
    const numRefFramesInPicOrderCntCycle = reader.readUEG();
    for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) reader.readSEG();
  }
  reader.readUEG(); // max_num_ref_frames
  reader.readBits(1); // gaps_in_frame_num_value_allowed
  const picWidthInMbsMinus1 = reader.readUEG();
  const picHeightInMapUnitsMinus1 = reader.readUEG();
  const frameMbsOnlyFlag = reader.readBits(1);
  if (!frameMbsOnlyFlag) reader.readBits(1); // mb_adaptive_frame_field_flag
  reader.readBits(1); // direct_8x8_inference

  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (reader.readBool()) {
    // frame_cropping_flag —— 裁剪单位按 H.264 E.2.2：
    //   idc==0(mono): X=1, Y=2-frame_mbs_only
    //   idc==3(4:4:4): X=1, Y=(2-frame_mbs_only)
    //   其余(4:2:0/4:2:2): X=2, Y=(idc===3?1:2)*(2-frame_mbs_only) 的等价式
    // frame_mbs_only=1 时 1080p（1920x1088, crop_bottom=4）必须裁出 8 行 → Y 单位为 2。
    const cropUnitX = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
    const cropUnitY =
      chromaFormatIdc === 0 ? 2 - frameMbsOnlyFlag
        : (chromaFormatIdc === 3 ? 1 : 2) * (2 - frameMbsOnlyFlag);
    cropLeft = reader.readUEG() * cropUnitX;
    cropRight = reader.readUEG() * cropUnitX;
    cropTop = reader.readUEG() * cropUnitY;
    cropBottom = reader.readUEG() * cropUnitY;
  }

  const width = (picWidthInMbsMinus1 + 1) * 16 - cropLeft - cropRight;
  const height =
    (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 -
    cropTop -
    cropBottom;

  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    chromaFormatIdc,
    separateColourPlaneFlag,
    width,
    height,
  };
}
