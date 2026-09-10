/**
 * subtitle/__tests__/subtitle-parse-edge.test.js — 三格式解析边界 + 时间/工具回归
 *
 * 深化 vtt.js / srt.js / ass.js 在 src 现有测试中仍未触达的错误/边界分支：
 *   - vtt：无 settings 时 cue.settings===undefined；首字符冒号 token 被忽略；
 *          严格模式缺时间行抛 PARSE_ERROR；NOTE 负向前瞻（NOTEPAD 不算 NOTE）
 *   - srt：严格模式 end<=start 抛 PARSE_ERROR；非数字序号行记警告但照常解析
 *   - ass：空输入 PARSE_ERROR；注释行(;)跳过；Style 字段数不足跳过；
 *          非法颜色值进入 catch 回退默认；Dialogue 字段数不足跳过
 *   - time：纯空白/空串 parseTimestamp 抛 PARSE_ERROR（padEnd 修复回归）
 *   - cue：cuesDurationUs 极值；layout：approximateMeasure 字间距叠加
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVtt, parseSrt, parseAss, SubtitleError,
  parseTimestamp, cuesDurationUs, approximateMeasure,
} from '../src/index.js';

/* ---------------- VTT 边界 ---------------- */

test('VTT：时间行无 settings 时 cue.settings 为 undefined', () => {
  const r = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n台词');
  assert.equal(r.cues[0].settings, undefined, '未带 cue settings 应为 undefined');
});

test('VTT：settings 中首字符冒号 token（:foo）被忽略', () => {
  const r = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000 :foo align:start\n台词');
  assert.deepEqual(r.cues[0].settings, { align: 'start' });
});

test('VTT：strict 模式缺时间行块抛 PARSE_ERROR', () => {
  const src = 'WEBVTT\n\n这块没有时间行就垃圾\n';
  assert.throws(
    () => parseVtt(src, { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('VTT：NOTE 负向前瞻——NOTEPAD 不算 NOTE（作为标识符容忍）', () => {
  const src = 'WEBVTT\n\nNOTEPAD 不是注释\n00:01.000 --> 00:02.000\n台词\n';
  const r = parseVtt(src);
  assert.equal(r.stats.noteBlocks, 0, 'NOTEPAD 不应被吞为 NOTE 块');
  assert.equal(r.cues.length, 1, '首行被当作 cue identifier 容忍');
});

test('VTT：真实 NOTE 块仍计数（对照）', () => {
  const r = parseVtt('WEBVTT\n\nNOTE\n这是注释\n\n00:01.000 --> 00:02.000\n台词\n');
  assert.equal(r.stats.noteBlocks, 1);
});

/* ---------------- SRT 边界 ---------------- */

test('SRT：strict 模式 end<=start 抛 PARSE_ERROR', () => {
  const src = '1\n00:00:02,000 --> 00:00:01,000\n台词\n';
  assert.throws(
    () => parseSrt(src, { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('SRT：非数字序号行记警告但仍解析', () => {
  const r = parseSrt('abc\n00:00:01,000 --> 00:00:02,000\n台词\n');
  assert.equal(r.cues.length, 1);
  assert.ok(r.stats.warnings.some((w) => w.includes('序号行')), '非数字序号应记警告');
});

/* ---------------- ASS 边界 ---------------- */

test('ASS：空输入抛 PARSE_ERROR', () => {
  assert.throws(() => parseAss(''), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('ASS：注释行（; 开头）跳过且后续 Key:Value 仍解析', () => {
  const r = parseAss('[Script Info]\n; 这是注释\nTitle: t\n');
  assert.equal(r.info.title, 't');
});

test('ASS：Style 字段数少于 Format 声明 → lenient 跳过并计数', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, Strikeout, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: A',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 0, '字段不足应跳过该 Style');
  assert.ok(r.stats.skippedBlocks >= 1);
});

test('ASS：Style 含非法颜色值 → catch 回退默认 primary 并记警告', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Bad, Arial, 40, notacolor',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 1, '仍应创建样式对象');
  assert.deepEqual(r.styles[0].primary, { r: 255, g: 255, b: 255, alpha: 1 }, '非法颜色回退默认白');
  assert.ok(r.stats.warnings.length >= 1, '应记录颜色解析失败警告');
});

test('ASS：Dialogue 字段数少于 Format 声明 → lenient 跳过并计数', () => {
  const src = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.stats.dialogueCount, 0);
  assert.ok(r.stats.skippedBlocks >= 1);
});

/* ---------------- time.js 回归 ---------------- */

test('parseTimestamp：纯空白串抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp('   '), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('parseTimestamp：空串抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp(''), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

/* ---------------- cue / layout 工具 ---------------- */

test('cuesDurationUs：空数组为 0，非空取最大 endUs', () => {
  assert.equal(cuesDurationUs([]), 0);
  assert.equal(cuesDurationUs([
    { startUs: 0, endUs: 5_000_000, text: 'a' },
    { startUs: 0, endUs: 9_000_000, text: 'b' },
  ]), 9_000_000);
});

test('approximateMeasure：字间距按 (len-1) 叠加', () => {
  // AB 两个 ASCII：2*0.5*10 + (2-1)*2 = 10 + 2 = 12
  assert.equal(approximateMeasure('AB', { fontSize: 10, spacing: 2 }), 12);
  assert.equal(approximateMeasure('中', { fontSize: 10, spacing: 0 }), 10);
});
