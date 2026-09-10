/**
 * subtitle/__tests__/subtitle-style-tags.test.js — ASS 颜色/样式/标签状态机
 *
 * 覆盖 style.js 与 tags.js 中 src 现有测试未触碰的分支：
 *   - parseAssColor 多种字面量（&HAABBGGRR / 短式 &HBBGGRR / 十进制 / 非法）
 *   - rgbaToCss 输出形态
 *   - createDefaultStyle 缺省字段
 *   - TagState 逐标签应用（b/i/u/s/fs±/fsp/pos/alpha 及未支持标签累积）
 *   - tokenizeDialogue 片段切分、\1c 数字前缀、clip 矢量未支持分支
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAssColor, rgbaToCss, createDefaultStyle,
  TagState, tokenizeDialogue, unescapeAssText, TAG_WHITELIST,
  SubtitleError,
} from '../src/index.js';
import { anToAnchor } from '../src/style.js';

test('parseAssColor：&HAABBGGRR 小端 + AA 不透明反转', () => {
  // AA=00 BB=FF GG=FF RR=FF → 白（与 sample-styled.ass Default 主色一致）
  assert.deepEqual(parseAssColor('&H00FFFFFF'), { r: 255, g: 255, b: 255, alpha: 1 });
  // AA=00 BB=80 GG=FF RR=00 → 绿(0,255,128)
  assert.deepEqual(parseAssColor('&H0080FF00'), { r: 0, g: 255, b: 128, alpha: 1 });
});

test('parseAssColor：短式 &HBBGGRR 自动补零到六位', () => {
  // &HFF0000 → 蓝（r0 g0 b255）
  assert.deepEqual(parseAssColor('&HFF0000'), { r: 0, g: 0, b: 255, alpha: 1 });
  // 尾随 & 被剥离
  assert.deepEqual(parseAssColor('&H00FF00&'), { r: 0, g: 255, b: 0, alpha: 1 });
});

test('parseAssColor：纯十进制按 BGR 数值解析', () => {
  assert.deepEqual(parseAssColor('16777215'), { r: 255, g: 255, b: 255, alpha: 1 });
  const c = parseAssColor('12345');
  assert.equal(c.alpha, 1);
  assert.equal(Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b), true);
});

test('parseAssColor：非法/空字面量抛 PARSE_ERROR', () => {
  assert.throws(() => parseAssColor(''), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
  assert.throws(() => parseAssColor('red'), (e) => e.code === 'PARSE_ERROR');
  assert.throws(() => parseAssColor(null), (e) => e.code === 'PARSE_ERROR');
});

test('rgbaToCss：整数与不透明度形态', () => {
  assert.equal(rgbaToCss({ r: 255, g: 255, b: 255, alpha: 1 }), 'rgba(255,255,255,1)');
  assert.equal(rgbaToCss({ r: 0, g: 0, b: 0, alpha: 0.5 }), 'rgba(0,0,0,0.5)');
});

test('createDefaultStyle：缺省字段', () => {
  const d = createDefaultStyle();
  assert.equal(d.name, 'Default');
  assert.equal(d.fontsize, 48);
  assert.equal(d.alignment, 2);
  assert.equal(d.marginV, 10);
  assert.equal(d.bold, false);
  assert.equal(createDefaultStyle('My').name, 'My');
});

test('anToAnchor（style 版）：越界值钳制与四舍五入', () => {
  assert.deepEqual(anToAnchor(0), { h: 'left', v: 'bottom' });
  assert.deepEqual(anToAnchor(15), { h: 'right', v: 'top' });
  assert.deepEqual(anToAnchor(2.4), { h: 'center', v: 'bottom' });
  assert.deepEqual(anToAnchor(5), { h: 'center', v: 'middle' });
});

test('TagState：字符样式 b/i/u/s 切换', () => {
  const st = new TagState(createDefaultStyle());
  assert.equal(st.apply({ name: 'b', arg: '1' }), true);
  assert.equal(st.bold, true);
  assert.equal(st.apply({ name: 'b', arg: '0' }), true);
  assert.equal(st.bold, false);
  assert.equal(st.apply({ name: 'i', arg: '1' }), true);
  assert.equal(st.italic, true);
  assert.equal(st.apply({ name: 'u', arg: '-1' }), true);
  assert.equal(st.underline, true);
  assert.equal(st.apply({ name: 's', arg: '1' }), true);
  assert.equal(st.strikeout, true);
});

test('TagState：\fs 相对叠加与绝对替换', () => {
  const st = new TagState(createDefaultStyle()); // 48
  assert.equal(st.apply({ name: 'fs', arg: '+10' }), true);
  assert.equal(st.fontSize, 58);
  assert.equal(st.apply({ name: 'fs', arg: '30' }), true);
  assert.equal(st.fontSize, 30);
});

test('TagState：\fsp 字间距与 \pos 解析', () => {
  const st = new TagState(createDefaultStyle());
  assert.equal(st.apply({ name: 'fsp', arg: '3' }), true);
  assert.equal(st.spacing, 3);
  assert.equal(st.apply({ name: 'pos', arg: '320,50' }), true);
  assert.deepEqual(st.pos, { x: 320, y: 50 });
  // 非法 \pos 不崩溃、保留上一次有效值（不回退 null）
  assert.equal(st.apply({ name: 'pos', arg: 'garbage' }), true);
  assert.deepEqual(st.pos, { x: 320, y: 50 });
});

test('TagState：\alpha 影响主色不透明度', () => {
  const st = new TagState(createDefaultStyle());
  assert.equal(st.apply({ name: 'alpha', arg: '&H80&' }), true);
  assert.ok(Math.abs(st.primary.alpha - (1 - 128 / 255)) < 1e-9);
});

test('TagState：白名单外标签进入 unsupported 且 apply 返回 false', () => {
  const st = new TagState(createDefaultStyle());
  assert.equal(st.apply({ name: 'bord', arg: '10' }), false);
  assert.equal(st.apply({ name: 't', arg: '' }), false);
  assert.ok(st.unsupported.has('bord'));
  assert.ok(st.unsupported.has('t'));
  assert.equal(TAG_WHITELIST.has('bord'), false);
  assert.equal(TAG_WHITELIST.has('pos'), true);
});

test('tokenizeDialogue：覆盖块切分为 tags/text 交替片段', () => {
  const { segments, state } = tokenizeDialogue('{\\b1}粗{\\b0}普通', createDefaultStyle());
  const types = segments.map((s) => s.type);
  assert.deepEqual(types, ['tags', 'text', 'tags', 'text']);
  assert.equal(/** @type {any} */ (segments[1]).text, '粗');
  assert.equal(/** @type {any} */ (segments[3]).text, '普通');
  assert.equal(state.bold, false, '末尾 \\b0 应关闭加粗');
});

test('tokenizeDialogue：\\1c 数字前缀正确着色且不进未支持清单', () => {
  const { state } = tokenizeDialogue('{\\1c&H0000FF&}红', createDefaultStyle());
  assert.ok(!state.unsupported.has('1c'), '\\1c 不应判为未支持');
  assert.deepEqual(state.primary, { r: 255, g: 0, b: 0, alpha: 1 }, '主色应为红');
});

test('tokenizeDialogue：clip 矩形支持 / 矢量绘图进未支持清单', () => {
  const rect = tokenizeDialogue('{\\clip(1,2,3,4)}x', createDefaultStyle());
  assert.ok(!rect.state.unsupported.has('clip(矢量)'));
  assert.deepEqual(rect.state.clip, { x1: 1, y1: 2, x2: 3, y2: 4 });

  const vec = tokenizeDialogue('{\\clip(m 0 0 l 100 100)}x', createDefaultStyle());
  assert.ok(vec.state.unsupported.has('clip(矢量)'));
});

test('unescapeAssText：\\h 还原为不换行空格', () => {
  assert.equal(unescapeAssText('甲\\h乙'), '甲\u00A0乙');
});
