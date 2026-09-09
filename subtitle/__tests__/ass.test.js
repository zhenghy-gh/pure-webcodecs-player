/**
 * subtitle/__tests__/ass.test.js — ASS/SSA 解析器（样式段 + Dialogue 白名单标签）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAss } from '../src/index.js';
import { SubtitleError } from '../src/index.js';
import { readFix } from './helpers.mjs';

/** 取第 n 条（0 基）Dialogue 的便捷访问 */
async function styledAss() {
  return parseAss(await readFix('sample-styled.ass'));
}

test('ASS：格式与 codec 串', async () => {
  const r = await styledAss();
  assert.equal(r.format, 'ass');
  assert.equal(r.codec, 'x-ass');
});

test('ASS：Script Info 解析（含 PlayRes 数值化）', async () => {
  const { info } = await styledAss();
  assert.equal(info.playResX, 640);
  assert.equal(info.playResY, 360);
  assert.equal(info.title, 'PurePlay 功能演示');
});

test('ASS：样式表解析数量与字体', async () => {
  const { styles } = await styledAss();
  assert.equal(styles.length, 2);
  assert.equal(styles[0].name, 'Default');
  assert.equal(styles[0].fontname, '思源黑体');
  assert.equal(styles[0].fontsize, 48);
});

test('ASS：颜色 &HAABBGGRR 小端解析与 alpha 反转', async () => {
  const { styles } = await styledAss();
  const d = styles[0];
  assert.deepEqual([d.primary.r, d.primary.g, d.primary.b], [255, 255, 255]);
  assert.equal(d.primary.alpha, 1);                    // AA=00 → 不透明
  assert.deepEqual([d.outlineColor.r, d.outlineColor.g, d.outlineColor.b], [16, 16, 16]);
  assert.ok(Math.abs(d.back.alpha - (1 - 127 / 255)) < 1e-9); // &H7F...
  assert.equal(d.outlineWidth, 2);
});

test('ASS：布尔字段 -1/0 语义', async () => {
  const { styles } = await styledAss();
  assert.equal(styles[0].bold, true);   // -1
  assert.equal(styles[0].italic, false);
  const top = styles[1];
  assert.equal(top.bold, false);
  assert.equal(top.italic, true);
  assert.equal(top.alignment, 8);
  assert.equal(top.scaleX, 80);
  assert.equal(top.scaleY, 120);
});

test('ASS：Comment 行计数但不进入轨道', async () => {
  const r = await styledAss();
  assert.equal(r.stats.commentCount, 1);
  assert.equal(r.stats.dialogueCount, 5);
  assert.equal(r.cues.length, 5);
});

test('ASS：Text 字段内半角逗号不切分', async () => {
  const { cues } = await styledAss();
  assert.equal(cues[0].text.includes(','), true);
  assert.equal(cues[0].text, '普通台词,半角逗号保留');
});

test('ASS：\\N 换行与 \\h 不换行空格还原', async () => {
  const { cues } = await styledAss();
  assert.ok(cues[3].text.includes('\n'));
  assert.ok(cues[3].text.includes('\u00A0'));
});

test('ASS：白名单外标签进入未支持清单且不崩溃', async () => {
  const r = await styledAss();
  assert.deepEqual(r.unsupportedTags, ['bord', 'k']);
  const c2 = r.cues[2];
  assert.deepEqual(c2.unsupported.sort(), ['bord', 'k']);
});

test('ASS：\\pos / \\an / \\fad 几何覆盖导出', async () => {
  const { cues } = await styledAss();
  const g = /** @type {any} */ (cues[1]).geom;
  assert.deepEqual(g.pos, { x: 320, y: 50 });
  assert.equal(g.an, 5);
  assert.deepEqual(g.fad, { t1: 200, t2: 300 });
});

test('ASS：\\move 参数完整解析', async () => {
  const { cues } = await styledAss();
  const g = /** @type {any} */ (cues[3]).geom;
  assert.deepEqual(g.move, { x1: 100, y1: 300, x2: 500, y2: 100, t1: 0, t2: 0 });
});

test('ASS：\\fs+ 相对叠加与 \\fsp 字间距', async () => {
  const { cues } = await styledAss();
  const segs = /** @type {any} */ (cues[2]).segments;
  const run = segs.find((/** @type {any} */ s) => s.type === 'text' && s.text.includes('字号叠加'));
  assert.equal(run.style.fontSize, 56); // 48 + 8
  assert.equal(run.style.spacing, 2);
});

test('ASS：引用不存在样式回退到首个可用样式', async () => {
  const { cues, styles } = await styledAss();
  assert.equal(cues[4].style, styles[0].name);
});

test('ASS：畸形时间码 lenient 跳过并计数', async () => {
  const r = parseAss(await readFix('sample-broken.ass'));
  assert.equal(r.cues.length, 1);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('ASS：畸形时间码 strict 抛 PARSE_ERROR', async () => {
  await assert.rejects(
    async () => parseAss(await readFix('sample-broken.ass'), { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('ASS：非 ASS 结构抛 NOT_SUPPORTED', () => {
  assert.throws(() => parseAss('hello world'), (e) => e.code === 'NOT_SUPPORTED');
});

test('ASS：SSA(V4 Styles) 变体可解析', () => {
  const src = [
    '[Script Info]',
    'Collisions: Normal',
    '',
    '[V4 Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding',
    'Style: Default,Arial,20,&HFFFFFF,&H0000FF,&H0,&H0,0,0,1,1,0,2,10,10,10,0,1',
    '',
    '[Events]',
    'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 老格式台词',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 1);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].layer, 0); // Marked=0 → layer 0
});
