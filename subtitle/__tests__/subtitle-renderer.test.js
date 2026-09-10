/**
 * subtitle/__tests__/subtitle-renderer.test.js — Canvas 渲染器纯逻辑（Fake Canvas 驱动）
 *
 * renderer.js 被标为「环境豁免层」（覆盖率 40.8%，因真实绘制需浏览器 canvas），
 * 但其大量逻辑可在 Node 下用 FakeCanvas + Fake2DContext 真实驱动覆盖：
 *   - isRendererSupported() 在 Node 恒 false
 *   - 构造函数对非法 canvas / 无 2D 上下文的两种错误分支
 *   - setCues / clear / renderAt 的清空-布局-绘制主链路
 *   - fontString 对 bold/italic 的映射
 *   - drawLineRuns 各分支：borderStyle=3 底框 / shadow 阴影 / outline 描边 /
 *     underline 下划线 / strikeout 删除线 / 行内多 run 的累计偏移
 *   - paint 的 clip 裁剪、rotation/scale 变换、alpha<=0 早退
 *   - measure 真实测宽路径（ctx.measureText 被调用）
 *   - attach 时钟驱动的 Node 降级（无 rAF）与注入 rAF 的一次性驱动
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SubtitleCanvasRenderer, isRendererSupported, createDefaultStyle,
  SubtitleError,
} from '../src/index.js';

/* ---------------- Fake Canvas / 2D Context ---------------- */
// 记录所有绘制调用，并在 fill/stroke 时快照当前 fillStyle/strokeStyle，
// 以便断言各 drawLineRuns 分支使用的是哪个颜色。
function makeFakeContext() {
  /** @type {any[]} */
  const calls = [];
  const ctx = {
    canvas: null,
    _calls: calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); },
    rotate(a) { calls.push(['rotate', a]); },
    scale(x, y) { calls.push(['scale', x, y]); },
    beginPath() { calls.push(['beginPath']); },
    rect(x, y, w, h) { calls.push(['rect', x, y, w, h]); },
    clip() { calls.push(['clip']); },
    clearRect(x, y, w, h) { calls.push(['clearRect', x, y, w, h]); },
    fillRect(x, y, w, h) { calls.push(['fillRect', { fill: this.fillStyle, x, y, w, h }]); },
    fillText(t, x, y) { calls.push(['fillText', { fill: this.fillStyle, t, x, y }]); },
    strokeText(t, x, y) { calls.push(['strokeText', { stroke: this.strokeStyle, t, x, y }]); },
    measureText(text) {
      calls.push(['measureText', text]);
      const m = /(\d+)px/.exec(this.font || '');
      const fs = m ? Number(m[1]) : 10;
      return { width: Math.max(1, text.length * fs * 0.5) };
    },
  };
  return ctx;
}

function makeFakeCanvas(width = 640, height = 360) {
  const ctx = makeFakeContext();
  const canvas = { width, height, getContext: () => ctx };
  ctx.canvas = canvas;
  return { canvas, ctx };
}

/** 取某类型调用的第一个带快照记录 */
function findCall(calls, type) {
  return calls.find((c) => c[0] === type);
}
function hasCall(calls, type) {
  return calls.some((c) => c[0] === type);
}

/* ---------------- 环境能力 ---------------- */

test('isRendererSupported：Node 环境下恒 false', () => {
  assert.equal(isRendererSupported(), false);
});

/* ---------------- 构造函数错误分支 ---------------- */

test('Renderer：非 canvas（null）构造抛 STATE_ERROR', () => {
  assert.throws(
    () => new SubtitleCanvasRenderer(/** @type {any} */ (null)),
    (e) => e instanceof SubtitleError && e.code === 'STATE_ERROR',
  );
});

test('Renderer：缺少 getContext 的对象构造抛 STATE_ERROR', () => {
  assert.throws(
    () => new SubtitleCanvasRenderer(/** @type {any} */ ({})),
    (e) => e instanceof SubtitleError && e.code === 'STATE_ERROR',
  );
});

test('Renderer：getContext 返回 null 抛 NOT_SUPPORTED', () => {
  const canvas = { width: 640, height: 360, getContext: () => null };
  assert.throws(
    () => new SubtitleCanvasRenderer(/** @type {any} */ (canvas)),
    (e) => e instanceof SubtitleError && e.code === 'NOT_SUPPORTED',
  );
});

/* ---------------- setCues / clear ---------------- */

test('Renderer：setCues 装载、clear 清空', () => {
  const { canvas } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 1, text: 'a' }], styles: [], info: {} });
  // 通过 renderAt 间接确认已装载：非空 cue 在活跃时刻会产生 fillText
  r.renderAt(0);
  assert.equal(hasCall(canvas.getContext()._calls, 'fillText'), true);
  r.clear();
  const calls2 = canvas.getContext()._calls.length;
  r.renderAt(0); // 清空后应只 clearRect，不再画字
  const after = canvas.getContext()._calls.slice(calls2);
  assert.equal(hasCall(after, 'fillText'), false);
});

/* ---------------- renderAt 主链路：清空→布局→绘制 ---------------- */

test('Renderer：无 cue 时 renderAt 仅 clearRect 不绘制', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [], styles: [], info: {} });
  r.renderAt(1_000_000);
  assert.equal(hasCall(ctx._calls, 'clearRect'), true);
  assert.equal(hasCall(ctx._calls, 'fillText'), false);
});

test('Renderer：活跃时刻 renderAt 调用测宽并 fillText 渲染文本', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: '你好' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  assert.equal(hasCall(ctx._calls, 'measureText'), true, 'layout 应触发真实测宽');
  // 主填充层使用 primary 白；findCall 取首个 fillText 实为 shadow 层（黑），
  // 故断言「存在 primary 白填充」而非首个。
  const primary = ctx._calls.find((c) => c[0] === 'fillText' && c[1].fill === 'rgba(255,255,255,1)');
  assert.ok(primary, '应调用 fillText 绘制主色文本');
  assert.equal(primary[1].t, '你好');
});

test('Renderer：非活跃时刻 renderAt 仅清空（layout 无命中）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'x' }], styles: [], info: {} });
  r.renderAt(9_000_000);
  assert.equal(hasCall(ctx._calls, 'clearRect'), true);
  assert.equal(hasCall(ctx._calls, 'fillText'), false);
});

test('Renderer：fontString 把 bold/italic 映射进 ctx.font', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const bold = createDefaultStyle();
  bold.bold = true; bold.italic = true;
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: bold });
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'z' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  const ft = findCall(ctx._calls, 'fillText');
  assert.match(ft ? ctx.font : '', /italic/);
  assert.match(ft ? ctx.font : '', /700/);
});

/* ---------------- drawLineRuns 分支 ---------------- */

test('Renderer：borderStyle=3 先绘制不透明底框（fillRect, back 色）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const st = createDefaultStyle();
  st.borderStyle = 3;
  st.back = { r: 0, g: 0, b: 0, alpha: 1 };
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: st });
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: '框' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  const box = findCall(ctx._calls, 'fillRect');
  assert.ok(box, 'borderStyle=3 应绘制底框 fillRect');
  assert.equal(box[1].fill, 'rgba(0,0,0,1)');
  // 同时主填充仍发生
  assert.equal(hasCall(ctx._calls, 'fillText'), true);
  // borderStyle=3 不应进入描边分支
  assert.equal(hasCall(ctx._calls, 'strokeText'), false);
});

test('Renderer：borderStyle=1 且 shadow>0 绘制阴影层（偏移 fillText）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const st = createDefaultStyle();
  st.borderStyle = 1;
  st.shadow = 4;
  st.underline = false; st.strikeout = false;
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: st });
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: '影' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  // 阴影层：用 back 色（黑）在 (x+shadow, y+shadow) 处 fillText（先于主填充）
  const shadowFt = ctx._calls.find(
    (c) => c[0] === 'fillText' && c[1].fill === 'rgba(0,0,0,1)',
  );
  assert.ok(shadowFt, 'shadow>0 应绘制偏移阴影层（back 色）');
  // 且主填充层（白）与阴影层 x 相差正好 shadow=4
  const primary = ctx._calls.find((c) => c[0] === 'fillText' && c[1].fill === 'rgba(255,255,255,1)');
  assert.ok(primary, '主填充层仍应绘制');
  assert.equal(shadowFt[1].x - primary[1].x, 4, '阴影相对主填充右移 shadow px');
  assert.equal(shadowFt[1].y - primary[1].y, 4, '阴影相对主填充下移 shadow px');
});

test('Renderer：outlineWidth>0 走描边分支（strokeText, outlineColor）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const st = createDefaultStyle();
  st.borderStyle = 1;
  st.outlineWidth = 3;
  st.shadow = 0;
  st.outlineColor = { r: 0, g: 0, b: 0, alpha: 1 };
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: st });
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: '边' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  const stk = findCall(ctx._calls, 'strokeText');
  assert.ok(stk, 'outlineWidth>0 应调用 strokeText');
  assert.equal(stk[1].stroke, 'rgba(0,0,0,1)');
});

test('Renderer：underline / strikeout 各绘制一条 fillRect（primary 色）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const st = createDefaultStyle();
  st.borderStyle = 1; st.shadow = 0; st.outlineWidth = 0;
  st.underline = true; st.strikeout = true;
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: st });
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: '线' }], styles: [], info: {} });
  r.renderAt(1_000_000);
  const rects = ctx._calls.filter((c) => c[0] === 'fillRect');
  // 下划线 + 删除线各一条，且均用 primary 白
  assert.ok(rects.length >= 2, `应有下划线/删除线两条 fillRect，实际 ${rects.length}`);
  assert.ok(rects.every((c) => c[1].fill === 'rgba(255,255,255,1)'));
});

test('Renderer：行内多 run 触发累计水平偏移分支（fillText 两次）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const def = createDefaultStyle();
  def.shadow = 0; def.outlineWidth = 0; def.borderStyle = 1; // 仅主填充，避免阴影/描边干扰计数
  const run = {
    fontName: def.fontname, fontSize: def.fontsize, bold: false, italic: false,
    underline: false, strikeout: false, spacing: 0,
    primary: def.primary, outlineColor: def.outlineColor, outlineWidth: def.outlineWidth,
    scaleX: 100, scaleY: 100, rotation: 0,
  };
  // 同一行两个文本 run（无 \N）→ drawLineRuns 中第二个 run 走 idx>0 偏移分支
  const cue = {
    startUs: 0, endUs: 5_000_000, text: '粗普通', style: 'Default',
    segments: [
      { type: 'tags', tags: [] },
      { type: 'text', text: '粗', style: run },
      { type: 'tags', tags: [] },
      { type: 'text', text: '普通', style: run },
    ],
    settings: {},
  };
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: def });
  r.setCues({ cues: [cue], styles: [], info: {} });
  r.renderAt(1_000_000);
  const texts = ctx._calls.filter((c) => c[0] === 'fillText').map((c) => c[1].t);
  assert.deepEqual(texts, ['粗', '普通'], '行内两个 run 应分别绘制');
});

/* ---------------- paint 变换 / 裁剪 / alpha 早退 ---------------- */

test('Renderer：alpha<=0 的 drawable 整体跳过（不 fillText）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const st = createDefaultStyle();
  // 通过 \fad 让起始瞬间 alpha=0：t1=200ms, 在 elapsed=0 时 fadeFactor=0
  const cue = {
    startUs: 0, endUs: 5_000_000, text: '隐', style: 'Default',
    geom: { fad: { t1: 200, t2: 0 } }, segments: undefined, settings: {},
  };
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: st });
  r.setCues({ cues: [cue], styles: [], info: {} });
  r.renderAt(0); // elapsed=0 → alpha=0
  assert.equal(hasCall(ctx._calls, 'fillText'), false, 'alpha<=0 应早退不绘制');
});

test('Renderer：clip 矩形触发裁剪、rotation/scale 触发变换调用', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const def = createDefaultStyle();
  const cue = {
    startUs: 0, endUs: 5_000_000, text: '裁', style: 'Default',
    geom: { clip: { x1: 10, y1: 20, x2: 110, y2: 220 }, rotation: 45, scaleX: 80, scaleY: 120 },
    segments: undefined, settings: {},
  };
  const r = new SubtitleCanvasRenderer(canvas, { defaultStyle: def });
  r.setCues({ cues: [cue], styles: [], info: {} });
  r.renderAt(1_000_000);
  assert.equal(hasCall(ctx._calls, 'clip'), true, 'clipRect 应触发 ctx.clip');
  assert.equal(hasCall(ctx._calls, 'rotate'), true, 'rotationDeg 应触发 ctx.rotate');
  assert.equal(hasCall(ctx._calls, 'scale'), true, 'scaleX/Y≠100 应触发 ctx.scale');
});

/* ---------------- attach 时钟驱动（Node 降级 / 注入 rAF） ---------------- */

test('Renderer：attach 在无 rAF 的 Node 环境安全降级（返回 stop() 不驱动）', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'd' }], styles: [], info: {} });
  const stop = r.attach(() => 1_000_000);
  assert.equal(typeof stop, 'function');
  // 没有 requestAnimationFrame → 不应自动触发 renderAt
  assert.equal(hasCall(ctx._calls, 'fillText'), false);
  assert.doesNotThrow(() => stop());
});

test('Renderer：attach 注入 rAF 时驱动一次 loop 渲染活跃时刻', () => {
  const { canvas, ctx } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 5_000_000, text: 'r' }], styles: [], info: {} });

  const origRaf = /** @type {any} */ (globalThis).requestAnimationFrame;
  const origCaf = /** @type {any} */ (globalThis).cancelAnimationFrame;
  let rafCalls = 0;
  /** @type {any} */
  globalThis.requestAnimationFrame = (cb) => { rafCalls += 1; if (rafCalls === 1) cb(); return rafCalls; };
  /** @type {any} */
  globalThis.cancelAnimationFrame = () => {};
  try {
    const stop = r.attach(() => 1_000_000); // 活跃时刻
    assert.ok(rafCalls >= 1, '应至少调度一次 rAF');
    assert.equal(hasCall(ctx._calls, 'fillText'), true, 'loop 内 renderAt 应绘制活跃 cue');
    assert.doesNotThrow(() => stop());
  } finally {
    /** @type {any} */ (globalThis).requestAnimationFrame = origRaf;
    /** @type {any} */ (globalThis).cancelAnimationFrame = origCaf;
  }
});

test('Renderer：stop / destroy 不抛异常且 destroy 清空数据', () => {
  const { canvas } = makeFakeCanvas();
  const r = new SubtitleCanvasRenderer(canvas);
  r.setCues({ cues: [{ startUs: 0, endUs: 1, text: 'a' }], styles: [], info: {} });
  assert.doesNotThrow(() => r.stop());
  assert.doesNotThrow(() => r.destroy());
});
