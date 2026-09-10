/**
 * subtitle/__tests__/subtitle-vtt-cue.test.js — WebVTT 设置扩展 + Cue 工具边界
 *
 * 分组 A：WebVTT 现有测试未覆盖的设置扩展与边角
 *   - cue settings 全键（vertical/line/size/position/align）保留
 *   - 无冒号 settings token 被忽略
 *   - 内联 HTML 标签（<c.x>）解析器原样保留（不转义、不剥离）
 *   - 带小时位时间戳、NOTE 多行、仅签名、空文本 cue、标识符行
 *   - BOM VTT
 * 分组 B：cue.js 工具边界（normalizeText / findActiveCues / shiftCues / sortCues / stripCueTags）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVtt, normalizeText, findActiveCues, shiftCues, sortCues, stripCueTags,
} from '../src/index.js';

/* ---------------- 分组 A：WebVTT 扩展 ---------------- */

test('VTT：cue settings 全键（vertical/line/size/position/align）保留', () => {
  const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 vertical:rl line:0 position:50% size:60% align:center\n文本\n';
  const { cues } = parseVtt(src);
  assert.deepEqual(cues[0].settings, {
    vertical: 'rl', line: '0', position: '50%', size: '60%', align: 'center',
  });
});

test('VTT：settings 中无冒号 token 被忽略', () => {
  const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start junk\n文本\n';
  const { cues } = parseVtt(src);
  assert.deepEqual(cues[0].settings, { align: 'start' });
});

test('VTT：内联 HTML 标签 <c.x> 被原样保留（解析器不剥离）', () => {
  const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>黄</c>字\n';
  const { cues } = parseVtt(src);
  assert.ok(cues[0].text.startsWith('<c.yellow>黄</c>字'), 'inline HTML 标签应被原样保留');
});

test('VTT：带小时位时间戳解析', () => {
  const src = 'WEBVTT\n\n00:01:02.000 --> 00:01:03.500\nx\n';
  const { cues } = parseVtt(src);
  assert.equal(cues[0].startUs, 62_000_000);  // 1m2s
  assert.equal(cues[0].endUs, 63_500_000);
});

test('VTT：NOTE 多行注释整体跳过并计数', () => {
  const src = 'WEBVTT\n\nNOTE\n这是\n多行注释\n\n00:01.000 --> 00:02.000\nx\n';
  const r = parseVtt(src);
  assert.equal(r.stats.noteBlocks, 1);
  assert.equal(r.cues.length, 1);
});

test('VTT：仅签名文件合法且零 cue、durationUs 0', () => {
  const r = parseVtt('WEBVTT');
  assert.equal(r.cues.length, 0);
  assert.equal(r.durationUs, 0);
});

test('VTT：时间行后无文本 → 空文本 cue 仍计入', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 00:02.000\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '');
});

test('VTT：显式 cue identifier 行被容忍', () => {
  const src = 'WEBVTT\n\nid-1\n00:01.000 --> 00:02.000\n文本\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
});

test('VTT：带尾注签名（WEBVTT - x）仍可解析', () => {
  const src = 'WEBVTT - 我的字幕\n\n00:01.000 --> 00:02.000\nx\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
});

test('VTT：BOM 前缀正常解析', () => {
  const src = '\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nx\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
});

/* ---------------- 分组 B：Cue 工具边界 ---------------- */

test('normalizeText：剥离 BOM 并统一 CRLF→LF', () => {
  assert.equal(normalizeText('\uFEFFa\r\nb\r\nc'), 'a\nb\nc');
  assert.equal(normalizeText('x\r\ny'), 'x\ny');
});

test('normalizeText：非字符串输入安全转字符串', () => {
  assert.equal(normalizeText(/** @type {any} */ (123)), '123');
});

test('findActiveCues：空数组与无命中返回空', () => {
  assert.deepEqual(findActiveCues([], 0), []);
  const cues = [{ startUs: 5_000_000, endUs: 6_000_000, text: '' }];
  assert.deepEqual(findActiveCues(cues, 0), []);
});

test('findActiveCues：重叠区间都返回且保持原序', () => {
  const cues = [
    { startUs: 0, endUs: 2_000_000, text: 'a' },
    { startUs: 1_000_000, endUs: 3_000_000, text: 'b' },
  ];
  const hit = findActiveCues(cues, 1_500_000);
  assert.equal(hit.length, 2);
  assert.deepEqual(hit.map((c) => c.text), ['a', 'b']);
});

test('shiftCues：正平移且不改入参', () => {
  const input = [{ startUs: 1_000, endUs: 2_000, text: 't' }];
  const out = shiftCues(input, 500);
  assert.equal(out[0].startUs, 1_500);
  assert.equal(out[0].endUs, 2_500);
  assert.equal(input[0].startUs, 1_000);
});

test('shiftCues：负平移钳制为 0', () => {
  const out = shiftCues([{ startUs: 500, endUs: 1_000, text: 't' }], -10_000);
  assert.equal(out[0].startUs, 0);
  assert.equal(out[0].endUs, 0);
});

test('sortCues：空数组与单元素', () => {
  assert.deepEqual(sortCues([]), []);
  const single = [{ startUs: 1, endUs: 2, text: 'x' }];
  const out = sortCues(single);
  assert.equal(out.length, 1);
  assert.notEqual(out, single, '应返回新数组');
});

test('stripCueTags：嵌套与多个 HTML/ASS 标签', () => {
  assert.equal(stripCueTags('<i>斜</i><b>粗</b>'), '斜粗');
  assert.equal(stripCueTags('{\\pos(1,1)}{\\c&HFF&}纯文本'), '纯文本');
  assert.equal(stripCueTags('<v 张三>说话'), '说话');
});
