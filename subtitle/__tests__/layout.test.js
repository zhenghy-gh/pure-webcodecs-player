/**
 * subtitle/__tests__/layout.test.js — 排版求解器数值断言（纯函数，无 DOM）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anToAnchor, anchorToXY, fadeFactor, resolveMove,
  wrapSegments, resolveCollisions, layoutEvents, approximateMeasure,
  createDefaultStyle,
} from '../src/index.js';

const EPS = 1e-6;
/** 快照构造器（模拟 tags.js 的片段快照形状） */
function snap(over = {}) {
  const d = createDefaultStyle();
  return {
    fontName: d.fontname, fontSize: d.fontsize, bold: d.bold, italic: d.italic,
    underline: d.underline, strikeout: d.strikeout, spacing: d.spacing,
    primary: d.primary, outlineColor: d.outline, outlineWidth: d.outline,
    scaleX: d.scaleX, scaleY: d.scaleY, rotation: d.angle, ...over,
  };
}
function textSeg(text, over) { return { type: 'text', text, style: snap(over) }; }
const RES = { w: 640, h: 360 };

test('anToAnchor：九宫全表', () => {
  const want = [
    [1, 'left', 'bottom'], [2, 'center', 'bottom'], [3, 'right', 'bottom'],
    [4, 'left', 'middle'], [5, 'center', 'middle'], [6, 'right', 'middle'],
    [7, 'left', 'top'], [8, 'center', 'top'], [9, 'right', 'top'],
  ];
  for (const [n, h, v] of want) {
    assert.deepEqual(anToAnchor(n), { h, v });
  }
});

test('anchorToXY：底部居中默认位（marginV 生效）', () => {
  assert.deepEqual(anchorToXY({ h: 'center', v: 'bottom' }, RES, { l: 10, r: 10, v: 25 }),
    { x: 320, y: 335 });
});

test('anchorToXY：右上角', () => {
  assert.deepEqual(anchorToXY({ h: 'right', v: 'top' }, RES, { l: 10, r: 20, v: 5 }),
    { x: 620, y: 5 });
});

test('fadeFactor：\\fad 包络（渐入/平台/渐出）', () => {
  const fad = { t1: 200, t2: 300 }; // 毫秒
  const dur = 1_000_000;
  assert.equal(fadeFactor(fad, 0, dur), 0);
  assert.ok(Math.abs(fadeFactor(fad, 100_000, dur) - 0.5) < EPS); // 渐入一半
  assert.equal(fadeFactor(fad, 500_000, dur), 1);                  // 平台期
  assert.ok(Math.abs(fadeFactor(fad, 900_000, dur) - 100_000 / 300_000) < EPS);
});

test('resolveMove：全程匀速插值（t1=t2=0）', () => {
  const move = { x1: 100, y1: 300, x2: 500, y2: 100, t1: 0, t2: 0 };
  const dur = 2_000_000;
  assert.deepEqual(resolveMove(move, 0, dur), { x: 100, y: 300 });
  assert.deepEqual(resolveMove(move, 1_000_000, dur), { x: 300, y: 200 });
  assert.deepEqual(resolveMove(move, 2_000_000, dur), { x: 500, y: 100 });
});

test('resolveMove：窗口化时间参数，越界后停在终点', () => {
  const move = { x1: 0, y1: 0, x2: 100, y2: 50, t1: 500, t2: 1500 };
  const p = resolveMove(move, 999_999_999, 2_000_000);
  assert.deepEqual(p, { x: 100, y: 50 });
});

test('approximateMeasure：CJK 记 1em、ASCII 记 0.5em', () => {
  assert.equal(approximateMeasure('中中', { fontSize: 10, spacing: 0 }), 20);
  assert.equal(approximateMeasure('AB', { fontSize: 10, spacing: 0 }), 10);
});

test('wrapSegments：\\N 硬换行拆成两行', () => {
  const segs = [{ type: 'text', text: '甲\n乙', style: snap() }];
  const lines = wrapSegments(segs, 600, approximateMeasure);
  assert.equal(lines.length, 2);
});

test('wrapSegments：贪心折行在超宽时换行', () => {
  // fontSize 48：10 个 ASCII 字符宽 = 10*0.5*48 = 240
  const segs = [
    { type: 'text', text: 'ABCDEFGHIJ', style: snap() },
    { type: 'tags', tags: [] },
    { type: 'text', text: 'KLMNO', style: snap() },
  ];
  const lines = wrapSegments(segs, 260, approximateMeasure); // 240+120 > 260 → 折行
  assert.equal(lines.length, 2);
  assert.equal(lines[0].width, 240);
  assert.equal(lines[1].width, 120);
});

test('resolveCollisions：相交盒子上移到刚好不相交', () => {
  const a = { rect: { x: 100, y: 300, w: 200, h: 60 } };
  const b = { rect: { x: 150, y: 280, w: 200, h: 60 } }; // 与 a 相交
  resolveCollisions([a, b], 4);
  assert.equal(b.rect.y, a.rect.y - b.rect.h - 4);
  // 不相交校验
  const noY = b.rect.y + b.rect.h <= a.rect.y;
  assert.equal(noY, true);
});

/* ---------- layoutEvents 端到端几何 ---------- */

const CTX_BASE = () => ({
  styles: [],
  defaultStyle: createDefaultStyle(),
  playRes: { w: 640, h: 360 },
  measure: approximateMeasure,
});

test('layoutEvents：SRT 双 cue 重叠时自下而上堆叠', () => {
  const cues = [
    { startUs: 0, endUs: 5_000_000, text: '第一条长时间字幕' },
    { startUs: 1_000_000, endUs: 3_000_000, text: '第二条' },
  ];
  const out = layoutEvents(cues, 2_000_000, CTX_BASE());
  assert.equal(out.length, 2);
  assert.ok(out[1].rect.y < out[0].rect.y); // 后出现者被顶到上方
});

test('layoutEvents：无重叠的 SRT cue 停在默认底部位置', () => {
  const cues = [{ startUs: 0, endUs: 1_000_000, text: '唯一台词' }];
  const out = layoutEvents(cues, 500_000, CTX_BASE());
  assert.equal(out.length, 1);
  const d = out[0];
  assert.equal(d.alignH, 'center');
  assert.equal(d.baseline, 'alphabetic');
  assert.equal(d.x, 320);                       // 水平中心
  assert.ok(Math.abs((d.rect.y + d.rect.h) - 350) < EPS); // 盒底=360-marginV25... 默认 marginV=10 → 350
});

test('layoutEvents：\\pos 绝对定位坐标直通', () => {
  const cue = /** @type {any} */ ({
    startUs: 0, endUs: 2_000_000, text: '定',
    geom: { pos: { x: 320, y: 180 }, an: 5 },
    settings: {},
  });
  cue.segments = [textSeg('定')];
  const out = layoutEvents([cue], 1_000_000, CTX_BASE());
  const d = out[0];
  assert.ok(Math.abs(d.rect.x + d.rect.w / 2 - 320) < EPS); // 盒水平居中于 pos.x
  assert.ok(Math.abs(d.rect.y + d.rect.h / 2 - 180) < EPS); // 盒垂直居中于 pos.y
});

test('layoutEvents：\\move 在时刻中点取插值中点', () => {
  const cue = /** @type {any} */ ({
    startUs: 1_000_000, endUs: 3_000_000, text: '移',
    geom: { move: { x1: 100, y1: 300, x2: 500, y2: 100, t1: 0, t2: 0 } },
    settings: {},
  });
  cue.segments = [textSeg('移')];
  const out = layoutEvents([cue], 2_000_000, CTX_BASE()); // elapsed=1s → 插值中点
  const d = out[0];
  assert.ok(Math.abs(d.rect.x + d.rect.w / 2 - 300) < EPS);   // 水平中点 x=300
  assert.ok(Math.abs((d.rect.y + d.rect.h) - 200) < EPS);     // 底锚盒底对齐插值 y=200
});

test('layoutEvents：\\fad 端到端 alpha 衰减', () => {
  const cue = /** @type {any} */ ({
    startUs: 0, endUs: 1_000_000, text: '淡出',
    geom: { fad: { t1: 0, t2: 500 } }, // 结尾 500ms 渐出
    settings: {},
  });
  cue.segments = [textSeg('淡出')];
  const mid = layoutEvents([cue], 750_000, CTX_BASE())[0];   // 剩余 250ms / 500ms
  const nearEnd = layoutEvents([cue], 999_000, CTX_BASE())[0]; // 剩余 1ms
  assert.equal(mid.alpha, 0.5);
  assert.ok(nearEnd.alpha > 0 && nearEnd.alpha < 0.01);
});

test('layoutEvents：clip/frz/fscx/fscy 几何透传', () => {
  const cue = /** @type {any} */ ({
    startUs: 0, endUs: 1_000_000, text: '变',
    geom: { clip: { x1: 10, y1: 20, x2: 110, y2: 220 }, rotation: 45, scaleX: 80, scaleY: 120, org: { x: 320, y: 180 } },
    settings: {},
  });
  cue.segments = [textSeg('变')];
  const d = layoutEvents([cue], 500_000, CTX_BASE())[0];
  assert.deepEqual(d.clipRect, { x1: 10, y1: 20, x2: 110, y2: 220 });
  assert.equal(d.rotationDeg, 45);
  assert.equal(d.scaleX, 80);
  assert.equal(d.scaleY, 120);
  assert.deepEqual(d.pivot, { x: 320, y: 180 });
});

test('layoutEvents：按 layer 升序输出（大层号后绘制）', () => {
  const low = /** @type {any} */ ({ startUs: 0, endUs: 1_000_000, text: '底层', layer: 0, settings: {}, segments: [textSeg('底层')] });
  const high = /** @type {any} */ ({ startUs: 0, endUs: 1_000_000, text: '顶层', layer: 1, settings: {}, segments: [textSeg('顶层')] });
  const out = layoutEvents([high, low], 500_000, CTX_BASE());
  assert.deepEqual(out.map((d) => d.layer), [0, 1]);
});

test('layoutEvents：时刻无命中返回空数组', () => {
  const cues = [{ startUs: 10_000_000, endUs: 20_000_000, text: '未开始' }];
  assert.deepEqual(layoutEvents(cues, 0, CTX_BASE()), []);
});
