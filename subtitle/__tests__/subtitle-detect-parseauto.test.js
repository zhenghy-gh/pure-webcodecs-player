/**
 * subtitle/__tests__/subtitle-detect-parseauto.test.js — parseAuto 分派 + 嗅探边界深化
 *
 * 覆盖 detect.js 在现有测试中完全缺失的分支：
 *   - parseAuto 按嗅探结果分派到对应解析器（vtt/srt/ass）并透传 options
 *   - parseAuto 无法识别格式抛 NOT_SUPPORTED
 *   - detectFormat 判定优先级（WEBVTT 签名优先于 ASS 结构）与 SSA/V4 节头、大小写、前导空白
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, probeSubtitleCodec, parseAuto, parseSrt, parseVtt, parseAss,
  SubtitleError,
} from '../src/index.js';

/* ---------------- parseAuto 分派 ---------------- */

const VTT = 'WEBVTT\n\n00:01.000 --> 00:02.000\n台词';
const SRT = '1\n00:00:01,000 --> 00:00:02,000\n台词\n';
const ASS = '[Script Info]\nTitle: t\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour\nStyle: Default,Arial,40,&HFFFFFF\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,你好\n';

test('parseAuto：WEBVTT 签名分派到 parseVtt（含 codec 串）', () => {
  const r = parseAuto(VTT);
  assert.equal(r.format, 'vtt');
  assert.equal(r.codec, 'x-vtt');
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '台词');
});

test('parseAuto：SRT 时间行分派到 parseSrt', () => {
  const r = parseAuto(SRT);
  assert.equal(r.format, 'srt');
  assert.equal(r.codec, 'x-srt');
  assert.equal(r.cues.length, 1);
});

test('parseAuto：ASS 结构分派到 parseAss（含样式解析）', () => {
  const r = parseAuto(ASS);
  assert.equal(r.format, 'ass');
  assert.equal(r.codec, 'x-ass');
  assert.equal(r.styles.length, 1);
  assert.equal(r.cues.length, 1);
});

test('parseAuto：透传 strict 选项给解析器', () => {
  const broken = 'WEBVTT\n\n这块没有时间行就垃圾\n';
  assert.throws(
    () => parseAuto(broken, { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('parseAuto：无法识别的格式抛 NOT_SUPPORTED', () => {
  assert.throws(
    () => parseAuto('随便的文本内容，没有字幕结构'),
    (e) => e instanceof SubtitleError && e.code === 'NOT_SUPPORTED',
  );
});

/* ---------------- detectFormat 边界（深化） ---------------- */

test('detectFormat：WEBVTT 签名优先于内嵌 ASS 结构（返回 vtt）', () => {
  const mixed = 'WEBVTT\n\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x\n';
  assert.equal(detectFormat(mixed), 'vtt', '签名优先，不应回退到 ass');
});

test('detectFormat：SSA 旧式 [V4 Styles]（无 + 号）仍识别为 ass', () => {
  assert.equal(detectFormat('[V4 Styles]\nFormat: ...'), 'ass');
});

test('detectFormat：[script info] 大小写与前导空白容忍', () => {
  assert.equal(detectFormat('  [Script Info]\nTitle: t'), 'ass');
  assert.equal(detectFormat('[SCRIPT INFO]\nTitle: t'), 'ass');
});

test('detectFormat：Dialogue 行前导空白仍识别为 ass', () => {
  assert.equal(detectFormat('   Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x'), 'ass');
});

test('detectFormat：仅 STYLE/REGION 块无签名的 VTT 不被误判', () => {
  // 无 WEBVTT 签名、无时间点、无 ASS 结构 → 无法识别
  assert.equal(detectFormat('STYLE\n::cue{color:red}\n'), null);
});

test('probeSubtitleCodec：三类内联映射', () => {
  assert.equal(probeSubtitleCodec(VTT), 'x-vtt');
  assert.equal(probeSubtitleCodec(SRT), 'x-srt');
  assert.equal(probeSubtitleCodec(ASS), 'x-ass');
});
