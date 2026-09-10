/**
 * mkv-ebml-varint.test.js —— EBML 变长整数(VINT)编解码与边界
 *
 * 覆盖：vintLength 全首字节枚举、readSize/readId 截断越界、8 字节宽度
 * 的未知长度与超安全整数、encodeSize 极值与溢出、roundtrip 大值。
 * （crc32 / Reader 类在本 mkv 模块中不存在，故跳过——详见返回说明。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  vintLength, readId, readSize, encodeSize, encodeUnknownSize,
  readUInt, readInt, EbmlError,
} from '../src/index.js';

// ── vintLength：首字节 → 标记位定长，全枚举不抛异常 ─────────
test('vintLength：0x00..0xFF 全部首字节长度均落在 1..8 且仅 0x00 抛错', () => {
  assert.throws(() => vintLength(0), EbmlError);
  assert.throws(() => vintLength(undefined), EbmlError);
  assert.throws(() => vintLength(NaN), EbmlError);
  for (let b = 1; b <= 0xff; b++) {
    const n = vintLength(b);
    assert.ok(n >= 1 && n <= 8, `首字节 0x${b.toString(16)} 长度越界: ${n}`);
  }
  // 边界：0xFF 全 1 解读为 1 字节（未知长度标记）
  assert.equal(vintLength(0xff), 1);
  assert.equal(vintLength(0x01), 8); // 仅在最高位
});

test('vintLength：标记位位置精确对应位数', () => {
  assert.equal(vintLength(0x80), 1);
  assert.equal(vintLength(0x7f), 2);
  assert.equal(vintLength(0x40), 2);
  assert.equal(vintLength(0x20), 3);
  assert.equal(vintLength(0x10), 4);
  assert.equal(vintLength(0x08), 5);
  assert.equal(vintLength(0x04), 6);
  assert.equal(vintLength(0x02), 7);
  assert.equal(vintLength(0x01), 8);
});

// ── readId / readSize 截断越界 ────────────────────────────
test('readId：越界/截断抛 EbmlError', () => {
  // 流结束返回 null
  assert.equal(readId(Uint8Array.of(), 0), null);
  assert.equal(readId(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), 4), null);
  // 声明长度超出缓冲
  assert.throws(() => readId(Uint8Array.of(0x1a, 0x45), 0, 2), EbmlError);
});

test('readSize：声明长度超出缓冲抛 EbmlError', () => {
  // 0x40 表示 2 字节长度，但 buffer 只 1 字节
  assert.throws(() => readSize(Uint8Array.of(0x40), 0, 1), EbmlError);
  // 起点越界
  assert.throws(() => readSize(Uint8Array.of(0x80), 5, 5), EbmlError);
});

// ── 8 字节宽度：未知长度、安全整数、超界 ──────────────────
test('readSize：8 字节全 1 数据位 → 未知长度(-1)', () => {
  const allOnes = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const dec = readSize(allOnes, 0);
  assert.equal(dec.unknown, true);
  assert.equal(dec.value, -1);
  assert.equal(dec.length, 8);
});

test('readSize：8 字节非全 1 在安全整数内 → 正常解码', () => {
  const enc = encodeSize(123456789, 8);
  assert.equal(enc.length, 8);
  const dec = readSize(enc, 0);
  assert.equal(dec.unknown, false, '8 字节普通值被误判未知');
  assert.equal(dec.value, 123456789);
});

test('readSize：8 字节值超过 MAX_SAFE_INTEGER → 抛 EbmlError', () => {
  // 0x01 后接 0x20 → big = 0x20 * 2^48 > Number.MAX_SAFE_INTEGER
  const tooBig = Uint8Array.of(0x01, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  assert.throws(() => readSize(tooBig, 0), EbmlError);
});

test('readSize：8 字节恰为 MAX_SAFE_INTEGER 可往返', () => {
  const big = Number.MAX_SAFE_INTEGER;
  const enc = encodeSize(big);
  assert.equal(enc.length, 8);
  const dec = readSize(enc, 0);
  assert.equal(dec.value, big);
  assert.equal(dec.unknown, false);
});

// ── encodeSize 极值与溢出 ────────────────────────────────
test('encodeSize：负值与过大值抛错', () => {
  assert.throws(() => encodeSize(-5), EbmlError);
  // 需要 9 字节才能编码 → 溢出
  assert.throws(() => encodeSize(2 ** 56), EbmlError);
});

test('encodeSize：每宽度最大可表示值(2^(7n)-2)往返', () => {
  for (let len = 1; len <= 7; len++) {
    const maxUsable = 2 ** (7 * len) - 2;
    const enc = encodeSize(maxUsable, len);
    assert.equal(enc.length, len, `宽度 ${len} 编码长度不符`);
    const dec = readSize(enc, 0);
    assert.equal(dec.unknown, false, `宽度 ${len} 最大值被误判未知`);
    assert.equal(dec.value, maxUsable);
  }
});

test('encodeSize：强制最小长度产生高位前导零', () => {
  // 单字节域可表示 0..126；强制 3 字节编码 0 → 0x20 0x00 0x00
  assert.deepEqual([...encodeSize(0, 3)], [0x20, 0x00, 0x00]);
  assert.deepEqual([...encodeSize(5, 2)], [0x40, 0x05]);
});

test('encodeUnknownSize：各宽度解码为 unknown 且长度匹配', () => {
  for (const n of [1, 2, 4, 8]) {
    const enc = encodeUnknownSize(n);
    assert.equal(enc.length, n);
    const dec = readSize(enc, 0);
    assert.equal(dec.unknown, true);
    assert.equal(dec.value, -1);
  }
});

// ── readUInt / readInt 宽度边界 ──────────────────────────
test('readUInt/readInt：零宽与安全整数边界', () => {
  assert.equal(readUInt(Uint8Array.of()), 0);   // 空 → 0
  assert.equal(readInt(Uint8Array.of()), 0);
  // 八字节全 ff = 2^64-1，超出 IEEE754 安全整数范围 → 抛 EbmlError（越界保护，非截断）
  assert.throws(
    () => readUInt(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)),
    EbmlError
  );
});

test('readUInt：8 字节超安全整数抛 EbmlError', () => {
  // 2^63 ≈ 9.2e18 远超 MAX_SAFE
  const big = Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0);
  assert.throws(() => readUInt(big), EbmlError);
  // 宽度 > 8 直接非法
  assert.throws(() => readUInt(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9)), EbmlError);
});
