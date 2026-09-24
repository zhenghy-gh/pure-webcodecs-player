/**
 * ByteStream/ByteWriter 残余分支补测（wave 125）：
 *  - 构造器三态边界：Uint8Array 窗口越界、ArrayBufferView 子窗口尊重、非法类型
 *  - position setter / rewind / read overflow / patchU32 越界
 *  - 定点数读取（8.8、2.30）与 writeF32 往返
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ByteStream, ByteWriter } from '../src/byte-stream.js';

test('构造器：Uint8Array 窗口越界 → sourceError', () => {
  const u8 = new Uint8Array(8);
  assert.throws(
    () => new ByteStream(u8, 4, 8), // 4+8 > 8
    (e) => e.code === 'SOURCE_ERROR' && /window out of range/.test(e.message)
  );
});

test('构造器：ArrayBufferView 子窗口尊重 byteOffset/byteLength', () => {
  const i32 = new Int32Array([0x01020304, 0x05060708]);
  const s = new ByteStream(i32, 4, 4); // 第二个 int32 的内存字节（小端存放）
  assert.equal(s.length, 4);
  assert.equal(s.readU32(), 0x08070605); // 大端重解释
});

test('constructor rejects fractional and non-finite windows', () => {
  const buffer = new ArrayBuffer(8);
  for (const [offset, length] of [[NaN, 1], [0, 1.5], [Infinity, 1], [1, NaN]]) {
    assert.throws(() => new ByteStream(buffer, offset, length), (error) => error.code === 'SOURCE_ERROR');
  }
});

test('构造器：非法类型 → sourceError', () => {
  assert.throws(
    () => new ByteStream('not a buffer'),
    (e) => e.code === 'SOURCE_ERROR' && /expects ArrayBuffer or typed array/.test(e.message)
  );
});

test('position setter 委托 seek；rewind 回退游标', () => {
  const s = new ByteStream(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  s.position = 6;
  assert.equal(s.position, 6);
  s.rewind(4);
  assert.equal(s.position, 2);
  assert.equal(s.readU16(), 0x0304);
});

test('ByteStream rejects invalid read and patch lengths', () => {
  const reader = new ByteStream(new Uint8Array(4));
  for (const length of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => reader.readSlice(length), (error) => error.code === 'SOURCE_ERROR');
  }
  const writer = new ByteWriter();
  writer.writeU32(1);
  for (const offset of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => writer.patchU32(offset, 0), (error) => error.code === 'SOURCE_ERROR');
  }
});

test('readSlice 越界 → read overflow sourceError', () => {
  const s = new ByteStream(new Uint8Array(4));
  assert.throws(
    () => s.readSlice(5),
    (e) => e.code === 'SOURCE_ERROR' && /read overflow/.test(e.message)
  );
});

test('readFixed8_8 / readFixed2_30 定点数语义', () => {
  const w = new ByteWriter(16);
  w.writeU16(0x4000); // 8.8 → 64.0
  w.writeI32(0x40000000); // 2.30 → 1.0
  const s = new ByteStream(w.toUint8Array());
  assert.equal(s.readFixed8_8(), 64);
  assert.equal(s.readFixed2_30(), 1);
});

test('writeF32 大端往返', () => {
  const w = new ByteWriter(8);
  w.writeF32(3.5);
  const s = new ByteStream(w.toUint8Array());
  assert.equal(s.readF32(), 3.5);
});

test('ByteStream.readCString validates length and does not consume beyond limit', () => {
  const reader = new ByteStream(new Uint8Array([65, 0, 66, 0]));
  for (const length of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => reader.readCString(length), (error) => error.code === 'SOURCE_ERROR');
  }
  assert.equal(reader.readCString(0), '');
  assert.equal(reader.position, 0);
  assert.equal(reader.readCString(1), 'A');
  assert.equal(reader.position, 1, 'terminator beyond maxLen remains unread');
  assert.equal(reader.readCString(1), '');
  assert.equal(reader.position, 2, 'in-range terminator is consumed');
  assert.equal(reader.readCString(1), 'B');
  assert.equal(reader.position, 3);
  assert.equal(reader.readCString(1), '');
  assert.equal(reader.position, 4);
});

test('ByteWriter accepts zero capacity and rejects invalid initial capacity', () => {
  const writer = new ByteWriter(0);
  writer.writeU8(0x5a);
  assert.deepEqual([...writer.toUint8Array()], [0x5a]);
  for (const capacity of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => new ByteWriter(capacity), (error) => error.code === 'SOURCE_ERROR');
  }
});

test('patchU32 validates values and offsets', () => {
  const w = new ByteWriter(16);
  w.writeU32(1);
  for (const value of [-1, 1.5, 0x100000000]) {
    assert.throws(() => w.patchU32(0, value), (error) => error.code === 'SOURCE_ERROR');
    assert.equal(w.toUint8Array()[3], 1, 'invalid value must not mutate the field');
  }
  assert.throws(
    () => w.patchU32(2, 0x11223344), // 2+4 > 4
    (e) => e.code === 'SOURCE_ERROR' && /patchU32 out of range/.test(e.message)
  );
});
