/**
 * codec-string-gaps.test.js —— RFC-6381 codec 串工具残余分支补测（wave 153）
 *
 * 覆盖：
 *   - h264CodecStringFromSps：null 输入 catch → ''；含 emulation prevention（00 00 03）SPS；
 *   - parseCodecString：hvc1/hev1 → family hevc；
 *   - mseIsTypeSupported：isTypeSupported 抛错 → catch false（不冒泡）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  h264CodecStringFromSps,
  parseCodecString,
  mseIsTypeSupported,
} from '../src/codec-string.js';

test('h264CodecStringFromSps：null/缺字节 → 空串（catch 与长度守卫）', () => {
  assert.equal(h264CodecStringFromSps(null), '');
  assert.equal(h264CodecStringFromSps(new Uint8Array([0x67, 0x42])), '');
});

test('h264CodecStringFromSps：去除 emulation prevention 后取 profile/compat/level', () => {
  // NAL 头 0x67（SPS）+ profile=0x42/compat=0x00/level=0x1e +
  // 载荷中放 00 00 03 xx 转义序列（120-122 分支）；0x03 须被剥除
  const sps = Uint8Array.from([
    0x67, 0x42, 0x00, 0x1e,
    0xaa, 0x00, 0x00, 0x03, 0x01, 0xbb,
  ]);
  assert.equal(h264CodecStringFromSps(sps), 'avc1.42001E');
});

test('parseCodecString：hvc1/hev1 归入 hevc 家族', () => {
  assert.equal(parseCodecString('hvc1.1.6.L93.B0').family, 'hevc');
  assert.equal(parseCodecString('hev1.2.4.L120.90').family, 'hevc');
});

test('mseIsTypeSupported：isTypeSupported 抛错 → false', () => {
  const prev = globalThis.MediaSource;
  globalThis.MediaSource = class {
    static isTypeSupported() { throw new Error('MSE 爆炸'); }
  };
  try {
    assert.equal(mseIsTypeSupported('video/mp4; codecs="avc1.42E01E"'), false);
  } finally {
    if (prev === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = prev;
  }
});
