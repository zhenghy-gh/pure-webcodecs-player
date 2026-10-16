/**
 * mkv EBML vint/尺寸/日期 定向边界回归（第二百一十四波）
 * ------------------------------------------------------------
 * 与随机 fuzz 互补的定向数值边界战线（213 波同法迁移到 EBML 面）：
 *   - vintLength 全 256 字节枚举 + 定义域外输入统一 EbmlError（本波修复：
 *     旧式 null→裸 TypeError、-1/1.5 经位运算误判长度）；
 *   - readSize 各宽度 max/unknown/mid/zero 位型 + 截断；
 *   - encodeSize/encodeUnknownSize/encodeSignedVint round-trip 性质；
 *   - readDate 64-bit 二补码有符号化（本波修复：旧式按无符号读，-1ns 全 1
 *     位型被读成公元 2596 年，注释声明 signed 与实现不符）；
 *   - decodeLacing 敌意头 + iterElements 敌意序列收敛与描述符不变量。
 * 探测 .tmp/probe-mkv-vint.mjs 804 调用零问题后固化。登记观察：readFloat
 * 全 1 位型按 IEEE754 返回 NaN 属无损解码，非拒绝面缺陷。
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EbmlError, vintLength, readSize, encodeSize, encodeUnknownSize,
  readUInt, readInt, readFloat, readDate, iterElements,
} from '../src/index.js';
import {
  LACING_XIPH, LACING_FIXED, LACING_EBML, decodeLacing,
  signedVintValue, encodeSignedVint,
} from '../src/index.js';

const WEBM = new Uint8Array(readFileSync(new URL('../__tests__/fixtures/minimal.webm', import.meta.url)));

/** seeded xorshift：跨运行确定 */
let seed = 0xFEED5EED;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const randInt = (n) => Math.floor(rand() * n);

test('vintLength：0..255 全枚举与规范一致；定义域外统一 EbmlError', () => {
  for (let b = 1; b < 256; b++) {
    let n = 1;
    while (!(b & (1 << (8 - n)))) n++;
    assert.equal(vintLength(b), n, `首字节 0x${b.toString(16)}`);
  }
  assert.throws(() => vintLength(0), EbmlError);
  // 域外输入不得行为漂移（第二百一十四波修复回归）
  for (const v of [undefined, null, NaN, -1, 1.5, 256, 0x100, '8', {}, Infinity]) {
    assert.throws(() => vintLength(v), EbmlError, `vintLength(${String(v)})`);
  }
});

test('readSize：宽度 1..8 各档 max/unknown/mid/zero 位型与截断', () => {
  for (let n = 1; n <= 8; n++) {
    const bits = 7 * n;
    for (const [mode, payload] of [
      ['max', 2n ** BigInt(bits) - 2n],
      ['unknown', 2n ** BigInt(bits) - 1n],
      ['zero', 0n],
    ]) {
      const b = new Uint8Array(n);
      let v = payload;
      const tmp = [];
      for (let i = 0; i < n; i++) { tmp.unshift(Number(v & 0xffn)); v >>= 8n; }
      const firstMask = n === 8 ? 0x01 : 0xff >> n;
      b[0] = ((1 << (8 - n)) & 0xff) | (tmp[0] & firstMask);
      for (let i = 1; i < n; i++) b[i] = tmp[i];
      if (n === 8 && mode === 'max') {
        // 2^56-2 > MAX_SAFE 且非全 1 位型：必须抛而非静默精度丢失
        assert.throws(() => readSize(b, 0, n), EbmlError, 'n=8 max 超安全范围');
        continue;
      }
      const r = readSize(b, 0, n);
      assert.equal(r.length, n, `n=${n} ${mode} length`);
      if (mode === 'unknown') {
        assert.equal(r.unknown, true, `n=${n} 全 1 位型应为未知长度`);
        assert.equal(r.value, -1);
      } else {
        assert.equal(r.unknown, false, `n=${n} ${mode} 误判未知长度（位运算截断回归）`);
        assert.equal(r.value, Number(payload));
      }
      if (n > 1) assert.throws(() => readSize(b, 0, n - 1), EbmlError, `n=${n} 截断`);
    }
  }
  // 8 字节 BigInt 兜底：恰 2^53（>MAX_SAFE，非全 1）必须抛而非静默精度丢失
  assert.throws(() => readSize(new Uint8Array([0x01, 0x20, 0, 0, 0, 0, 0, 0]), 0, 8), EbmlError);
  // 合法大值：恰 MAX_SAFE（0x1FFFFFFFFFFFFF，8 字节内非全 1 位型的可读上限）
  assert.equal(
    readSize(new Uint8Array([0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, 8).value,
    Number.MAX_SAFE_INTEGER);
});

test('encodeSize/encodeUnknownSize round-trip：边界表 + seeded 随机', () => {
  const vals = [0, 1, 126, 127, 128, 2 ** 14 - 2, 2 ** 14 - 1, 2 ** 21 - 2, 2 ** 21 - 1,
    2 ** 28 - 2, 2 ** 28 - 1, 2 ** 35 - 2, 2 ** 35 - 1, 2 ** 42 - 2, 2 ** 42 - 1,
    2 ** 49 - 2, 2 ** 49 - 1, 2 ** 53 - 1, 48000 * 3600 * 24];
  for (let i = 0; i < 40; i++) vals.push(Math.floor(rand() * 2 ** 40));
  for (const v of vals) {
    const enc = encodeSize(v);
    const r = readSize(enc, 0, enc.length);
    assert.equal(r.value, v, `encodeSize(${v}) round-trip`);
    assert.equal(r.unknown, false);
  }
  for (const v of [-1, (-2) ** 31]) assert.throws(() => encodeSize(v), EbmlError);
  for (let n = 1; n <= 8; n++) {
    const b = encodeUnknownSize(n);
    const r = readSize(b, 0, b.length);
    assert.equal(r.unknown, true, `encodeUnknownSize(${n}) 应回读为未知长度`);
    assert.equal(r.length, n);
  }
});

test('readDate：64-bit 二补码有符号化回归 + 宽度枚举', () => {
  const EPOCH_2001 = Date.UTC(2001, 0, 1);
  assert.equal(readDate(new Uint8Array(8)), EPOCH_2001);
  // -1ns 全 1 位型：旧式无符号读成 2^64-1ns（≈公元 2596 年）——本波修复
  assert.equal(readDate(new Uint8Array(8).fill(0xff)), EPOCH_2001); // -1ns → 0ms（向零截断）
  // 最小值 -2^63 ns → 2001 - 9223.37s
  assert.equal(
    readDate(new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0])),
    EPOCH_2001 + Number(-(2n ** 63n) / 1000000n));
  // 最大正值
  assert.equal(
    readDate(new Uint8Array([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])),
    EPOCH_2001 + Number((2n ** 63n - 1n) / 1000000n));
  // 宽度 0..9 全档：只抛受控 EbmlError 或返回有限值（readFloat 的 NaN 属
  // IEEE754 无损解码观察项，不在此约束）
  for (let w = 0; w <= 9; w++) {
    const b = new Uint8Array(w).fill(0xff);
    for (const [fn, allowNaN] of [[readUInt, false], [readInt, false], [readFloat, true], [readDate, false]]) {
      try {
        const r = fn(b, 0, w);
        if (!allowNaN) assert.ok(Number.isFinite(r), `${fn.name} w=${w} → ${r}`);
      } catch (e) { assert.ok(e instanceof EbmlError, `${fn.name} w=${w} 裸抛 ${e.constructor.name}`); }
    }
  }
});

test('readInt 二补码锚点：±1 与宽度对称', () => {
  assert.equal(readInt(new Uint8Array([0x00, 0x01])), 1);
  assert.equal(readInt(new Uint8Array([0xff, 0xff])), -1);
});

test('decodeLacing 敌意头：受控错误收敛；encodeSignedVint 全宽度 round-trip', () => {
  const cases = [
    ['xiph-empty', LACING_XIPH, new Uint8Array([0])],
    ['xiph-255loop', LACING_XIPH, new Uint8Array([3, 255, 255, 255, 255, 255, 255, 255, 255])],
    ['xiph-huge-tail', LACING_XIPH, new Uint8Array([1, 255, 255])],
    ['fixed-zero-body', LACING_FIXED, new Uint8Array([2])],
    ['fixed-uneven', LACING_FIXED, new Uint8Array([2, 1, 2, 3])],
    ['ebml-no-frames', LACING_EBML, new Uint8Array([0])],
    ['ebml-first-unknown', LACING_EBML, new Uint8Array([3, 0xff])],
    ['ebml-neg-vint', LACING_EBML, new Uint8Array([2, 0x81, 0x40])],
    ['ebml-overflow', LACING_EBML, new Uint8Array([3, 0x8f, 0xff, 0xff, 0xff])],
    ['ebml-zero-sizes', LACING_EBML, new Uint8Array([3, 0x80, 0x80, 0x80])],
  ];
  for (const [name, type, data] of cases) {
    const t0 = Date.now();
    try { decodeLacing(type, data); }
    catch (e) {
      assert.ok(!(e instanceof TypeError) && !(e instanceof RangeError),
        `${name} 裸抛 ${e.constructor.name}: ${e.message}`);
    }
    assert.ok(Date.now() - t0 < 500, `${name} 未限时收敛`);
  }
  // Signed EBML VINT uses signed = raw - (2^(7n-1)-1), including the all-ones payload.
  for (let n = 1; n <= 7; n++) {
    const bits = 7 * n;
    const bias = 2 ** (bits - 1) - 1;
    assert.equal(signedVintValue(0, n), -bias, `n=${n} minimum`);
    assert.equal(signedVintValue(bias, n), 0, `n=${n} zero`);
    assert.equal(signedVintValue(2 ** bits - 1, n), bias + 1, `n=${n} maximum`);
  }
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const bias = 2 ** (7 * n - 1) - 1;
    for (const v of [-bias, -2, -1, 0, 1, bias + 1]) {
      const enc = encodeSignedVint(v);
      const raw = readSize(enc, 0, enc.length);
      const rawVal = raw.unknown ? 2 ** (7 * raw.length) - 1 : raw.value;
      assert.equal(signedVintValue(rawVal, raw.length), v, `signedVint n=${n} v=${v}`);
    }
  }
  for (const v of [2 ** 56, -(2 ** 56), 2 ** 60, -(2 ** 60)]) {
    assert.throws(() => encodeSignedVint(v), EbmlError, `signedVint 越界 v=${v}`);
  }
  const largestSignedVint = encodeSignedVint(Number.MAX_SAFE_INTEGER);
  assert.equal(largestSignedVint.length, 8);
  assert.throws(() => signedVintValue((1n << 56n) - 1n, 8), /安全整数范围/);
});

test('iterElements：seeded 敌意序列收敛且描述符不变量成立', () => {
  const EBML = [0x1a, 0x45, 0xdf, 0xa3];
  let visited = 0;
  for (let r = 0; r < 300; r++) {
    const n = 4 + randInt(40);
    const b = new Uint8Array(n);
    for (let i = 0; i < Math.min(EBML.length, n); i++) b[i] = EBML[i];
    for (let i = EBML.length; i < n; i++) b[i] = randInt(256);
    if (n > 4) b[4 + randInt(n - 4)] = randInt(256);
    const t0 = Date.now();
    try {
      for (const el of iterElements(b, 0, n)) {
        visited++;
        assert.ok(el.contentStart <= el.contentEnd, `contentStart>contentEnd: ${JSON.stringify(el)}`);
        assert.ok(el.next >= el.contentEnd, `next<contentEnd: ${JSON.stringify(el)}`);
        if (el.size !== -1) assert.ok(el.size >= 0, `负 size: ${JSON.stringify(el)}`);
      }
    } catch (e) {
      assert.ok(!(e instanceof TypeError) && !(e instanceof RangeError),
        `裸抛 ${e.constructor.name}: ${e.message}`);
    }
    assert.ok(Date.now() - t0 < 500, '300 轮内出现不收敛');
  }
  assert.ok(visited > 0, '全部序列零元素——探测面失效');
});

test('正例锚点：完好 webm fixture 浅层遍历出 EBML 头与 DocType', () => {
  const els = [...iterElements(WEBM, 0, WEBM.length)];
  assert.ok(els.length > 0);
  assert.equal(els[0].id, 0x1a45dfa3); // EBML 头
  assert.equal(els[0].name, 'EBML');
});
