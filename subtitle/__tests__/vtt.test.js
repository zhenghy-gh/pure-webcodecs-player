/**
 * subtitle/__tests__/vtt.test.js — WebVTT 解析器
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt } from '../src/index.js';
import { SubtitleError } from '../src/index.js';
import { readFix } from './helpers.mjs';

test('VTT：基础样例格式与 codec 串', async () => {
  const r = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(r.format, 'vtt');
  assert.equal(r.codec, 'x-vtt');
});

test('VTT：头元数据 Key: Value 解析', async () => {
  const { header } = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(header.Kind, 'captions');
  assert.equal(header.Language, 'zh-CN');
});

test('VTT：NOTE 块跳过并计数', async () => {
  const { stats } = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(stats.noteBlocks, 1);
  assert.equal(stats.cueCount, 2);
});

test('VTT：cue identifier 行被容忍', async () => {
  const { cues, stats } = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(cues.length, 2);
  assert.equal(stats.skippedBlocks, 0);
});

test('VTT：cue settings 解析为键值表', async () => {
  const { cues } = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(cues[0].settings?.align, 'start');
  assert.equal(cues[0].settings?.position, '10%');
});

test('VTT：语音标签 <v> 原样保留', async () => {
  const { cues } = parseVtt(await readFix('sample-basic.vtt'));
  assert.ok(cues[1].text.includes('<v 张三>'));
});

test('VTT：durationUs 正确', async () => {
  const r = parseVtt(await readFix('sample-basic.vtt'));
  assert.equal(r.durationUs, 6_000_000);
});

test('VTT：STYLE/REGION 块跳过计数，后续 cue 不受影响', async () => {
  const r = parseVtt(await readFix('sample-blocks.vtt'));
  assert.equal(r.stats.styleBlocks, 1);
  assert.equal(r.stats.regionBlocks, 1);
  assert.equal(r.stats.cueCount, 2);
});

test('VTT：逗号毫秒容忍 + 缺小时位', async () => {
  const { cues } = parseVtt(await readFix('sample-blocks.vtt'));
  assert.equal(cues[0].startUs, 5_000_000);   // 00:05.000
  assert.equal(cues[0].endUs, 7_500_000);     // 00:07,500（逗号）
});

test('VTT：缺少 WEBVTT 签名抛 PARSE_ERROR', () => {
  assert.throws(
    () => parseVtt('00:01.000 --> 00:02.000\n台词'),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('VTT：strict 模式下畸形块抛 PARSE_ERROR', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 不是时间\n坏块\n';
  assert.throws(
    () => parseVtt(src, { strict: true }),
    (e) => e.code === 'PARSE_ERROR',
  );
});

test('VTT：lenient 模式下畸形块跳过并计数', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 不是时间\n坏块\n\n00:02.000 --> 00:03.000\n好块\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('VTT：空输入抛 PARSE_ERROR', () => {
  assert.throws(() => parseVtt(''), (e) => e.code === 'PARSE_ERROR');
});

test('VTT：仅头与 STYLE 的文件合法且零 cue', () => {
  const r = parseVtt('WEBVTT\n\nSTYLE\n::cue{color:red}\n');
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.styleBlocks, 1);
  assert.equal(r.durationUs, 0);
});
