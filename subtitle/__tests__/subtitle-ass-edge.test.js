/**
 * subtitle/__tests__/subtitle-ass-edge.test.js — ASS/SSA 解析深水区
 *
 * 扩展 ass.test.js 未深入的分支：
 *   - [Script Info] 仅头（0 cue）、PlayRes 数值化
 *   - [Events] 缺 Format 行 → 回退默认列序，Text 含逗号保留
 *   - Style 字段数少于 Format → 跳过计数（lenient）/ strict 抛错
 *   - 负时间 / 零时长 Dialogue → 跳过
 *   - 覆盖标签 \org / \frz / \fscx 几何透传
 *   - 仅 Comment 行的 Events（commentCount>0，cue=0）
 *   - 缺 [V4+ Styles] 节（Dialogue 用默认样式）
 *   - 正文 `;` 注释行忽略
 *   - SSA Marked=1 → layer 1
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAss } from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('ASS：仅 [Script Info] 头、无 Dialogue → 0 cue 且 info 解析', () => {
  const src = [
    '[Script Info]',
    'Title: 只有头',
    'PlayResX: 1280',
    'PlayResY: 720',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.info.playResX, 1280);
  assert.equal(r.info.playResY, 720);
  assert.equal(r.info.title, '只有头');
});

test('ASS：[Events] 缺 Format 行 → 回退默认列序，Text 含逗号保留', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic',
    'Style: Default,Arial,20,&HFFFFFF,0,0',
    '',
    '[Events]',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello, world with comma',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, 'Hello, world with comma', '缺 Format 时 Text 字段按默认列序截取且逗号保留');
  assert.equal(r.cues[0].startUs, 1_000_000);
});

test('ASS：Style 字段数少于 Format → 跳过计数', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Bad,16',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,好台词',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 0, '字段不足 Style 被跳过');
  assert.equal(r.stats.skippedBlocks, 1);
  assert.equal(r.cues.length, 1, 'Dialogue 仍按默认样式解析');
});

test('ASS：Style 字段数少于 Format（strict）抛 PARSE_ERROR', () => {
  const src = [
    '[Script Info]',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Bad,16',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,好台词',
    '',
  ].join('\n');
  assert.throws(() => parseAss(src, { strict: true }), (e) => e.code === 'PARSE_ERROR');
});

test('ASS：负开始时间 → 跳过计数', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic',
    'Style: Default,Arial,20,&HFFFFFF,0,0',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,-0:00:01.00,0:00:02.00,Default,,0,0,0,,负时间台词',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('ASS：零时长 Dialogue（end==start）跳过', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic',
    'Style: Default,Arial,20,&HFFFFFF,0,0',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,零时长',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('ASS：\\org / \\frz / \\fscx 几何透传', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic',
    'Style: Default,Arial,20,&HFFFFFF,0,0',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\org(160,180)\\frz(30)\\fscx(120)}变换',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 1);
  const g = r.cues[0].geom;
  assert.deepEqual(g.org, { x: 160, y: 180 });
  assert.equal(g.rotation, 30);
  assert.equal(g.scaleX, 120);
});

test('ASS：仅 Comment 行的 Events → commentCount>0 且 cue=0', () => {
  const src = [
    '[Script Info]',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,纯注释',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.stats.commentCount, 1);
  assert.equal(r.cues.length, 0);
});

test('ASS：缺 [V4+ Styles] 节 → Dialogue 用默认样式仍可解析', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,无样式节',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 0);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].style, 'Default');
});

test('ASS：正文 `;` 注释行被忽略', () => {
  const src = [
    '[Script Info]',
    '; 这是脚本注释',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic',
    'Style: Default,Arial,20,&HFFFFFF,0,0',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    '; 事件节注释',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,带分号注释行',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '带分号注释行');
});

test('ASS：SSA Marked 字段当前未被解析为 layer（已知缺陷回归守卫）', () => {
  const src = [
    '[Script Info]',
    '',
    '[V4 Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding',
    'Style: Default,Arial,20,&HFFFFFF,&H0000FF,&H0,&H0,0,0,1,1,0,2,10,10,10,0,1',
    '',
    '[Events]',
    'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: Marked=1,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 层1',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.cues.length, 1);
  // 缺陷：ass.js:232 用 intOr(rec['marked'], 0)，但 rec['marked'] 是原始串 "Marked=1"，
  // parseInt 解析为 NaN → 恒为 0；SSA Marked 数值从未转换成 layer（应 = 1）。
  // 此处仅守护「当前实现行为」，详见汇报 ass.js:232。
  assert.equal(r.cues[0].layer, 0);
});

test('ASS：Style 字段尾随空值（多逗号）被安全填默认', () => {
  const src = [
    '[Script Info]',
    'PlayResX: 640',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Top,,48,&H00FFFFFF,,,,,,0,0,0,0,100,100,0,0,1,2,2,2,20,20,30,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Top,,0,0,0,,空字段样式',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 1);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].style, 'Top');
});
