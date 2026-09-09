import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream, ByteWriter } from '../src/byte-stream.js';

test('ByteStream 大端整数读取', () => {
  //        u8   i8    u16     i16       u24         u32           f32
  const bytes = new Uint8Array([
    0xff, 0x80, 0x12, 0x34, 0xff, 0xfe, 0x00, 0x12, 0xab,
    0xde, 0xad, 0xbe, 0xef, 0x3f, 0x80, 0x00, 0x00,
  ]);
  const s = new ByteStream(bytes);
  assert.equal(s.readU8(), 0xff);
  assert.equal(s.readI8(), -128);
  assert.equal(s.readU16(), 0x1234);
  assert.equal(s.readI16(), -2);
  assert.equal(s.readU24(), 0x0012ab);
  assert.equal(s.readU32(), 0xdeadbeef);
  assert.equal(Math.abs(s.readF32() - 1.0) < 1e-6, true);
  assert.equal(s.eof, true);
});

test('ByteStream U64 / 定点数 / fourcc', () => {
  const w = new ByteWriter();
  w.writeU64(0x1122334455667788n).writeFixed16_16(1.5).writeFourCC('ftyp').writeUtf8('中文');
  const s = new ByteStream(w.toUint8Array());
  assert.equal(s.readU64(), 0x1122334455667788n);
  assert.equal(s.readFixed16_16(), 1.5);
  assert.equal(s.readFourCC(), 'ftyp');
  assert.equal(s.readUtf8(6), '中文');
});

test('ByteStream 越界抛 SOURCE_ERROR', () => {
  const s = new ByteStream(new Uint8Array(4));
  assert.throws(() => s.readU32().valueOf && s.skip(5), (err) => err.code === 'SOURCE_ERROR');
});

test('ByteStream 窗口视图与 seek', () => {
  const big = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const s = new ByteStream(big.buffer, 2, 4); // [2..5]
  assert.equal(s.length, 4);
  assert.equal(s.readU16(), 0x0203);
  s.seek(0);
  assert.equal(s.peekFourCC(), String.fromCharCode(2, 3, 4, 5));
  assert.equal(s.position, 0, 'peek 不移动游标');
});

test('readU64Number 拒绝超出安全范围', async () => {
  const { sourceError } = await import('../src/errors.js');
  const w = new ByteWriter();
  w.writeU64(Number.MAX_SAFE_INTEGER + 1);
  const s = new ByteStream(w.toUint8Array());
  assert.throws(() => s.readU64Number(), (e) => e instanceof Error && e.code === sourceError('').code);
});

test('ByteWriter patchU32 与扩容', () => {
  const w = new ByteWriter(4); // 小初始容量触发多次扩容
  for (let i = 0; i < 100; i++) w.writeU32(i);
  w.patchU32(8, 0xffffffff);
  const s = new ByteStream(w.toUint8Array());
  s.seek(8);
  assert.equal(s.readU32(), 0xffffffff);
  assert.equal(w.length, 400);
});

test('ByteStream 接受 ArrayBufferView 并尊重子窗口（回归 core 建议项）', () => {
  const buf = new ArrayBuffer(16);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 16; i++) u8[i] = i;
  // DataView 覆盖 [4,12)（length 8）
  const view = new DataView(buf, 4, 8);
  // 不再忽略子窗口长度：取 [0,4) → 实际字节 [4,8)
  const s = new ByteStream(view, 0, 4);
  assert.equal(s.length, 4, '修复前忽略子窗口长度得到 8');
  assert.equal(s.readU8(), 4);
  assert.equal(s.readU8(), 5);
  assert.equal(s.readU8(), 6);
  assert.equal(s.readU8(), 7);
  // 默认整视图仍可用
  const full = new ByteStream(view);
  assert.equal(full.length, 8);
  assert.equal(full.readU8(), 4);
  // 越界子窗口抛 SOURCE_ERROR
  assert.throws(() => new ByteStream(view, 0, 16), (err) => err.code === 'SOURCE_ERROR');
});
