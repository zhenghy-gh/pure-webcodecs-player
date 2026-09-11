/**
 * subtitle/__tests__/renderer.test.js — Canvas 渲染器（Node 下用注入式 stub 2D 上下文）
 *
 * renderer.js 在 Node 无 Canvas，但构造函数只要求一个带 `getContext` 的对象，
 * 因此注入一个记录调用的假 2D 上下文即可在 Node 断言「绘制几何 / 样式透传」
 * 而不依赖真实像素。重点覆盖：空轨短路、居中对齐、行内样式（粗/斜/下划线/颜色）、
 * 几何定位（\pos 直通）、多行折行、多 cue 堆叠、attach 在 Node 无 rAF 降级。
 *
 * 注意：drawLineRuns 对每条文本会先画阴影层（偏移 fillText）再画主填充层，
 * 故每个文本片段产生 2 次 fillText（其中「主绘制」= 该 text 的最后一次 fillText）。
 * 几何/样式断言统一看 mainDraws()。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtitleCanvasRenderer, isRendererSupported, rgbaToCss } from '../src/index.js';
import { createDefaultStyle } from '../src/index.js';

/** 记录全部绘制调用的假 2D 上下文（测宽按字符数×10 确定性返回） */
class StubCtx {
  constructor() {
    this._font = ''; this._ta = ''; this._fs = ''; this._ga = 1; this._tb = '';
    this.calls = { fillText: [], fillRect: [], strokeText: [], clearRect: [], scale: [] };
  }
  save() {} restore() {}
  clearRect(x, y, w, h) { this.calls.clearRect.push({ x, y, w, h }); }
  scale(sx, sy) { this.calls.scale.push({ sx, sy }); }
  translate() {} rotate() {} beginPath() {} rect() {} clip() {}
  fillText(text, x, y) {
    this.calls.fillText.push({ text, x, y, font: this._font, textAlign: this._ta, textBaseline: this._tb, fillStyle: this._fs, globalAlpha: this._ga });
  }
  strokeText(text, x, y) { this.calls.strokeText.push({ text, x, y }); }
  fillRect(x, y, w, h) { this.calls.fillRect.push({ x, y, w, h }); }
  measureText(t) { return { width: t ? [...String(t)].length * 10 : 0 }; }
  set font(v) { this._font = v; } get font() { return this._font; }
  set textAlign(v) { this._ta = v; } get textAlign() { return this._ta; }
  set fillStyle(v) { this._fs = v; } get fillStyle() { return this._fs; }
  set globalAlpha(v) { this._ga = v; } get globalAlpha() { return this._ga; }
  set textBaseline(v) { this._tb = v; } get textBaseline() { return this._tb; }
  set lineWidth(v) {} get lineWidth() { return 0; }
  set lineJoin(v) {} get lineJoin() { return ''; }
  set strokeStyle(v) {} get strokeStyle() { return ''; }
}

/** 构造一个可被渲染器接受的假画布 + 上下文 + 调用记录 */
function makeStubCanvas(width = 640, height = 360) {
  const ctx = new StubCtx();
  const canvas = { width, height, getContext: () => ctx };
  return { canvas, ctx };
}

/** 由默认样式造一个片段样式快照（与 layout.snapshotFromStyle 同形状） */
function styleSnap(over = {}) {
  const d = createDefaultStyle();
  return {
    fontName: d.fontname, fontSize: d.fontsize, bold: d.bold, italic: d.italic,
    underline: d.underline, strikeout: d.strikeout, spacing: d.spacing,
    primary: d.primary, outlineColor: d.outlineColor, outlineWidth: d.outlineWidth,
    scaleX: d.scaleX, scaleY: d.scaleY, rotation: d.angle, ...over,
  };
}

/** 渲染并返回上下文；每次调用使用全新 stub，避免调用记录跨用例累积 */
function renderOnce(cues, timeUs = 1_000_000) {
  const { canvas, ctx } = makeStubCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues });
  r.renderAt(timeUs);
  return { canvas, ctx, renderer: r };
}

/** 取出「主绘制」调用：某 text 的最后一次 fillText（过滤掉前置的阴影层） */
function mainDraws(ctx) {
  const all = ctx.calls.fillText;
  return all.filter((f, i) => !all.slice(i + 1).some((g) => g.text === f.text));
}

test('renderer：构造需要 getContext 函数，非 canvas 抛 STATE_ERROR', () => {
  assert.throws(() => new SubtitleCanvasRenderer(/** @type {any} */ (null)), (e) => e.code === 'STATE_ERROR');
  assert.throws(() => new SubtitleCanvasRenderer(/** @type {any} */ ({})), (e) => e.code === 'STATE_ERROR');
  // getContext 存在但返回 null → NOT_SUPPORTED
  assert.throws(
    () => new SubtitleCanvasRenderer(/** @type {any} */ ({ getContext: () => null })),
    (e) => e.code === 'NOT_SUPPORTED',
  );
});

test('renderer：空轨不绘制，仅清屏一次', () => {
  const { ctx } = renderOnce([]);
  assert.equal(ctx.calls.fillText.length, 0);
  assert.equal(ctx.calls.clearRect.length, 1);
});

test('renderer：单条居中字幕 textAlign=center 且主绘制于水平中心', () => {
  const { ctx } = renderOnce([{ startUs: 0, endUs: 5_000_000, text: '台词' }]);
  const mains = mainDraws(ctx);
  assert.equal(mains.length, 1);
  assert.equal(mains[0].textAlign, 'center');
  assert.ok(Math.abs(mains[0].x - 320) < 1e-6, `主绘制 x 应≈320（画布中心），实际 ${mains[0].x}`);
  assert.equal(ctx.calls.scale.length, 1); // 整体按 PlayRes 缩放
});

test('renderer：粗体 → font 串含 700；斜体 → 含 italic', () => {
  const bold = renderOnce([{ startUs: 0, endUs: 2_000_000, text: '粗', segments: [{ type: 'text', text: '粗', style: styleSnap({ bold: true, fontSize: 48 }) }] }]);
  assert.match(mainDraws(bold.ctx)[0].font, /700/);
  const ital = renderOnce([{ startUs: 0, endUs: 2_000_000, text: '斜', segments: [{ type: 'text', text: '斜', style: styleSnap({ italic: true, fontSize: 48 }) }] }]);
  assert.match(mainDraws(ital.ctx)[0].font, /italic/);
});

test('renderer：下划线 → 触发 fillRect（底框/下划线绘制）', () => {
  const { ctx } = renderOnce([{ startUs: 0, endUs: 2_000_000, text: '下', segments: [{ type: 'text', text: '下', style: styleSnap({ underline: true, fontSize: 48 }) }] }]);
  assert.ok(ctx.calls.fillRect.length >= 1, '下划线应产生 fillRect 调用');
});

test('renderer：主填充色经 rgbaToCss 透传为 main fillStyle', () => {
  const red = { r: 255, g: 0, b: 0, alpha: 1 };
  const { ctx } = renderOnce([{ startUs: 0, endUs: 2_000_000, text: '红', segments: [{ type: 'text', text: '红', style: styleSnap({ primary: red, fontSize: 48 }) }] }]);
  assert.equal(mainDraws(ctx)[0].fillStyle, rgbaToCss(red));
});

test('renderer：\\pos 绝对定位 → 主绘制参考 X 直通 pos.x', () => {
  const { ctx } = renderOnce([{ startUs: 0, endUs: 2_000_000, text: '定', segments: [{ type: 'text', text: '定', style: styleSnap({ fontSize: 48 }) }], geom: { pos: { x: 100, y: 100 }, an: 5 } }]);
  assert.ok(Math.abs(mainDraws(ctx)[0].x - 100) < 1e-6, `x 应≈100，实际 ${mainDraws(ctx)[0].x}`);
});

test('renderer：九宫锚点 → textAlign/textBaseline 映射（1/3/5/7/9）', () => {
  const cases = [
    [1, 'left', 'alphabetic'], [3, 'right', 'alphabetic'],
    [5, 'center', 'middle'], [7, 'left', 'top'], [9, 'right', 'top'],
  ];
  for (const [an, ta, tb] of cases) {
    const { ctx } = renderOnce([{ startUs: 0, endUs: 2_000_000, text: 'x', segments: [{ type: 'text', text: 'x', style: styleSnap({ fontSize: 48 }) }], geom: { an } }]);
    const m = mainDraws(ctx)[0];
    assert.equal(m.textAlign, ta, `an=${an} textAlign`);
    assert.equal(m.textBaseline, tb, `an=${an} textBaseline`);
  }
});

test('renderer：长文本不自行折行（折行属 layout.wrapSegments 职责，渲染器按既有 lines 绘制）', () => {
  const long = '字'.repeat(200); // 200 字 ×10 = 2000，远超画布宽
  const { ctx } = renderOnce([{ startUs: 0, endUs: 5_000_000, text: long }]);
  // 现状记录：renderer.js 内部无折行实现；折行由 layout.js:111 wrapSegments 在 layoutEvents 阶段完成。
  // 未经 layout 处理的原始 cue 会被当作单行绘制（长文本溢出而非折行）。
  assert.equal(mainDraws(ctx).length, 1, '未过 layout 的原始 cue 渲染为单行');
});

test('renderer：重叠双 cue 都绘制且被堆叠（主绘制基线 y 不同）', () => {
  const { ctx } = renderOnce([
    { startUs: 0, endUs: 5_000_000, text: '长字幕第一条' },
    { startUs: 1_000_000, endUs: 3_000_000, text: '第二条' },
  ]);
  const mains = mainDraws(ctx);
  assert.ok(mains.some((f) => f.text === '长字幕第一条'), '第一条应绘制');
  assert.ok(mains.some((f) => f.text === '第二条'), '第二条应绘制');
  const y1 = mains.find((f) => f.text === '长字幕第一条').y;
  const y2 = mains.find((f) => f.text === '第二条').y;
  assert.notEqual(y1, y2, '堆叠后两条基线 y 不同');
});

test('renderer：clear() 后不再绘制', () => {
  const { canvas, ctx } = makeStubCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'x' }] });
  r.renderAt(1_000_000);
  assert.ok(mainDraws(ctx).length >= 1);
  r.clear();
  ctx.calls.fillText.length = 0;
  r.renderAt(1_000_000);
  assert.equal(ctx.calls.fillText.length, 0, 'clear 后不应再绘制');
});

test('renderer：Node 无 rAF 时 attach 安全降级为 no-op 停止函数', () => {
  assert.equal(isRendererSupported(), false);
  const { canvas } = makeStubCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  const stop = r.attach(() => 1_000_000); // 返回微秒的函数时钟
  assert.equal(typeof stop, 'function', 'attach 应返回停止函数');
  assert.doesNotThrow(() => stop());
  // 普通对象/视频式时钟也能接受
  assert.doesNotThrow(() => r.attach({ currentTimeUs: () => 1_000_000 }));
  assert.doesNotThrow(() => r.attach({ currentTime: 1 }));
});

test('renderer：attach 在无 rAF 环境下不自动循环调用 renderAt', () => {
  const { canvas } = makeStubCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  let called = 0;
  const orig = r.renderAt.bind(r);
  r.renderAt = (us) => { called++; return orig(us); };
  const stop = r.attach(() => 2_000_000);
  assert.equal(called, 0, '无 rAF 时不应自动驱动 renderAt');
  stop();
});

test('renderer：setCues 覆盖旧轨道（替换而非合并）', () => {
  const { canvas: c2, ctx: ctx2 } = makeStubCanvas();
  const r2 = new SubtitleCanvasRenderer(c2);
  r2.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'a' }] });
  r2.renderAt(1_000_000);
  assert.ok(mainDraws(ctx2).some((f) => f.text === 'a'));
  r2.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'b' }] });
  ctx2.calls.fillText.length = 0;
  r2.renderAt(1_000_000);
  assert.ok(mainDraws(ctx2).some((f) => f.text === 'b'));
  assert.ok(!mainDraws(ctx2).some((f) => f.text === 'a'), '旧轨道不应残留');
});
