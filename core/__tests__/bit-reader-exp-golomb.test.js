import test from 'node:test';
import assert from 'node:assert/strict';
import { BitReader } from '../src/bit-reader.js';
import {
  ExpGolombReader,
  parseH264Sps,
  stripEmulationPrevention,
} from '../src/exp-golomb.js';

/** 把形如 "0101 001 /* 注释可内联 *\/" 的位串转成字节数组（右侧补零对齐） */
function bitsToBytes(str) {
  const clean = str.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const out = new Uint8Array(Math.ceil(clean.length / 8));
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '1' && clean[i] !== '0') {
      throw new Error(`bad bit char at ${i}: ${clean[i]}`);
    }
    if (clean[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

test('BitReader 基本读取与回溯', () => {
  const bytes = new Uint8Array([0b10110100, 0b00011111, 0b11100000]);
  const r = new BitReader(bytes);
  assert.equal(r.readBits(3), 0b101);
  assert.equal(r.readBits(5), 0b10100);
  assert.equal(r.peekBits(3), 0b000, 'peek 不消耗');
  assert.equal(r.readBits(3), 0b000);
  // 剩余 5 位是 11111 → 补码 -1
  assert.equal(r.readSignedBits(5), -1);
  r.alignToByte();
  assert.equal(r.byteAligned, true);
});

test('exp-Golomb ue/se 已知序列', () => {
  // '1'→ue=0；'010'→ue=1；'011'→ue=2；'00100'→ue=3；'00101'→ue=4
  const data = bitsToBytes('1 010 011 00100 00101');
  const g = new ExpGolombReader(data);
  assert.deepEqual(
    [g.readUEG(), g.readUEG(), g.readUEG(), g.readUEG(), g.readUEG()],
    [0, 1, 2, 3, 4],
  );

  // se 映射：ue0→0, ue1→+1, ue2→-1, ue3→+2, ue4→-2
  const g2 = new ExpGolombReader(bitsToBytes('1 010 011 00100 00101'));
  assert.deepEqual(
    [g2.readSEG(), g2.readSEG(), g2.readSEG(), g2.readSEG(), g2.readSEG()],
    [0, 1, -1, 2, -2],
  );
});
test('exp-Golomb 过多前导零报 PARSE_ERROR', () => {
  const data = new Uint8Array(64).fill(0);
  const g = new ExpGolombReader(data);
  assert.throws(() => g.readUEG(), (e) => e.code === 'PARSE_ERROR');
});

test('parseH264Sps：手工构造 baseline SPS 解析出 32x16', () => {
  // NAL header 0x67(type7) + profile66 + constraint0 + level30 + 参数集位流
  const body = bitsToBytes(`
    1            /* seq_parameter_set_id ue(0) */
    1            /* log2_max_frame_num_minus4 ue(0) */
    1            /* pic_order_cnt_type ue(0) */
    1            /* log2_max_pic_order_cnt_lsb_minus4 ue(0) */
    1            /* max_num_ref_frames ue(0) */
    0            /* gaps_in_frame_num_value_allowed */
    010          /* pic_width_in_mbs_minus1 ue(1) → 宽 32 */
    1            /* pic_height_in_map_units_minus1 ue(0) */
    1            /* frame_mbs_only_flag */
    1            /* direct_8x8_inference */
    0            /* frame_cropping_flag */
    0            /* vui_parameters_present */
    1            /* rbsp stop bit */
  `);
  const nalu = new Uint8Array(4 + body.length);
  nalu[0] = 0x67;      // NAL header: type=7 (SPS)
  nalu[1] = 66;        // profile_idc = baseline
  nalu[2] = 0x00;      // constraint flags
  nalu[3] = 30;        // level_idc
  nalu.set(body, 4);

  const sps = parseH264Sps(nalu);
  assert.equal(sps.profileIdc, 66);
  assert.equal(sps.levelIdc, 30);
  assert.equal(sps.width, 32);
  assert.equal(sps.height, 16);

  // 同一 SPS 对应的 avcC 前 4 字节应产出 avc1.42001E
  const avcC = new Uint8Array([1, 0x42, 0x00, 0x1e, 0xff, 0xe1]);
  return import('../src/codec-string.js').then(({ buildAvcCodecString }) => {
    assert.equal(buildAvcCodecString(avcC), 'avc1.42001E');
  });
});

test('parseH264Sps：带裁剪的 baseline（黄金值 28x12，验证 CropUnitX/Y=2）', () => {
  // 在 32x16 基础上开启 frame_cropping：L=R=T=B 各 ue(1)
  const body = bitsToBytes(`
    1 1 1 1 1   /* sps_id/log2max/poc_type/log2poc/ref 均 ue(0) */
    0           /* gaps */
    010         /* width MBs-1 = 1 → 32 */
    1           /* height MBs-1 = 0 → 16 */
    1           /* frame_mbs_only */
    1           /* direct_8x8 */
    1           /* frame_cropping_flag */
    010 010 010 010  /* L=R=T=B = 1 */
    0           /* vui */
    1           /* stop bit */
  `);
  const nalu = new Uint8Array([0x67, 66, 0x00, 30, ...body]);
  const sps = parseH264Sps(nalu);
  // 4:2:0（baseline 默认 idc=1）、frame_mbs_only=1 → 单位 X=Y=2
  assert.equal(sps.width, 32 - 2 - 2);
  assert.equal(sps.height, 16 - 2 - 2);
});

test('moreRbspData 正常回溯（不抛 seekBits TypeError）', () => {
  // 先消费语法元素，再判断是否还有 rbsp 数据
  const g1 = new ExpGolombReader(bitsToBytes('1 0000000'));
  assert.equal(g1.readUEG(), 0);
  assert.equal(g1.moreRbspData(), false, '只剩对齐全零 → 无更多数据');

  const g2 = new ExpGolombReader(bitsToBytes('1 1'));
  assert.equal(g2.readUEG(), 0);
  assert.equal(g2.moreRbspData(), true, '还有非零位 → 有数据');
});

/** se(0) = ue(0) = 单个 '1'；scaling list 全 0 增量即连续 16 个 se(0) */
const SE0_16 = '1'.repeat(16);

test('parseH264Sps：high profile(100) + scaling matrix 跳过', () => {
  // profileIdc=100 触发 chroma/bit_depth/scaling 分支；scaling 第 0 组 present=1
  // 必须真的消费 16 个 se(0)，否则后续语法全部错位（scaling_list 是经典错位源）
  const body = bitsToBytes(`
    1             /* seq_parameter_set_id ue(0) */
    010           /* chroma_format_idc ue(1) = 4:2:0 */
    1 1           /* bit_depth_luma/chroma_minus8 ue(0) */
    0             /* qpprime_y_zero_transform_bypass */
    1             /* seq_scaling_matrix_present_flag */
    1             /*   第 0 组 present=1 → skipScalingList(16) */
    ${SE0_16}
    0000000       /*   第 1-7 组 present=0 */
    1             /* log2_max_frame_num_minus4 */
    1             /* pic_order_cnt_type ue(0) */
    1             /* log2_max_pic_order_cnt_lsb_minus4 */
    1             /* max_num_ref_frames */
    0             /* gaps_in_frame_num_value_allowed */
    010           /* pic_width_in_mbs_minus1 ue(1) → 32 */
    1             /* pic_height_in_map_units_minus1 ue(0) → 16 */
    1             /* frame_mbs_only_flag */
    1             /* direct_8x8_inference */
    0             /* frame_cropping_flag */
    0             /* vui */
    1             /* rbsp stop bit */
  `);
  const nalu = new Uint8Array([0x67, 100, 0x00, 30, ...body]);
  const sps = parseH264Sps(nalu);
  assert.equal(sps.profileIdc, 100);
  assert.equal(sps.chromaFormatIdc, 1);
  assert.equal(sps.separateColourPlaneFlag, 0);
  assert.equal(sps.width, 32, 'scaling list 消费正确则尺寸不错位');
  assert.equal(sps.height, 16);
});

test('parseH264Sps：chroma_format_idc=3 走 12 组 scaling + separate_colour_plane（crop 单位 X=Y=1）', () => {
  const body = bitsToBytes(`
    1             /* seq_parameter_set_id */
    00100         /* chroma_format_idc ue(3) = 4:4:4 */
    0             /* separate_colour_plane_flag */
    1 1           /* bit_depth luma/chroma */
    0             /* qpprime */
    1             /* scaling present → 4:4:4 时 12 组 */
    1 ${SE0_16}
    00000000000   /*   第 1-11 组 present=0（共 11 个） */
    1 1 1 1       /* log2_frame_num / poc_type / log2_poc / max_ref */
    0             /* gaps */
    010           /* width mbs-1 = 1 → 32 */
    1             /* height mbs-1 = 0 → 16 */
    1             /* frame_mbs_only */
    1             /* direct_8x8 */
    1             /* frame_cropping_flag */
    010 010 010 010  /* L=R=T=B=1；idc=3 且 frame_mbs_only=1 → 单位 X=Y=1 */
    0             /* vui */
    1             /* stop */
  `);
  const nalu = new Uint8Array([0x67, 100, 0x00, 30, ...body]);
  const sps = parseH264Sps(nalu);
  assert.equal(sps.chromaFormatIdc, 3);
  assert.equal(sps.separateColourPlaneFlag, 0);
  assert.equal(sps.width, 32 - 1 - 1, 'idc=3 → CropUnitX=1');
  assert.equal(sps.height, 16 - 1 - 1, 'idc=3 且 frame_mbs_only=1 → CropUnitY=1');
});

test('parseH264Sps：chroma_format_idc=0(mono) + frame_mbs_only=0（高度翻倍，CropUnitY=2）', () => {
  const body = bitsToBytes(`
    1             /* seq_parameter_set_id */
    1             /* chroma_format_idc ue(0) = mono */
    1 1           /* bit_depth luma/chroma */
    0             /* qpprime */
    0             /* scaling present = 0 */
    1 1 1 1       /* log2_frame_num / poc_type / log2_poc / max_ref */
    0             /* gaps */
    010           /* width mbs-1 = 1 → 32 */
    1             /* height mbs-1 = 0 */
    0             /* frame_mbs_only_flag = 0 → 场编码，高度按 (2-0) 翻倍 */
    1             /* mb_adaptive_frame_field_flag */
    1             /* direct_8x8 */
    1             /* frame_cropping_flag */
    010 010 010 010  /* L=R=T=B=1；idc=0 → X=1，Y=2-0=2 */
    0             /* vui */
    1             /* stop */
  `);
  const nalu = new Uint8Array([0x67, 100, 0x00, 30, ...body]);
  const sps = parseH264Sps(nalu);
  assert.equal(sps.chromaFormatIdc, 0);
  assert.equal(sps.width, 32 - 1 - 1, 'idc=0 → CropUnitX=1');
  assert.equal(sps.height, (2 - 0) * 16 - 2 - 2, 'frame_mbs_only=0 → 高度翻倍再裁 Y=2');
});

test('parseH264Sps：pic_order_cnt_type=1 的循环分支', () => {
  const body = bitsToBytes(`
    1             /* seq_parameter_set_id */
    1             /* log2_max_frame_num_minus4 */
    010           /* pic_order_cnt_type ue(1) */
    0             /* delta_pic_order_always_zero_flag */
    011           /* offset_for_non_ref_pic se(-1) */
    1             /* offset_for_top_to_bottom_field se(0) */
    011           /* num_ref_frames_in_pic_order_cnt_cycle ue(2) */
    010           /*   se(+1) */
    00101         /*   se(-2) */
    1             /* max_num_ref_frames */
    0             /* gaps */
    010           /* width mbs-1 = 1 → 32 */
    1             /* height mbs-1 = 0 → 16 */
    1             /* frame_mbs_only */
    1             /* direct_8x8 */
    0             /* frame_cropping */
    0             /* vui */
    1             /* stop */
  `);
  const nalu = new Uint8Array([0x67, 66, 0x00, 30, ...body]);
  const sps = parseH264Sps(nalu);
  assert.equal(sps.width, 32, 'poc type 1 的循环被正确消费，尺寸不错位');
  assert.equal(sps.height, 16);
});

test('parseH264Sps：非 SPS NAL 抛 PARSE_ERROR', () => {
  // 0x68 → nal_type=8（PPS）
  assert.throws(
    () => parseH264Sps(new Uint8Array([0x68, 66, 0x00, 30, 0x80])),
    (e) => e.code === 'PARSE_ERROR' && /SPS/.test(e.message),
  );
});

test('stripEmulationPrevention 导出可用（00 00 03 → 00 00）', () => {
  assert.deepEqual(
    Array.from(stripEmulationPrevention(Uint8Array.from([1, 0, 0, 3, 0, 1]))),
    [1, 0, 0, 0, 1],
  );
  // 后续字节高位非 0 时不是 EPB，保留原样（防误伤真实数据 00 00 03 FF）
  assert.deepEqual(
    Array.from(stripEmulationPrevention(Uint8Array.from([0, 0, 3, 0xff]))),
    [0, 0, 3, 0xff],
  );
});

test('ExpGolombReader 可直接接收 BitReader（复用位流位置）', () => {
  const reader = new BitReader(bitsToBytes('1 010 11'));
  const g = new ExpGolombReader(reader);
  assert.equal(g.readUEG(), 0);
  assert.equal(g.readUEG(), 1);
  // readBits/readBool 直通底层 BitReader
  assert.equal(g.readBits(2), 0b11);
  const g2 = new ExpGolombReader(new BitReader(bitsToBytes('10')));
  assert.equal(g2.readBool(), true);
  assert.equal(g2.moreRbspData(), false, '位流耗尽 → 无更多 rbsp 数据');
});

test('readUEG：31 个前导零不溢出 32 位有符号整数（回归 core 建议项）', () => {
  // 31 个前导零 + 终止 1 + 31 位全 1 载荷
  // ue 值 = (2^31 - 1) + (2^31 - 1) = 2^32 - 2 = 4294967294
  const bits = '0'.repeat(31) + '1' + '1'.repeat(31);
  const g = new ExpGolombReader(bitsToBytes(bits));
  const v = g.readUEG();
  assert.ok(Number.isSafeInteger(v), '结果应为安全整数');
  assert.ok(v > 0, '必须为正数');
  assert.equal(v, 4294967294, '修复前 (1<<31) 溢出返回 -2');
});
