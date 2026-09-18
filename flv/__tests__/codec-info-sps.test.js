/**
 * codec-info SPS 深分支补测（第一百一十六波）
 * ------------------------------------------------------------
 * 用 core BitWriter 程序化构造 H.264/HEVC SPS 位流，覆盖 flv-parser.test.js
 * 未触达的分支：高档位 profile 的 chroma_format_idc / scaling matrix、
 * poc_type 0/1、skipScalingList（16/64 两种尺寸）、parseHevcSpsDimensions 全体。
 * 位级往返即断言：构造器的字段序与解析器读取序严格互为镜像，任何一位漂移都会
 * 导致后续字段错位、宽高断言失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter } from '../../core/src/bit-reader.js';
import { parseH264SpsDimensions, parseHevcSpsDimensions } from '../src/codec-info.js';

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/**
 * 按解析器读取序构造 H.264 SPS（nal 头 + 序列参数集语法）。
 * @param {{
 *   profileIdc?: number, width?: number, height?: number,
 *   chromaFormatIdc?: number, scalingMatrix?: boolean,
 *   pocType?: 0|1|2, frameMbsOnly?: boolean,
 * }} opts
 */
function h264Sps(opts = {}) {
  const {
    profileIdc = 66, width = 320, height = 240,
    chromaFormatIdc = 1, scalingMatrix = false,
    pocType = 2, frameMbsOnly = true,
  } = opts;
  const w = new BitWriter();
  w.writeBits(0x67, 8); // nal_ref_idc=3 + type=7（解析器只读 8 位头）
  w.writeBits(profileIdc, 8);
  w.writeBits(0xc0, 8); // constraint flags
  w.writeBits(30, 8);   // level 3.0
  w.writeUE(0);         // seq_parameter_set_id
  if (HIGH_PROFILES.includes(profileIdc)) {
    w.writeUE(chromaFormatIdc);
    if (chromaFormatIdc === 3) w.writeBits(0, 1); // separate_colour_plane_flag
    w.writeUE(0); // bit_depth_luma_minus8
    w.writeUE(0); // bit_depth_chroma_minus8
    w.writeBits(0, 1); // qpprime_y_zero_transform_bypass_flag
    w.writeBits(scalingMatrix ? 1 : 0, 1);
    if (scalingMatrix) {
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        w.writeBits(1, 1); // seq_scaling_list_present_flag[i]
        const size = i < 6 ? 16 : 64;
        for (let j = 0; j < size; j++) w.writeSE(0); // delta_scale=0 → nextScale 恒 8
      }
    }
  }
  w.writeUE(4); // log2_max_frame_num_minus4
  w.writeUE(pocType);
  if (pocType === 0) {
    w.writeUE(0); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    w.writeBits(0, 1); // delta_pic_order_always_zero_flag
    w.writeSE(0); w.writeSE(0); w.writeSE(0);
  }
  w.writeUE(1); // max_num_ref_frames
  w.writeBits(0, 1); // gaps_in_frame_num_value_allowed_flag
  w.writeUE(width / 16 - 1);
  w.writeUE(height / 16 - 1); // pic_height_in_map_units_minus1（恒以 16px 宏块行计）
  w.writeBits(frameMbsOnly ? 1 : 0, 1);
  if (!frameMbsOnly) w.writeBits(0, 1); // mb_adaptive_frame_field_flag
  w.writeBits(0, 1); // direct_8x8_inference_flag
  w.writeBits(0, 1); // frame_cropping_flag
  w.writeBits(0, 1); // vui_parameters_present_flag
  w.writeBits(1, 1); // rbsp_stop_one_bit（对齐填充）
  return w.finish();
}

/** 按解析器读取序构造 HEVC SPS（profile_tier_level 固定单层） */
function hevcSps({ maxSubLayers = 0, width = 1920, height = 1080, chromaFormatIdc = 1, conformance = false } = {}) {
  const w = new BitWriter();
  w.writeBits(0x42, 8); w.writeBits(0x01, 8); // nal header（type=33 SPS）
  w.writeBits(0, 4);   // sps_video_parameter_set_id
  w.writeBits(maxSubLayers, 3); // sps_max_sub_layers_minus1
  w.writeBits(1, 1);   // sps_temporal_id_nesting_flag
  w.writeBits(1, 8);   // profile_space(2)+tier(1)+profile_idc(5)=Main
  w.writeBits(0, 32);  // general_profile_compatibility_flag[32]
  w.writeBits(0, 48);  // constraint indicator（解析器 skipBits 丢弃）
  w.writeBits(93, 8);  // general_level_idc
  // maxSubLayers>0 时解析器在读取后续语法前即返回 null，故无需构造多层扩展
  w.writeUE(0); // sps_seq_parameter_set_id
  w.writeUE(chromaFormatIdc);
  if (chromaFormatIdc === 3) w.writeBits(0, 1); // separate_colour_plane_flag
  w.writeUE(width);
  w.writeUE(height);
  if (conformance) {
    w.writeBits(1, 1);
    w.writeUE(0); w.writeUE(0); w.writeUE(0); w.writeUE(0); // conf_win 左右上下偏移
  } else {
    w.writeBits(0, 1);
  }
  w.writeBits(1, 1); // rbsp_stop_one_bit
  return w.finish();
}

/* ------------------------------ H.264 ------------------------------ */

test('H264 SPS Baseline（pocType=2）回归基准：320x240', () => {
  assert.deepEqual(parseH264SpsDimensions(h264Sps()), { width: 320, height: 240 });
});

test('H264 SPS 高档位 profile=100 chroma=1：位序对齐且宽高正确', () => {
  const dims = parseH264SpsDimensions(h264Sps({ profileIdc: 100, width: 640, height: 352 }));
  assert.deepEqual(dims, { width: 640, height: 352 });
});

test('H264 SPS 高档位 chroma=3 + scaling matrix：12 组列表（16/64 两种尺寸）全消费', () => {
  // chroma=3 时 scaling lists 为 12 组（前 6 组 16 元素、后 6 组 64 元素）；
  // 若 skipScalingList 元素数或组数算错，后续 UE 位流必然错位 → 宽高断言失败
  const dims = parseH264SpsDimensions(
    h264Sps({ profileIdc: 100, chromaFormatIdc: 3, scalingMatrix: true, width: 1280, height: 720 })
  );
  assert.deepEqual(dims, { width: 1280, height: 720 });
});

test('H264 SPS pocType=0：log2_max_poc_lsb 分支', () => {
  assert.deepEqual(parseH264SpsDimensions(h264Sps({ pocType: 0 })), { width: 320, height: 240 });
});

test('H264 SPS pocType=1：delta_pic_order_always_zero + 三个 se 偏移分支', () => {
  assert.deepEqual(parseH264SpsDimensions(h264Sps({ pocType: 1 })), { width: 320, height: 240 });
});

test('H264 SPS frame_mbs_only=0：高度按帧/场自适应翻倍', () => {
  // map units 写 7 行（112/16），frame_mbs_only=0 时解析器高度 ×2 → 224
  const dims = parseH264SpsDimensions(h264Sps({ frameMbsOnly: false, width: 320, height: 112 }));
  assert.deepEqual(dims, { width: 320, height: 224 });
});

test('H264 SPS 截断（高档位中途截断）：catch 吞错返回 null', () => {
  const full = h264Sps({ profileIdc: 100, scalingMatrix: true });
  assert.equal(parseH264SpsDimensions(full.slice(0, 6)), null);
});

/* ------------------------------ HEVC ------------------------------ */

test('HEVC SPS：1920x1080 正常解析', () => {
  assert.deepEqual(parseHevcSpsDimensions(hevcSps()), { width: 1920, height: 1080 });
});

test('HEVC SPS conformance window 置位：四个 ue 偏移被消费', () => {
  assert.deepEqual(parseHevcSpsDimensions(hevcSps({ conformance: true })), { width: 1920, height: 1080 });
});

test('HEVC SPS chroma_format_idc=3：separate_colour_plane 被消费', () => {
  assert.deepEqual(parseHevcSpsDimensions(hevcSps({ chromaFormatIdc: 3 })), { width: 1920, height: 1080 });
});

test('HEVC SPS 多层流（max_sub_layers>1）：暂不支持返回 null', () => {
  assert.equal(parseHevcSpsDimensions(hevcSps({ maxSubLayers: 1 })), null);
});

test('HEVC SPS 截断：catch 吞错返回 null', () => {
  assert.equal(parseHevcSpsDimensions(hevcSps().slice(0, 4)), null);
});
