/**
 * subtitle 布局面敌意 cue 序列回归（第二百一十五波）
 * ------------------------------------------------------------
 * 文本 fuzz（212 波）之后的几何求解面：layoutEvents 与七个纯函数直面对
 * 重叠风暴、负时长、超大量活跃、敌意 settings/字符串 Margin、非法规则锚点。
 * 本波修复三处：
 *   1. layoutEvents 堆叠数钳制 MAX_STACK_EVENTS=512——O(n²) 贪心堆叠在
 *      5 万条同刻活跃时单次 4s+（敌意字幕文件冻帧面），超限部分照常绘制
 *      不堆叠，5 万条收敛至 <100ms；
 *   2. tags \pos/\org 数值守卫——正则只锁字符集，'..'/'9'×400 能过匹配但
 *      parseFloat 出 NaN/Infinity 泄漏几何（move/clip 已有 isFinite，对齐）；
 *   3. buildOne settings.mL/mR/mV 有限数守卫——ASS Margin 为原样字符串，
 *      Number('Infinity') 过 >0 判定后把 rect.y 推到 -Infinity。
 * 登记观察（非缺陷）：程序化直传非有限 cue.geom 字段泄漏属调用方责任
 * （212 波数组面先例；外部文件路径已在 tags 层封堵）。
 * 探测 .tmp/probe-subtitle-layout.mjs 575 调用后固化。
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  layoutEvents, MAX_STACK_EVENTS, anToAnchor, anchorToXY, fadeFactor,
  resolveMove, wrapSegments, resolveCollisions, approximateMeasure,
} from '../src/layout.js';
import { TagState } from '../src/tags.js';
import { createDefaultStyle } from '../src/style.js';
import { parseSrt } from '../src/srt.js';
import { parseAss } from '../src/ass.js';

const ctx = { playRes: { w: 640, h: 360 } };
const mkCue = (start, end, extra = {}) => ({
  startUs: start, endUs: end, text: extra.text ?? 'x', layer: extra.layer ?? 0, ...extra,
});

/* seeded xorshift：跨运行确定 */
let seed = 0xb0a2;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const randInt = (n) => Math.floor(rand() * n);

test('DoS 面：5 万条同刻活跃 layoutEvents 限时收敛（堆叠钳制回归）', () => {
  const N = 50000;
  const cues = Array.from({ length: N }, () => mkCue(0, 10 ** 9));
  const t0 = Date.now();
  const d = layoutEvents(cues, 500, ctx);
  const ms = Date.now() - t0;
  assert.equal(d.length, N);
  assert.ok(ms < 2000, `layoutEvents(${N}) 耗时 ${ms}ms，O(n²) 钳制失效`);
  // 钳制行为：前 MAX_STACK_EVENTS 条参与堆叠（y 严格互异），超限部分保持原位
  const ys = d.map((x) => x.rect.y);
  assert.notEqual(ys[0], ys[MAX_STACK_EVENTS - 1], '512 条内应已堆叠分离');
  assert.equal(ys[MAX_STACK_EVENTS], ys[N - 1], '超限条应不参与堆叠（同 y）');
});

test('tags 入口守卫：\\pos/\\org 敌意数字串不产几何，合法值照常', () => {
  const hostile = ['(..,5)', `(${'9'.repeat(400)},5)`, '(1e400,2)', '(5,1e400)'];
  for (const arg of hostile) {
    const t = new TagState(createDefaultStyle());
    t.apply({ name: 'pos', arg: `(${arg.slice(1, -1)})` });
    t.apply({ name: 'org', arg: `(${arg.slice(1, -1)})` });
    assert.equal(t.pos, null, `\\pos${arg} 不应产出几何`);
    assert.equal(t.org, null, `\\org${arg} 不应产出几何`);
  }
  const ok = new TagState(createDefaultStyle());
  ok.apply({ name: 'pos', arg: '(320,50)' });
  ok.apply({ name: 'org', arg: '(10,20)' });
  assert.deepEqual(ok.pos, { x: 320, y: 50 });
  assert.deepEqual(ok.org, { x: 10, y: 20 });
});

test('settings Margin 字符串面：Infinity/垃圾串不推爆 rect.y', () => {
  for (const mv of ['Infinity', '-Infinity', '9e999', 'NaN', '', 'abc']) {
    const d = layoutEvents(
      [mkCue(0, 10 ** 9, { settings: { mL: mv, mR: mv, mV: mv } })], 500, ctx);
    assert.ok(Number.isFinite(d[0].rect.y), `mV=${JSON.stringify(mv)} → rect.y=${d[0].rect.y}`);
    assert.ok(Number.isFinite(d[0].rect.x), `mL=${JSON.stringify(mv)} → rect.x=${d[0].rect.x}`);
  }
});

test('纯函数敌意表：anToAnchor 恒合法、fade 恒 [0,1]、move/anchor 不裸抛', () => {
  const NUMS = [NaN, -1, 0, 5.5, 99, -30, Infinity, -Infinity, 1e308];
  for (const v of NUMS) {
    const a = anToAnchor(v);
    assert.ok(['left', 'center', 'right'].includes(a.h), `anToAnchor(${v}).h=${a.h}`);
    assert.ok(['top', 'middle', 'bottom'].includes(a.v), `anToAnchor(${v}).v=${a.v}`);
    for (const t of NUMS) {
      const alpha = fadeFactor({ t1: v, t2: v }, t, t);
      assert.ok(alpha >= 0 && alpha <= 1, `fadeFactor(v=${v}, t=${t}) = ${alpha}`);
    }
    const xy = anchorToXY(a, { w: v, h: v }, { l: v, r: v, v });
    assert.ok(typeof xy.x === 'number' && typeof xy.y === 'number');
    const p = resolveMove({ x1: 0, y1: 0, x2: 10, y2: 10, t1: v, t2: v }, v, v);
    assert.ok(typeof p.x === 'number' && typeof p.y === 'number');
  }
  // approximateMeasure：非负、不抛
  for (const text of ['', 'x'.repeat(10000), '中'.repeat(2000)]) {
    for (const fs of [0, -10, NaN, Infinity]) {
      const w = approximateMeasure(text, { fontSize: fs, spacing: NaN });
      assert.ok(typeof w === 'number');
      if (Number.isFinite(w)) assert.ok(w >= 0, `measure 负值 ${w}`);
    }
  }
  // wrapSegments：maxWidth 敌意仍恒有行
  const segs = [
    { type: 'text', text: 'a'.repeat(2000), style: { fontSize: 12, spacing: 0 } },
    { type: 'tag', style: {} },
    { type: 'text', text: '中\n\nx', style: { fontSize: 12, spacing: 0 } },
  ];
  for (const mw of [0, -1, NaN, Infinity, 40]) {
    const lines = wrapSegments(segs, mw, approximateMeasure);
    assert.ok(Array.isArray(lines) && lines.length > 0, `wrap mw=${mw}`);
  }
  // resolveCollisions：敌意矩形/gap 不裸抛不死循环
  const t0 = Date.now();
  resolveCollisions([
    { rect: { x: NaN, y: 0, w: 10, h: 10 } },
    { rect: { x: 0, y: 0, w: -5, h: -5 } },
    { rect: { x: 0, y: 1e308, w: 1e308, h: 1e308 } },
    { rect: { x: 0, y: 0, w: 10, h: 10 } },
  ]);
  for (const gap of [NaN, -1e9, Infinity]) {
    resolveCollisions(
      [{ rect: { x: 0, y: 0, w: 1, h: 1 } }, { rect: { x: 0, y: 0, w: 1, h: 1 } }], gap);
  }
  assert.ok(Date.now() - t0 < 1000);
});

test('seeded 混合活跃序列 fuzz：负时长/乱序/重叠穿插恒收敛', () => {
  let total = 0;
  for (let r = 0; r < 400; r++) {
    const N = 1 + randInt(60);
    const cues = Array.from({ length: N }, () => mkCue(
      randInt(5) === 0 ? -randInt(1000) : randInt(10 ** 6),
      randInt(10 ** 6),
      { layer: randInt(5) - 2, text: 'x'.repeat(randInt(50)) },
    ));
    const d = layoutEvents(cues, randInt(10 ** 6), ctx);
    total += d.length;
    for (const dr of d) {
      assert.ok(dr.alpha >= 0 && dr.alpha <= 1, `alpha=${dr.alpha}`);
      assert.ok(Number.isFinite(dr.rect.y), `rect.y=${dr.rect.y}`);
      assert.ok(Number.isFinite(dr.rect.x), `rect.x=${dr.rect.x}`);
      assert.ok(['top', 'middle', 'alphabetic'].includes(dr.baseline));
    }
  }
  assert.ok(total > 0, '400 轮零输出说明探测面失效');
});

test('正例锚点：真实 srt 重叠堆叠分离 + ass fixture 全链不抛', () => {
  const srt = parseSrt(
    '1\n00:00:00,000 --> 00:00:05,000\nFirst line\n\n2\n00:00:00,500 --> 00:00:05,000\nSecond cue');
  const d = layoutEvents(srt.cues, 1000000, ctx);
  assert.equal(d.length, 2);
  assert.notEqual(d[0].rect.y, d[1].rect.y, '重叠事件应被堆叠分离');

  const ass = parseAss(readFileSync(
    new URL('../__tests__/fixtures/sample-styled.ass', import.meta.url), 'utf8'));
  assert.ok(ass.cues.length > 0);
  const da = layoutEvents(ass.cues, ass.cues[0].startUs, {
    playRes: { w: 384, h: 288 }, styles: ass.styles,
  });
  assert.ok(da.length > 0);
  for (const dr of da) assert.ok(Number.isFinite(dr.rect.y));
});
