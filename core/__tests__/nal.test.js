import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanAnnexBNalUnits,
  splitAnnexB,
  annexbToAvcc,
  splitAvcc,
  avccToAnnexb,
  removeEmulationPrevention,
  addEmulationPrevention,
  h264NalType,
  hevcNalType,
  isH264Idr,
  isHevcIrap,
} from '../src/nal.js';

/** 构造一个含 emulation prevention 风险字节的 NAL：IDR + [00 00 03 00] */
const NAL1 = new Uint8Array([0x65, 0x00, 0x00, 0x03, 0x00, 0x80, 0xab]);
const NAL2 = new Uint8Array([0x41, 0x9a, 0x02, 0x05]);

test('scanAnnexB 兼容 3/4 字节起始码与首尾零', () => {
  // 注：EOF 处的悬挂尾零无法与"载荷真实以 00 结尾"区分，按约定归入最后单元，
  // 因此 fixture 不放 EOF 尾零；中间分隔用的多余零会被剔除。
  const stream = new Uint8Array([
    0, 0, 0, 1, ...NAL1, // 4 字节码开头
    0, 0, 0, 0, 0, 0,    // 前一单元的 trailing zeros（归入分隔符）
    0, 0, 1, ...NAL2,    // 3 字节码
  ]);
  const units = scanAnnexBNalUnits(stream);
  assert.equal(units.length, 2);
  assert.deepEqual([...stream.subarray(units[0].offset, units[0].offset + units[0].size)], [...NAL1]);
  assert.deepEqual([...stream.subarray(units[1].offset, units[1].offset + units[1].size)], [...NAL2]);
});

test('annexbToAvcc → splitAvcc 无损往返', () => {
  const stream = new Uint8Array([0, 0, 0, 1, ...NAL1, 0, 0, 1, ...NAL2]);
  const avcc = annexbToAvcc(stream, 4);
  const units = splitAvcc(avcc, 4);
  assert.equal(units.length, 2);
  assert.deepEqual([...units[0]], [...NAL1]);
  assert.deepEqual([...units[1]], [...NAL2]);

  // 长度前缀应为 00 00 00 07 / 00 00 00 04
  const view = new DataView(avcc.buffer, avcc.byteOffset, avcc.byteLength);
  assert.equal(view.getUint32(0), NAL1.length);
  assert.equal(view.getUint32(4 + NAL1.length), NAL2.length);
});

test('avccToAnnexb 往返与短起始码', () => {
  const avcc = annexbToAvcc(new Uint8Array([0, 0, 0, 1, ...NAL2]), 4);
  const back = avccToAnnexb(avcc, 4, true);
  assert.deepEqual([...back], [0, 0, 0, 1, ...NAL2]);
  const short = avccToAnnexb(avcc, 4, false);
  assert.deepEqual([...short.subarray(0, 3)], [0, 0, 1]);
});

test('emulation prevention 摘除/回加往返', () => {
  const rbsp = removeEmulationPrevention(NAL1);
  assert.deepEqual([...rbsp], [0x65, 0x00, 0x00, 0x00, 0x80, 0xab]);
  const ebsp = addEmulationPrevention(rbsp);
  assert.deepEqual([...ebsp], [...NAL1]);
});

test('splitAvcc 对损坏长度抛 PARSE_ERROR', () => {
  const bad = new Uint8Array([0, 0, 0, 99, 1, 2]);
  assert.throws(() => splitAvcc(bad), (e) => e.code === 'PARSE_ERROR');
});

test('NAL 类型判断（H.264 / H.265）', () => {
  assert.equal(h264NalType(NAL1), 5); // IDR → 关键帧
  assert.equal(isH264Idr(NAL1), true);
  assert.equal(isH264Idr(NAL2), false);

  // HEVC: type = ((byte0 & 0x7e) >> 1)；19(IDR_W_RADL)→ byte0 = 19<<1 = 0x26
  const hevcIdr = new Uint8Array([0x26, 0x01, 0xaf]);
  const hevlcTrail = new Uint8Array([0x01 << 1, 0x02]); // TRAIL_N=1
  assert.equal(hevcNalType(hevcIdr), 19);
  assert.equal(isHevcIrap(hevcIdr), true);
  assert.equal(isHevcIrap(hevlcTrail), false);
});
