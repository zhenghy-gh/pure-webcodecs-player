/**
 * subtitle/__tests__/subtitle-srt-edge.test.js — SRT 解析深水区
 *
 * 扩展 srt.test.js 未深入的分支：
 *   - 块间缺少空行 → 多 cue 被合并为单块（第二条丢失，已知限制）
 *   - 负时间 / 零时长（end==start）→ 跳过
 *   - 空文本 cue 仍计入
 *   - 时间行尾坐标段进入 settings.extra
 *   - 点毫秒（SRT 时间用 . 而非逗号）容忍
 *   - 缺序号行（时间行打头）仍解析
 *   - 4 位毫秒截断处理
 *   - 多余空行 / end<start
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt } from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('SRT：块间无空行 → 后续 cue 被合并进首块（已知限制，第二条丢失）', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n第一条\n2\n00:00:03,000 --> 00:00:04,000\n第二条\n';
  const r = parseSrt(src);
  // 整段被切成单块（无空行分隔），第二个时间行沦为首块文本的一部分，不另起 cue
  assert.equal(r.cues.length, 1);
  assert.ok(r.cues[0].text.includes('00:00:03,000'), '第二条时间行应作为首块文本被吞入');
  assert.equal(r.stats.skippedBlocks, 0);
});

test('SRT：负时间（秒为负）非法 → 跳过', () => {
  const src = '1\n00:00:-1,000 --> 00:00:02,000\n负时间\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('SRT：零时长（end==start）视为非法区间 → 跳过', () => {
  const src = '1\n00:00:00,000 --> 00:00:00,000\n零时长\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('SRT：空文本 cue 仍计入（时间行后无内容）', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '');
});

test('SRT：时间行尾坐标段进入 settings.extra', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000 X1:40 Y1:20 X2:600 Y2:50\nx\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.match(/** @type {any} */ (r.cues[0].settings)?.extra ?? '', /X1:40/);
});

test('SRT：点毫秒（.）容忍', () => {
  const src = '1\n00:00:01.000 --> 00:00:02.000\n点分隔\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].startUs, 1_000_000);
  assert.equal(r.cues[0].endUs, 2_000_000);
});

test('SRT：缺序号行（首行即时间行）仍可解析', () => {
  const src = '00:00:01,000 --> 00:00:02,000\n无序号\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.stats.skippedBlocks, 0);
});

test('SRT：4 位毫秒截断为毫秒域（0001 → 000ms）', () => {
  const src = '1\n00:00:06,0001 --> 00:00:07,000\n四位毫秒\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].startUs, 6_000_000); // 截断后 = 6s000ms
});

test('SRT：块间多余空行（双空行）不影响解析', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n台词\n\n\n2\n00:00:03,000 --> 00:00:04,000\n第二条\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, '台词');
  assert.equal(r.cues[1].text, '第二条');
});

test('SRT：end<start 跳过', () => {
  const src = '1\n00:00:05,000 --> 00:00:03,000\n倒序\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('SRT：缺序号但时间行带小时位', () => {
  const src = '01:00:01,000 --> 01:00:02,000\n带小时\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].startUs, 3_601_000_000);
});

test('SRT：strict 模式下缺时间行抛 PARSE_ERROR', () => {
  const src = '1\n只有序号没有时间\n';
  assert.throws(() => parseSrt(src, { strict: true }), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('SRT：混合 BOM + CRLF + 缺小时位（收敛性）', () => {
  const src = '\uFEFF10\r\n00:00.500 --> 00:02.000 X1:40 X2:600\r\n缺小时位\r\n';
  const r = parseSrt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].startUs, 500_000);
});
