import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAvcCodecString,
  buildHevcCodecString,
  aacCodecString,
  parseCodecString,
  buildMseMimeType,
  h264CodecStringFromSps,
  hevcCodecStringFromHvcC,
  aacCodecStringFromAsc,
  fallbackCodecString,
} from '../src/codec-string.js';
import { makeSpsNalu, makeAscFixture } from '../../mp4/__tests__/fixtures.js';

test('avcC → avc1 codec string', () => {
  // 经典 baseline L30：42 E0 1E
  const avcC = new Uint8Array([0x01, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0x00, 0x1e]);
  assert.equal(buildAvcCodecString(avcC), 'avc1.42E01E');
  assert.equal(buildAvcCodecString(new Uint8Array([1, 0x64, 0x00, 0x28])), 'avc1.640028'); // High L4.0
  assert.equal(buildAvcCodecString(new Uint8Array([1, 2, 3])), '');
});

test('hvcC → hvc1 codec string（Annex E 规则）', () => {
  // Main@L3.1：profile_idc=1、compat=0x60000000→'6'、level=93、约束 B0 00..→'B0'
  const hvcC = new Uint8Array(23);
  hvcC[0] = 1;          // configurationVersion
  hvcC[1] = 0x01;       // space=0 tier=0 idc=1
  hvcC.set([0x60, 0x00, 0x00, 0x00], 2);
  hvcC.set([0xb0, 0x00, 0x00, 0x00, 0x00, 0x00], 6);
  hvcC[12] = 93;
  assert.equal(buildHevcCodecString(hvcC), 'hvc1.1.6.L93.B0');

  // 全零约束 → 元素省略；Main10(idc=2, compat bit2)
  const hvcC2 = new Uint8Array(23);
  hvcC2[0] = 1;
  hvcC2[1] = 0x02;
  hvcC2.set([0x20, 0x00, 0x00, 0x00], 2);
  hvcC2[12] = 120;
  assert.equal(buildHevcCodecString(hvcC2), 'hvc1.2.2.L120');

  // profile_space=1 → 'A' 前缀；高层 'H'
  const hvcC3 = new Uint8Array(23);
  hvcC3[0] = 1;
  hvcC3[1] = (1 << 6) | (1 << 5) | 4; // space=1 tier=1 idc=4
  hvcC3.set([0x08, 0x00, 0x00, 0x00], 2);
  hvcC3[12] = 153;
  assert.equal(buildHevcCodecString(hvcC3, 'hev1'), 'hev1.A4.8.H153');
});

test('aac codec string 与解析', () => {
  assert.equal(aacCodecString(), 'mp4a.40.2');
  const parsed = parseCodecString('mp4a.40.2');
  assert.equal(parsed.family, 'aac');
  assert.equal(parsed.objectType, 2);
  const avc = parseCodecString('avc1.42E01E');
  assert.equal(avc.family, 'avc');
  assert.equal(avc.profile, 0x42);
  assert.equal(avc.level, 0x1e);
  assert.equal(parseCodecString('').family, '');
});

test('MSE mimeType 组装', () => {
  assert.equal(
    buildMseMimeType('video/mp4', ['mp4a.40.2', 'avc1.42E01E', 'mp4a.40.2']),
    'video/mp4; codecs="mp4a.40.2, avc1.42E01E"',
  );
  assert.equal(buildMseMimeType('mp4', []), 'video/mp4');
});

/* ---------------- CONTRACTS §3 定稿助手（生成逻辑收敛点） ---------------- */

test('h264CodecStringFromSps：SPS NAL → avc1.PPCCLL', () => {
  // mp4 fixture 的手工 SPS：profile 66 / constraint 0 / level 30
  assert.equal(h264CodecStringFromSps(makeSpsNalu()), 'avc1.42001E');
  // 非 SPS 输入返回空串，不编造
  assert.equal(h264CodecStringFromSps(new Uint8Array([0x68, 0xce, 0x38, 0x80])), '');
  assert.equal(h264CodecStringFromSps(new Uint8Array(0)), '');
});

test('hevcCodecStringFromHvcC 与 buildHevcCodecString 等价', () => {
  const hvcC = new Uint8Array(23);
  hvcC[0] = 1;
  hvcC[1] = 0x01;
  hvcC.set([0x60, 0x00, 0x00, 0x00], 2);
  hvcC.set([0xb0, 0x00, 0x00, 0x00, 0x00, 0x00], 6);
  hvcC[12] = 93;
  assert.equal(hevcCodecStringFromHvcC(hvcC), buildHevcCodecString(hvcC));
  assert.equal(hevcCodecStringFromHvcC(hvcC), 'hvc1.1.6.L93.B0');
});

test('aacCodecStringFromAsc：ASC 高 5 位 AOT', () => {
  assert.equal(aacCodecStringFromAsc(makeAscFixture()), 'mp4a.40.2'); // 0x12>>3 = 2 (LC)
  assert.equal(aacCodecStringFromAsc(new Uint8Array([0x2b, 0x92])), 'mp4a.40.5'); // 0x2b>>3=5 (HE-AAC SBR)
  // 缺参走降级基础串（契约：不编造 AOT，必须打 warn）
  const warn = console.warn;
  let warned = false;
  console.warn = () => (warned = true);
  try {
    assert.equal(aacCodecStringFromAsc(null), 'mp4a.40');
    assert.equal(warned, true, 'fallback 必须打 warn');
  } finally {
    console.warn = warn;
  }
});
