/**
 * magnet.test.js —— magnet URI 解析 / btih 提取 / base32↔hex 单测
 *
 * 派发点名：magnet URI 解析（btih 提取 / base32↔hex）。
 * 校验策略：手算小向量 + Node crypto 构造真实 sha1 做 roundtrip 性质验证，
 * 不依赖外部网络与第三方库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  parseMagnet, buildMagnet, base32Decode, base32Encode,
  hexToBase32, base32ToHex,
} from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';

// ── base32 ↔ hex ─────────────────────────────────────────

test('base32↔hex：全零 20B 手算向量', () => {
  const zeroHex = '0'.repeat(40);
  assert.equal(hexToBase32(zeroHex), 'A'.repeat(32));
  assert.equal(base32ToHex('A'.repeat(32)), zeroHex);
});

test('base32↔hex：crypto 真实 sha1 往返性质验证', () => {
  for (const seed of ['pureplay', 'webtorrent', 'mkv+wt']) {
    const hex = createHash('sha1').update(seed).digest('hex');
    const b32 = hexToBase32(hex);
    assert.match(b32, /^[A-Z2-7]{32}$/);
    assert.equal(base32ToHex(b32), hex);
    // 编码器互逆
    assert.deepEqual([...base32Decode(b32)], [...Buffer.from(hex, 'hex')]);
  }
});

test('base32：RFC4648 字母表不含 0/1/8/9；非法字符报 PARSE_ERROR', () => {
  assert.throws(() => base32ToHex('0OIL1234'.padEnd(32, 'A')), PlayerError);
  assert.throws(() => base32Decode('@@@'), PlayerError);
  assert.throws(() => base32Encode('not-bytes'), PlayerError);
});

test('hexToBase32：非 40 位十六进制拒绝', () => {
  assert.throws(() => hexToBase32('abc'), PlayerError);
  assert.throws(() => hexToBase32('z'.repeat(40)), PlayerError);
});

// ── parseMagnet ──────────────────────────────────────────

test('parseMagnet：hex btih 提取 + dn/tr/xl 收集', () => {
  const hex = 'a'.repeat(40);
  const m = parseMagnet(
    `magnet:?xt=urn:btih:${hex}&dn=Sample+Movie&tr=https%3A%2F%2Ft1.example%2Fa` +
    '&tr=wss://t2/b&xl=12345',
  );
  assert.equal(m.infoHash, hex);
  assert.equal(m.wasBase32, false);
  assert.equal(m.dn, 'Sample Movie'); // URLSearchParams 把 + 解为空格
  assert.equal(m.xl, 12345);
  assert.deepEqual(m.tr, ['https://t1.example/a', 'wss://t2/b']);
});

test('parseMagnet：base32 btih 自动转规范 hex', () => {
  const hex = createHash('sha1').update('b32-case').digest('hex');
  const b32 = hexToBase32(hex);
  const m = parseMagnet(`magnet:?xt=urn:btih:${b32.toLowerCase()}`);
  assert.equal(m.wasBase32, true);
  assert.equal(m.infoHash, hex); // 输出统一规范化为小写 hex
});

test('parseMagnet：多 xt 时取首个可识别 btih', () => {
  const hex = 'b'.repeat(40);
  const m = parseMagnet(`magnet:?xt=urn:ed2k:deadbeef&xt=urn:btih:${hex}`);
  assert.equal(m.infoHash, hex);
});

test('parseMagnet：非法输入给出 PARSE_ERROR（scheme 缺失/无 btih/坏哈希）', () => {
  assert.throws(() => parseMagnet('http://example.com/a'), PlayerError);
  assert.throws(() => parseMagnet('magnet:?dn=only-name'), PlayerError);
  assert.throws(() => parseMagnet('magnet:?xt=urn:btih:zzzz'), PlayerError); // 长度/字符均不合法
  assert.throws(() => parseMagnet(42), PlayerError);
});

test('buildMagnet→parseMagnet：往返一致（含 tr 多值与 xl）', () => {
  const hex = createHash('sha1').update('roundtrip').digest('hex');
  const uri = buildMagnet({
    infoHash: hex,
    dn: '纯前端播放器',
    tr: ['wss://tracker.openwebtorrent.com', 'https://t.example/x'],
    xl: 4096,
  });
  const back = parseMagnet(uri);
  assert.equal(back.infoHash, hex);
  assert.equal(back.dn, '纯前端播放器'); // encodeURIComponent 后解码还原中文
  assert.deepEqual(back.tr, ['wss://tracker.openwebtorrent.com', 'https://t.example/x']);
  assert.equal(back.xl, 4096);
});

test('buildMagnet：接受 base32 输入并规范化为 hex；坏哈希拒绝', () => {
  const hex = createHash('sha1').update('accept-b32').digest('hex');
  // URLSearchParams 会把冒号编码为 %3A（语义等价），用 parseMagnet 往返断言
  const viaB32 = buildMagnet({ infoHash: hexToBase32(hex) });
  assert.equal(parseMagnet(viaB32).infoHash, hex);
  assert.ok(viaB32.includes(hex));
  assert.throws(() => buildMagnet({ infoHash: 'short' }), PlayerError);
});
