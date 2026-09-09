/**
 * subtitle/__tests__/misc.test.js — 嗅探 / 自动分派 / Cue 工具 / 错误类型 / 渲染器 Node 行为
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, probeSubtitleCodec, parseAuto,
  sortCues, shiftCues, cuesDurationUs, stripCueTags, unescapeAssText,
  SubtitleError, SubtitleCanvasRenderer, isRendererSupported, TAG_WHITELIST,
} from '../src/index.js';
import { readFix } from './helpers.mjs';

test('detectFormat：三种格式与未知输入', async () => {
  assert.equal(detectFormat(await readFix('sample-basic.srt')), 'srt');
  assert.equal(detectFormat(await readFix('sample-basic.vtt')), 'vtt');
  assert.equal(detectFormat(await readFix('sample-styled.ass')), 'ass');
  assert.equal(detectFormat('随便的文本'), null);
  assert.equal(detectFormat(''), null);
});

test('detectFormat：带 BOM 的 VTT', () => {
  assert.equal(detectFormat('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nx'), 'vtt');
});

test('probeSubtitleCodec：映射到契约 codec 串', async () => {
  assert.equal(probeSubtitleCodec(await readFix('sample-basic.srt')), 'x-srt');
  assert.equal(probeSubtitleCodec(await readFix('sample-basic.vtt')), 'x-vtt');
  assert.equal(probeSubtitleCodec(await readFix('sample-styled.ass')), 'x-ass');
  assert.equal(probeSubtitleCodec('???'), null);
});

test('parseAuto：按嗅探分派（以返回 format 为证）', async () => {
  assert.equal(parseAuto(await readFix('sample-basic.srt')).format, 'srt');
  assert.equal(parseAuto(await readFix('sample-blocks.vtt')).format, 'vtt');
  assert.equal(parseAuto(await readFix('sample-styled.ass')).format, 'ass');
});

test('parseAuto：无法识别抛 NOT_SUPPORTED', () => {
  assert.throws(() => parseAuto('gibberish'), (e) => e.code === 'NOT_SUPPORTED');
});

test('sortCues：稳定排序且不改入参', () => {
  const input = [
    { startUs: 3_000_000, endUs: 4_000_000, text: 'b' },
    { startUs: 1_000_000, endUs: 5_000_000, text: 'a' },
    { startUs: 1_000_000, endUs: 2_000_000, text: 'a2' },
  ];
  const snapshot = JSON.stringify(input);
  const out = sortCues(input);
  assert.equal(JSON.stringify(input), snapshot);   // 入参不变
  assert.deepEqual(out.map((c) => c.text), ['a', 'a2', 'b']); // 同起点保持原相对序
});

test('shiftCues：整体平移并钳制非负，不改入参', () => {
  const input = [{ startUs: 500_000, endUs: 1_000_000, text: 't' }];
  const shifted = shiftCues(input, -1_000_000);
  assert.equal(shifted[0].startUs, 0);
  assert.equal(shifted[0].endUs, 0);
  assert.equal(input[0].startUs, 500_000);
});

test('cuesDurationUs：空数组为 0，否则取最大结束时间', () => {
  assert.equal(cuesDurationUs([]), 0);
  assert.equal(cuesDurationUs([
    { startUs: 0, endUs: 100, text: '' },
    { startUs: 0, endUs: 900, text: '' },
  ]), 900);
});

test('stripCueTags：HTML 标签与 ASS 覆盖块都剥除', () => {
  assert.equal(stripCueTags('<i>斜</i>体'), '斜体');
  assert.equal(stripCueTags('{\\pos(1,1)}纯文本'), '纯文本');
});

test('unescapeAssText：\\N、\\n、\\h 转义还原', () => {
  assert.equal(unescapeAssText('甲\\N乙'), '甲\n乙');
  assert.equal(unescapeAssText('甲\\n乙'), '甲\n乙');
  assert.equal(unescapeAssText('甲\\h乙'), '甲\u00A0乙');
});

test('TAG_WHITELIST：白名单内容抽查', () => {
  for (const t of ['pos', 'move', 'org', 'an', 'fad', 'fscx', 'fscy', 'frz', 'clip', 'fs', 'fsp']) {
    assert.equal(TAG_WHITELIST.has(t), true);
  }
  for (const t of ['t', 'k', 'p', 'bord', 'shad', 'be', 'fade']) {
    assert.equal(TAG_WHITELIST.has(t), false);
  }
});

test('SubtitleError：code/detail 字段与 Error 原型', () => {
  const err = new SubtitleError('PARSE_ERROR', '测试错误', { detail: { line: 7 } });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'PARSE_ERROR');
  assert.deepEqual(err.detail, { line: 7 });
  assert.equal(err.name, 'SubtitleError');
});

test('Node 环境：isRendererSupported() 恒为 false 且不抛异常', () => {
  assert.equal(isRendererSupported(), false);
});

test('Node 环境：渲染器构造抛 STATE_ERROR（需要 canvas）', () => {
  assert.throws(
    () => new SubtitleCanvasRenderer(/** @type {any} */ (null)),
    (e) => e instanceof SubtitleError && e.code === 'STATE_ERROR',
  );
});
