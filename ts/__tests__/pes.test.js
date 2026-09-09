/**
 * PES 头与时间戳单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPes } from './fixtures/build-ts.mjs';
import {
  parsePESHeader, decodeTimestamp5, encodeTimestamp5,
} from '../src/pes.js';
import { unwrapTimestamp } from '../src/bits.js';

test('时间戳 5 字节编解码往返', () => {
  for (const ts of [0, 1, 180000, 90000 * 3600, 2 ** 33 - 1]) {
    const enc = encodeTimestamp5(ts, 0b0010);
    const dec = decodeTimestamp5(enc[0], enc[1], enc[2], enc[3], enc[4]);
    assert.equal(dec, ts, `时间戳 ${ts} 往返应一致`);
  }
});

test('parsePESHeader：PTS+DTS 完整头', () => {
  const es = new Uint8Array(128).fill(0x42);
  const pes = buildPes(0xe0, es, { pts: 123456, dts: 120000 });
  const header = parsePESHeader(pes);
  assert.ok(header);
  assert.equal(header.streamId, 0xe0);
  assert.equal(header.pts, 123456);
  assert.equal(header.dts, 120000);
  assert.equal(header.declaredLength, 9 - 6 + 10 + es.length);
  // ES 负载完整
  assert.equal(pes.length - header.payloadOffset, es.length);
});

test('parsePESHeader：仅 PTS', () => {
  const pes = buildPes(0xc0, new Uint8Array(16), { pts: 777 });
  const header = parsePESHeader(pes);
  assert.equal(header.pts, 777);
  assert.equal(header.dts, null);
});

test('parsePESHeader：非法起始码返回 null', () => {
  assert.equal(parsePESHeader(new Uint8Array([0, 0, 2, 0xe0])), null);
  assert.equal(parsePESHeader(new Uint8Array([0, 0, 1])), null);   // 太短
});

test('unwrapTimestamp：33bit 回绕解卷积', () => {
  const WRAP = 2 ** 33;
  // 正常递增
  assert.equal(unwrapTimestamp(1000, 500), 1000);
  // 向前回绕：上次值接近满量程，当前值翻回小值 → 应解释为下一圈
  assert.equal(unwrapTimestamp(300, WRAP - 300), WRAP + 300);
  assert.equal(unwrapTimestamp(300, WRAP - 100), WRAP + 300);
  // 时间戳向后小幅跳变（乱序）保持原值
  assert.equal(unwrapTimestamp(500, 1000), 500);
});
