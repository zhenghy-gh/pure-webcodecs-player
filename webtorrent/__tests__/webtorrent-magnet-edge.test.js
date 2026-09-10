/**
 * webtorrent-magnet-edge.test.js —— magnet URI 解析/构造 与 base32 畸形分支补测
 *
 * 既有 magnet.test.js 覆盖正向解析与往返；本文件专攻：
 *   - base32Decode 空输入；非 5 字节对齐长度的编解码往返
 *   - parseMagnet 的 dn/xl/tr 缺省与非规范化值；多 xt 中坏 btih 跳过；xt 空白容差
 *   - buildMagnet 的 xl 非法值 / 空 tr / 空 dn 过滤；大写 hex 输入归一化
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  parseMagnet, buildMagnet, base32Decode, base32Encode, hexToBase32, base32ToHex,
} from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';

const HEX = 'a'.repeat(40);

// ── base32 ───────────────────────────────────────────────

test('base32Decode：空串与非字符串输入拒绝', () => {
  assert.throws(() => base32Decode(''), PlayerError);
  assert.throws(() => base32Decode(undefined), PlayerError);
  assert.throws(() => base32Decode(null), PlayerError);
});

test('base32Decode：小写自动转大写后可解码', () => {
  const bytes = new Uint8Array([0x30, 0x61]);
  const upper = base32Encode(bytes);
  assert.deepEqual([...base32Decode(upper.toLowerCase())], [...bytes]);
});

test('base32 编解码：1/2/3/4/5 字节（非 5 位对齐）往返', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 10]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 5) & 0xff);
    const b32 = base32Encode(bytes);
    assert.match(b32, /^[A-Z2-7]+$/);
    assert.deepEqual([...base32Decode(b32)], [...bytes], `${n} 字节往返`);
  }
});

test('base32Encode：空字节数组返回空串', () => {
  assert.equal(base32Encode(new Uint8Array(0)), '');
});

test('hexToBase32：大写 hex 输入接受并归一化', () => {
  const hex = createHash('sha1').update('case-upper').digest('hex');
  assert.equal(hexToBase32(hex.toUpperCase()), hexToBase32(hex));
});

test('base32ToHex：39/33 位长度拒绝（长度守卫）', () => {
  assert.throws(() => base32ToHex('A'.repeat(31)), PlayerError);
  assert.throws(() => base32ToHex('A'.repeat(33)), PlayerError);
  assert.throws(() => base32ToHex('A'.repeat(32) + '!'), PlayerError);
});

// ── parseMagnet 缺省与畸形分支 ────────────────────────────

test('parseMagnet：dn 缺省为 null；空 dn 也归一为 null', () => {
  const m = parseMagnet(`magnet:?xt=urn:btih:${HEX}`);
  assert.equal(m.dn, null);
  assert.equal(m.xl, null);
  assert.deepEqual(m.tr, []);
  const m2 = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=`);
  assert.equal(m2.dn, null);
});

test('parseMagnet：xl 非数字 / 负数 / 空值归一为 null', () => {
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xl=abc`).xl, null);
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xl=-5`).xl, null);
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xl=1.5`).xl, null);
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xl=`).xl, null);
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xl=0`).xl, 0);
});

test('parseMagnet：tr 去重保序并过滤空串', () => {
  const m = parseMagnet(
    `magnet:?xt=urn:btih:${HEX}&tr=wss%3A%2F%2Fa&tr=&tr=wss%3A%2F%2Fb&tr=wss%3A%2F%2Fa`,
  );
  assert.deepEqual(m.tr, ['wss://a', 'wss://b']);
});

test('parseMagnet：多 xt 中首个 btih 格式坏时跳过取后续合法项', () => {
  const good = 'c'.repeat(40);
  const m = parseMagnet(`magnet:?xt=urn:btih:zzzz&xt=urn:btih:${good}`);
  assert.equal(m.infoHash, good);
  // 全部 xt 都坏 → 报缺可识别 btih
  assert.throws(
    () => parseMagnet(`magnet:?xt=urn:btih:zzzz&xt=urn:btih:${'z'.repeat(40)}`),
    PlayerError,
  );
});

test('parseMagnet：xt 首尾空白被 trim 后可识别', () => {
  const m = parseMagnet(`magnet:?xt=${encodeURIComponent(` urn:btih:${HEX} `)}`);
  assert.equal(m.infoHash, HEX);
});

test('parseMagnet：btih 39/41 位 hex 拒绝（边界长度）', () => {
  assert.throws(() => parseMagnet(`magnet:?xt=urn:btih:${'a'.repeat(39)}`), PlayerError);
  assert.throws(() => parseMagnet(`magnet:?xt=urn:btih:${'a'.repeat(41)}`), PlayerError);
});

test('parseMagnet：raw 字段保留原始 URI', () => {
  const uri = `magnet:?xt=urn:btih:${HEX}&dn=x`;
  assert.equal(parseMagnet(uri).raw, uri);
});

// ── buildMagnet 过滤分支 ─────────────────────────────────

test('buildMagnet：xl 非法（负数/小数/NaN）不写入；0 合法', () => {
  for (const xl of [-1, 1.5, NaN]) {
    assert.ok(!buildMagnet({ infoHash: HEX, xl }).includes('xl='), `xl=${xl} 不应写入`);
  }
  assert.ok(buildMagnet({ infoHash: HEX, xl: 0 }).includes('xl=0'));
});

test('buildMagnet：空 tr 项与空 dn 被过滤', () => {
  const uri = buildMagnet({ infoHash: HEX, dn: '', tr: ['wss://a', ''] });
  assert.ok(uri.includes('tr=wss%3A%2F%2Fa'));
  assert.equal(uri.match(/tr=/g).length, 1);
  assert.ok(!uri.includes('dn='));
});

test('buildMagnet：大写 hex 输出归一化为小写', () => {
  const uri = buildMagnet({ infoHash: HEX.toUpperCase() });
  assert.ok(uri.includes(HEX));
  assert.ok(!uri.includes(HEX.toUpperCase()));
});

test('buildMagnet：null/undefined infoHash 拒绝', () => {
  assert.throws(() => buildMagnet({}), PlayerError);
  assert.throws(() => buildMagnet({ infoHash: null }), PlayerError);
});
