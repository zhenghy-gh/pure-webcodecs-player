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

test('构造器：所有输入类型统一要求合法字节窗口', () => {
  const makeBuffers = () => [
    new ArrayBuffer(8), new Uint8Array(8), new Int32Array(2), new DataView(new ArrayBuffer(8)),
  ];
  const invalidArguments = [
    [null, 1], [0, null], [0.5, 1], [0, 1.5], [NaN, 1], [0, NaN],
    [Infinity, 1], [0, Infinity], [-1, 1], [0, -1],
    [Number.MAX_SAFE_INTEGER + 1, 0], [0, Number.MAX_SAFE_INTEGER + 1], [7, 2],
  ];
  for (const createBuffer of [() => new ArrayBuffer(8), () => new Uint8Array(8),
    () => new Int32Array(2), () => new DataView(new ArrayBuffer(8))]) {
    for (const [offset, length] of invalidArguments) {
      assert.throws(() => new ByteStream(createBuffer(), offset, length),
        (error) => error.code === 'SOURCE_ERROR', `${String(offset)} / ${String(length)}`);
    }
  }
  for (const buffer of makeBuffers()) {
    const end = new ByteStream(buffer, 8, 0);
    assert.equal(end.length, 0);
    const full = new ByteStream(buffer, 0, 8);
    assert.equal(full.length, 8);
    const omittedOffset = new ByteStream(buffer, undefined, 8);
    assert.equal(omittedOffset.length, 8);
    const defaultWindow = new ByteStream(buffer, 2);
    assert.equal(defaultWindow.length, 6);
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

test('readSlice 与 peekSlice 拒绝负长度且保持游标', () => {
  const s = new ByteStream(new Uint8Array([1, 2, 3]));
  s.seek(1);
  assert.throws(() => s.readSlice(-1), (e) => e.code === 'SOURCE_ERROR');
  assert.equal(s.position, 1);
  assert.throws(() => s.peekSlice(-1), (e) => e.code === 'SOURCE_ERROR');
  assert.equal(s.position, 1);
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

test('patchU32 越界 → sourceError', () => {
  const w = new ByteWriter(16);
  w.writeU32(1);
  assert.throws(
    () => w.patchU32(2, 0x11223344), // 2+4 > 4
    (e) => e.code === 'SOURCE_ERROR' && /patchU32 out of range/.test(e.message)
  );
});
