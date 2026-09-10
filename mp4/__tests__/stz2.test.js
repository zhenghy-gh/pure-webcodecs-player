/**
 * stz2（compact sample size）解析专项。
 * 背景：此前 box-parser 把 stz2 直接映射到 parseStsz，把 field_size 当 defaultSize、
 * 把打包尺寸表当 u32 数组读，field_size<32 的真实文件会静默错解（第八十八波修复）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream } from '../../core/src/index.js';
import { parseStz2 } from '../src/box-parser.js';

/** 手拼一个 stz2 盒体（从 contentStart 起）：version/flags + reserved(3)+field_size(1) + count + 表 */
function buildStz2(fieldSize, count, packedBytes) {
  const bodyLen = 4 + 4 + 4 + packedBytes.length;
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.byteLength);
  out.set([0x73, 0x74, 0x7a, 0x32], 4); // 'stz2'
  dv.setUint32(8, 0);                    // version/flags
  dv.setUint32(12, fieldSize);           // reserved(24bit)=0 + field_size
  dv.setUint32(16, count);
  out.set(packedBytes, 20);
  return out;
}

function parse(bytes) {
  return parseStz2(new ByteStream(bytes, 8, bytes.byteLength - 8));
}

test('stz2：field_size=16（每样本 2 字节）', () => {
  const sizes = [100, 200, 32100];
  const packed = new Uint8Array(sizes.length * 2);
  const dv = new DataView(packed.buffer);
  sizes.forEach((v, i) => dv.setUint16(i * 2, v));
  const r = parse(buildStz2(16, sizes.length, packed));
  assert.equal(r.defaultSize, 0);
  assert.equal(r.sampleCount, 3);
  assert.deepEqual(r.sizes, sizes);
});

test('stz2：field_size=8（每样本 1 字节）', () => {
  const sizes = [5, 250, 7, 128];
  const r = parse(buildStz2(8, sizes.length, Uint8Array.from(sizes)));
  assert.deepEqual(r.sizes, sizes);
  assert.equal(r.sampleCount, 4);
});

test('stz2：field_size=4（每字节打包 2 个，高半字节在前，奇数 count 末位 padding）', () => {
  // 5 个样本 → 3 字节：[4,7][2,9][1,pad]
  const packed = Uint8Array.from([0x47, 0x29, 0x10]);
  const r = parse(buildStz2(4, 5, packed));
  assert.deepEqual(r.sizes, [4, 7, 2, 9, 1]);
  assert.equal(r.sampleCount, 5);
});

test('stz2：field_size 非法（如 12）→ 抛 PARSE_ERROR', () => {
  const bytes = buildStz2(12, 1, Uint8Array.from([0x00]));
  assert.throws(() => parse(bytes), (e) => e.code === 'PARSE_ERROR');
});

test('stz2：全链路——样本表消费方按 stsz 同形状读取', () => {
  // 下游 demuxer.js:471 以 stbl.stsz ?? stbl.stz2 取值，返回形状必须与 parseStsz 一致
  const sizes = [4, 4, 4, 4];
  const packed = new Uint8Array(sizes.length / 2);
  for (let i = 0; i < packed.length; i++) packed[i] = 0x44; // 每字节两个 4 位尺寸，各为 4
  const r = parse(buildStz2(4, 4, packed));
  assert.deepEqual(r.sizes, sizes);
  assert.equal(r.sampleCount, sizes.length);
  assert.equal(r.defaultSize, 0);
});
