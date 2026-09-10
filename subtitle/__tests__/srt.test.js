/**
 * subtitle/__tests__/srt.test.js — SRT 解析器
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, stripCueTags, findActiveCues } from '../src/index.js';
import { SubtitleError } from '../src/index.js';
import { readFix } from './helpers.mjs';

test('SRT：基础样例解析出 3 条 cue', async () => {
  const r = parseSrt(await readFix('sample-basic.srt'));
  assert.equal(r.format, 'srt');
  assert.equal(r.codec, 'x-srt');
  assert.equal(r.cues.length, 3);
});

test('SRT：首条时间戳精确到微秒', async () => {
  const { cues } = parseSrt(await readFix('sample-basic.srt'));
  assert.equal(cues[0].startUs, 1_000_000);
  assert.equal(cues[0].endUs, 3_000_000);
});

test('SRT：多行文本保留换行', async () => {
  const { cues } = parseSrt(await readFix('sample-basic.srt'));
  assert.ok(cues[1].text.includes('\n'));
});

test('SRT：durationUs 取最后一条的结束时间', async () => {
  const r = parseSrt(await readFix('sample-basic.srt'));
  assert.equal(r.durationUs, 9_000_000);
});

test('SRT：干净样例零跳过零警告', async () => {
  const { stats } = parseSrt(await readFix('sample-basic.srt'));
  assert.equal(stats.cueCount, 3);
  assert.equal(stats.skippedBlocks, 0);
  assert.deepEqual(stats.warnings, []);
});

test('SRT：BOM/CRLF/点分隔/缺小时位全部容忍', async () => {
  const { cues, stats } = parseSrt(await readFix('sample-messy.srt'));
  assert.equal(stats.cueCount, 2);
  assert.equal(cues[0].startUs, 500_000); // 00:00.500
  assert.equal(cues[1].startUs, 2_500_000);
});

test('SRT：时间行尾坐标段进入 settings.extra', async () => {
  const { cues } = parseSrt(await readFix('sample-messy.srt'));
  assert.match(/** @type {any} */ (cues[0].settings)?.extra ?? '', /X1:40/);
});

test('SRT：畸形样例 lenient 跳过并计数', async () => {
  const r = parseSrt(await readFix('sample-broken.srt'));
  // 修复前：4 位毫秒（00:00:06,0001）被视作非法整块跳过；
  // 修复后：毫秒域超 3 位按截断处理（→ 6s000ms），该块成为有效 cue。
  // 仍真正畸形的是：时间行含非数字字符（XX:YY:ZZ）与结束时间缺失。
  assert.equal(r.cues.length, 2);
  assert.equal(r.stats.skippedBlocks, 2);
  assert.ok(r.stats.warnings.length >= 2);
  assert.equal(r.stats.warnings[0].endsWith('已跳过'), true);
});

test('SRT：畸形样例 strict 抛 PARSE_ERROR', async () => {
  await assert.rejects(
    async () => parseSrt(await readFix('sample-broken.srt'), { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('SRT：空输入抛 PARSE_ERROR', () => {
  assert.throws(() => parseSrt(''), (e) => e.code === 'PARSE_ERROR');
  assert.throws(() => parseSrt('   \n\n '), (e) => e.code === 'PARSE_ERROR');
});

test('SRT：非字符串输入抛 PARSE_ERROR', () => {
  assert.throws(() => /** @type {any} */ (parseSrt)(null), (e) => e.code === 'PARSE_ERROR');
});

test('SRT：序号不连续/缺失不影响解析', () => {
  const r = parseSrt('5\n00:00:00,000 --> 00:00:01,000\n甲\n\n99\n00:00:02,000 --> 00:00:03,000\n乙\n');
  assert.equal(r.cues.length, 2);
  assert.equal(r.stats.skippedBlocks, 0);
});

test('SRT：stripCueTags 去标签保内容', async () => {
  const { cues } = parseSrt(await readFix('sample-basic.srt'));
  assert.equal(stripCueTags(cues[2].text), '带斜体标签');
});

test('SRT：区间命中语义 start<=t<end', () => {
  const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n台词\n');
  const [c] = r.cues;
  assert.equal(findActiveCues(r.cues, 1_000_000).length, 1); // 起点 inclusive
  assert.equal(findActiveCues(r.cues, 2_000_000).length, 0); // 终点 exclusive
  assert.equal(findActiveCues(r.cues, 1_500_000)[0], c);
});
