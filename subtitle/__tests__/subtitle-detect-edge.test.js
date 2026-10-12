/**
 * subtitle/__tests__/subtitle-detect-edge.test.js — 格式嗅探边界（detect.js 深水区）
 *
 * 补充 subtitle-detect-track.test.js / detect.js 相关用例未覆盖的输入：
 *   - WEBVTT 签名优先于 SRT 箭头（签名即定案）
 *   - 仅 [Script Info] 头（无 Dialogue/Styles）→ ass
 *   - SRT 正文混入 ASS 节头或 Dialogue 行仍按 SRT 识别，真 ASS 文件按位置优先
 *   - 结束时间缺失的时间行仍按 SRT 模式命中
 *   - 2 位毫秒、首行数字 + 点毫秒 → srt
 *   - 仅 Dialogue: 行 → ass
 *   - BOM + SRT → srt
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseAuto, probeSubtitleCodec } from '../src/index.js';

test('detect：WEBVTT 签名优先于 SRT 风格箭头', () => {
  const src = 'WEBVTT\n\n1\n00:00:01,000 --> 00:00:02,000\nx\n';
  assert.equal(detectFormat(src), 'vtt');
});

test('detect：仅 [Script Info] 头（无 Dialogue/Styles）→ ass', () => {
  const src = '[Script Info]\nTitle: 只有头\nPlayResX: 640\n';
  assert.equal(detectFormat(src), 'ass');
});

test('detect：SRT 正文混入 [Script Info] 行仍判为 SRT', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n[Script Info]\nTitle: t\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,payload\n';
  assert.equal(detectFormat(src), 'srt');
  assert.equal(probeSubtitleCodec(src), 'x-srt');
  assert.equal(parseAuto(src).format, 'srt');
});

test('detect：ASS 节头先于时间行时仍按 ASS 识别', () => {
  const src = '[Script Info]\nTitle: ASS\n\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x\n';
  assert.equal(detectFormat(src), 'ass');
});

test('detect：ASS 结构先于 SRT 时间行时保留 ASS 判定', () => {
  const src = '[Script Info]\nTitle: ASS\n\n00:00:01,000 --> 00:00:02,000\nx\n';
  assert.equal(detectFormat(src), 'ass');
});

test('detect：结束时间缺失的时间行仍按 SRT 模式命中', () => {
  const src = '00:00:01,000 -->\n';
  assert.equal(detectFormat(src), 'srt');
});

test('detect：2 位毫秒 SRT 时间行命中', () => {
  const src = '1\n00:00:01,00 --> 00:00:02,000\nx\n';
  assert.equal(detectFormat(src), 'srt');
});

test('detect：首行为数字 + 点毫秒时间行 → srt（不走无签名 VTT 分支）', () => {
  const src = '1\n00:01.000 --> 00:02.000\nx\n';
  assert.equal(detectFormat(src), 'srt');
});

test('detect：仅 Dialogue: 行（无节头）→ ass', () => {
  const src = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x\n';
  assert.equal(detectFormat(src), 'ass');
});

test('detect：BOM + SRT 字节串命中 srt', () => {
  const src = '\uFEFF1\n00:00:01,000 --> 00:00:02,000\nx\n';
  assert.equal(detectFormat(src), 'srt');
});

test('probeSubtitleCodec：混合输入映射', () => {
  assert.equal(probeSubtitleCodec('WEBVTT\n\n1\n00:00:01,000 --> 00:00:02,000\nx\n'), 'x-vtt');
  assert.equal(probeSubtitleCodec('[Script Info]\nTitle: t\n'), 'x-ass');
  assert.equal(probeSubtitleCodec('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x\n'), 'x-ass');
  assert.equal(probeSubtitleCodec('随机文本没有时间'), null);
});

test('detect：纯 [V4+ Styles] 节头（无 Dialogue）→ ass', () => {
  const src = '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour\nStyle: Default,Arial,20,&HFFFFFF\n';
  assert.equal(detectFormat(src), 'ass');
});
