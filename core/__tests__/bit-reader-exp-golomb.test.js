import test from 'node:test';
import assert from 'node:assert/strict';
import { BitReader } from '../src/bit-reader.js';
import { ExpGolombReader, parseH264Sps } from '../src/exp-golomb.js';

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
