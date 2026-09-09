/**
 * 程序化 H.264 测试流生成器（Baseline Profile，全 I 帧，I_PCM 宏块）。
 *
 * 设计动机：本机无 ffmpeg，交付标准要求 fixture 程序化生成且可真实解码。
 * I_PCM 宏块直接携带原始像素（256 亮度 + 128 色度字节），完全绕开 CAVLC/CABAC
 * 熵编码，因此一个 ~200 行的手写编码器即可产出浏览器 WebCodecs/MSE 可解码的
 * 合法 H.264 流。每帧均为 IDR，帧间无参考，天然适合丢包/重连场景测试。
 *
 * 输出形态：AnnexB（起始码 00 00 00 01 分隔的 NAL 序列）。
 */

import { BitWriter, emulationPrevent } from './bitwriter.js';

/** 编码参数：16x16 单宏块、15fps */
export const VIDEO_W = 16;
export const VIDEO_H = 16;
export const VIDEO_FPS = 15;
export const CLOCK_RATE = 90000;

/** profile_idc=66(Baseline) constraint_set0|1 level_idc=30 → avc1.42001e */
export const PROFILE_IDC = 66;
export const CONSTRAINT_FLAGS = 0xc0;
export const LEVEL_IDC = 30;

const START_CODE = Uint8Array.from([0, 0, 0, 1]);

function nalHeader(nalRefIdc, type) {
  return ((nalRefIdc & 3) << 5) | (type & 31);
}

/** 生成 SPS NAL（含仿真预防） */
export function makeSps() {
  const w = new BitWriter();
  // NAL header: ref_idc=3, type=7
  w.writeBits(nalHeader(3, 7), 8);
  w.writeBits(PROFILE_IDC, 8);
  w.writeBits(CONSTRAINT_FLAGS, 8);
  w.writeBits(LEVEL_IDC, 8);
  w.writeUE(0); // seq_parameter_set_id = 0
  w.writeUE(0); // log2_max_frame_num_minus4 → 帧号占 4 位
  w.writeUE(0); // pic_order_cnt_type = 0
  w.writeUE(0); // log2_max_pic_order_cnt_lsb_minus4 → POC LSB 占 4 位
  w.writeUE(1); // max_num_ref_frames = 1
  w.writeBits(0, 1); // gaps_in_frame_num_value_allowed_flag
  w.writeUE(VIDEO_W / 16 - 1); // pic_width_in_mbs_minus1
  w.writeUE(VIDEO_H / 16 - 1); // pic_height_in_map_units_minus1
  w.writeBits(1, 1); // frame_mbs_only_flag
  w.writeBits(1, 1); // direct_8x8_inference_flag
  w.writeBits(0, 1); // frame_cropping_flag
  w.writeBits(0, 1); // vui_parameters_present_flag
  w.rbspTrailing();
  return emulationPrevent(w.toUint8Array());
}

/** 生成 PPS NAL */
export function makePps() {
  const w = new BitWriter();
  w.writeBits(nalHeader(3, 8), 8);
  w.writeUE(0); // pps_id
  w.writeUE(0); // sps_id
  w.writeBits(0, 1); // entropy_coding_mode_flag = CAVLC
  w.writeBits(0, 1); // bottom_field_pic_order_in_frame_present_flag
  w.writeUE(0); // num_slice_groups_minus1
  w.writeUE(0); // num_ref_idx_l0_default_active_minus1
  w.writeUE(0); // num_ref_idx_l1_default_active_minus1
  w.writeBits(0, 1); // weighted_pred_flag
  w.writeBits(0, 2); // weighted_bipred_idc
  w.writeSE(0); // pic_init_qp_minus26
  w.writeSE(0); // pic_init_qs_minus26
  w.writeSE(0); // chroma_qp_index_offset
  w.writeBits(0, 1); // deblocking_filter_control_present_flag（slice 头随之省略去块参数）
  w.writeBits(0, 1); // constrained_intra_pred_flag
  w.writeBits(0, 1); // redundant_pic_cnt_present_flag
  w.rbspTrailing();
  return emulationPrevent(w.toUint8Array());
}

/**
 * 动态测试图案：对角移动条纹 + 缓变色调。
 * @param {number} x 亮度像素 x（0..W-1）
 * @param {number} y 亮度像素 y
 * @param {number} t 帧序号
 */
function lumaSample(x, y, t) {
  return (x + y + t * 5) % 256;
}
function chromaSample(t) {
  return 128 + Math.round(60 * Math.sin(t / 6));
}

/**
 * 生成一帧 IDR slice NAL（I_PCM 全帧内）。
 * @param {number} frameIndex 帧序号（用于图案与 POC）
 * @returns {Uint8Array} 单个 NAL 单元（AnnexB 起始码不含）
 */
export function makeIdrFrame(frameIndex) {
  const w = new BitWriter();
  w.writeBits(nalHeader(3, 5), 8); // IDR slice

  // ---- slice header ----
  w.writeUE(0); // first_mb_in_slice
  w.writeUE(7); // slice_type = I（全部切片为 I）
  w.writeUE(0); // pps_id
  w.writeBits(0, 4); // frame_num：IDR 恒为 0
  w.writeUE(frameIndex % 2); // idr_pic_id
  w.writeBits(frameIndex % 16, 4); // pic_order_cnt_lsb
  w.writeBits(0, 1); // no_output_of_prior_pics_flag
  w.writeBits(0, 1); // long_term_reference_flag
  w.writeSE(0); // slice_qp_delta

  // ---- 唯一宏块：mb_type = 25 (I_PCM) ----
  w.writeUE(25);
  w.alignZero(); // pcm_alignment_zero_bit

  for (let y = 0; y < VIDEO_H; y++) {
    for (let x = 0; x < VIDEO_W; x++) {
      w.writeBits(lumaSample(x, y, frameIndex), 8);
    }
  }
  const u = chromaSample(frameIndex);
  const v = 255 - u;
  for (let i = 0; i < 64; i++) w.writeBits(u, 8); // Cb 平面 8x8
  for (let i = 0; i < 64; i++) w.writeBits(v, 8); // Cr 平面 8x8

  w.rbspTrailing();
  return emulationPrevent(w.toUint8Array());
}

/**
 * 生成完整 GOP 起始数据（SPS+PPS）与一帧 AnnexB。
 * @returns {{ sps:Uint8Array, pps:Uint8Array }}
 */
export function makeParameterSets() {
  return { sps: makeSps(), pps: makePps() };
}

/** AnnexB 拼接工具 */
export function annexb(...nals) {
  const parts = [];
  for (const nal of nals) parts.push(START_CODE, nal);
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 一帧完整 AnnexB（IDR slice；参数集单独发） */
export function makeFrameAnnexb(frameIndex) {
  return annexb(makeIdrFrame(frameIndex));
}

/** profile-level-id 的十六进制串（供 SDP fmtp 与 avcC 使用） */
export function profileLevelIdHex() {
  const hex = (n) => n.toString(16).padStart(2, '0');
  return hex(PROFILE_IDC) + hex(CONSTRAINT_FLAGS) + hex(LEVEL_IDC);
}

/** RFC 6184 sprop-parameter-sets 值：<b64 sps>,<b64 pps> */
export function spropParameterSets() {
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  return `${b64(makeSps())},${b64(makePps())}`;
}
