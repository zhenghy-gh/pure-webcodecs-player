/**
 * samples/fixtures/__tests__/bytes.test.js —— 字节工具层自测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  u8, concat, ascii, utf8, u16be, u24be, u32be, u64be,
  f64be, i16be, BitWriter, BitReader, crc32Mpeg2, fromHex,
} from '../index.js';

test('crc32Mpeg2 通过标准校验向量', () => {
  // CRC-32/MPEG-2("123456789") = 0x0376E6E7（check 值见 CRC 目录标准表）
  assert.equal(crc32Mpeg2(utf8('123456789')), 0x0376e6e7);
});

test('大端整数写入器宽度正确', () => {
  assert.deepEqual(Array.from(u16be(0x1234)), [0x12, 0x34]);
  assert.deepEqual(Array.from(u24be(0xabcdef)), [0xab, 0xcd, 0xef]);
  assert.deepEqual(Array.from(u32be(1)), [0, 0, 0, 1]);
  assert.deepEqual(Array.from(u64be(1n)), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(i16be(-1)), [0xff, 0xff]);
  const f = f64be(1.5);
  assert.equal(new DataView(f.buffer).getFloat64(0), 1.5);
});

test('BitWriter/BitReader 对非整字节字段往返一致', () => {
  const w = new BitWriter();
  w.put(44100, 20);
  w.put(1, 3); // channels - 1
  w.put(15, 5); // bitsPerSample - 1
  w.put(BigInt(2) ** BigInt(35) + 123n, 36); // 大数值走 bigint
  const bytes = w.finish();
  assert.equal(bytes.length, (20 + 3 + 5 + 36) / 8);

  const r = new BitReader(bytes);
  assert.equal(r.read(20), 44100n);
  assert.equal(r.read(3), 1n);
  assert.equal(r.read(5), 15n);
  assert.equal(r.read(36), 2n ** 35n + 123n);
});

test('concat 与 ascii/fromHex 组合可用', () => {
  const joined = concat(ascii('AB'), fromHex('00 FF'));
  assert.deepEqual(Array.from(joined), [0x41, 0x42, 0x00, 0xff]);
  assert.deepEqual(Array.from(u8(1, 2)), [1, 2]);
});
