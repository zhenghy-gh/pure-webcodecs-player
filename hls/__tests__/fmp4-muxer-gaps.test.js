/**
 * fmp4-muxer-gaps.test.js —— TS→fMP4 转封装器残余分支补测（wave 149）
 *
 * 覆盖：
 *   - remux 无轨无样本分片（仅 PAT/PMT 或空字节）→ video/audio 均 null；
 *   - safeCodec 正常返回与推导抛错 → ''（不编造 profile，走告警）；
 *   - parseAot 空 ASC 默认 AOT=2 与正常移位解析；
 *   - toAvcc 合法 AnnexB → AVCC 长度前缀；非法输入 → PARSE_ERROR。
 *
 * 登记（不硬造）：remux 入口 381-385 动态 import 失败 → NOT_SUPPORTED 分支——
 * '../../ts/src/index.js' 与 '../../ts/src/nalu.js' 为仓库内真实模块，静态可解析，
 * Node 测试环境下动态 import 不会 reject（同 core/pipeline-mse 31-32 先例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TsToFmp4Transmuxer, loadNalu, _internalForTest } from '../src/fmp4-muxer.js';

const { safeCodec, parseAot, toAvcc } = _internalForTest;

test('remux：空 TS 分片（无轨无样本）→ video/audio 均为 null', async () => {
  const muxer = new TsToFmp4Transmuxer();
  const out = await muxer.remux(new Uint8Array(0));
  assert.equal(out.video, null);
  assert.equal(out.audio, null);
  assert.ok(out.codecs, 'codecs 汇总对象应始终返回');
});

test('safeCodec：正常返回推导值；fn 抛错时降级空串并告警', () => {
  assert.equal(safeCodec(() => 'avc1.42001E'), 'avc1.42001E');

  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    assert.equal(safeCodec(() => { throw new Error('坏 SPS'); }), '');
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /坏 SPS/);
});

test('parseAot：空 ASC 默认 2（AAC-LC）；正常 ASC 取首字节高 5 位', () => {
  assert.equal(parseAot(null), 2);
  assert.equal(parseAot(new Uint8Array(0)), 2);
  assert.equal(parseAot(Uint8Array.from([0x11, 0x90])), 2); // 0x11>>3 = 2（LC）
  assert.equal(parseAot(Uint8Array.from([0x58, 0x80])), 11); // 0x58>>3 = 11
});

test('toAvcc：AnnexB 起始码帧 → 4 字节长度前缀；非法输入 → PARSE_ERROR', async () => {
  await loadNalu();
  // 00 00 00 01 + 5 字节 NAL 数据
  const frame = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0xaa]);
  const avcc = toAvcc(frame, 'h264');
  assert.equal(avcc.byteLength, 4 + 5);
  assert.equal(new DataView(avcc.buffer).getUint32(0), 5, '首 NALU 长度前缀');
  assert.deepEqual([...avcc.subarray(4)], [0x67, 0x42, 0x00, 0x1e, 0xaa]);

  assert.throws(
    () => toAvcc(undefined, 'h264'),
    (e) => e.name === 'PlayerError' && e.code === 'PARSE_ERROR',
  );
});
