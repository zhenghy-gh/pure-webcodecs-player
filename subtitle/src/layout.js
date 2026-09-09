/**
 * subtitle/src/layout.js — 排版求解器（纯函数，无 DOM，可在 Node 断言）
 *
 * 职责：给定某时刻的活跃 Cue 集合 + ASS 样式上下文 + PlayRes 坐标系，
 * 求出每个事件的完整绘制几何（锚点、坐标、变换、透明度、裁剪、碰撞避让）。
 * 输出全部使用 **PlayRes 逻辑坐标**；像素缩放由渲染器统一执行。
 *
 * 简化模型（PRD §3.10 允许）：贪心折行（CJK 可任意断行、西文按整段处理）；
 * 碰撞采用「自下而上堆叠」简化模型，仅作用于未显式定位（\pos/\move）的事件。
 */

import { findActiveCues } from './cue.js';
import { createDefaultStyle } from './style.js';

/** @typedef {import('./cue.js').Cue} Cue */
/** @typedef {import('./style.js').AssStyle} AssStyle */
/** @typedef {import('./tags.js').Segment} Segment */

/**
 * 近似测宽器：CJK/全角字符计 1em，其余计 0.5em，另加字间距。
 * 确定性好（供单测数值断言）；渲染器可注入真实 canvas measureText。
 * @param {string} text 单行文本
 * @param {{fontSize:number, spacing:number}} font 字号与字间距（逻辑单位）
 * @returns {number} 宽度（逻辑单位）
 */
export function approximateMeasure(text, font) {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd);
    units += wide ? 1 : 0.5;
  }
  return units * font.fontSize + Math.max(0, [...text].length - 1) * (font.spacing ?? 0);
}

/**
 * 九宫锚点数字（numpad 1-9）→ 锚点描述。
 * 1=左下 2=中下 3=右下 / 4=左中 5=居中 6=右中 / 7=左上 8=中上 9=右上
 * @param {number} an
 * @returns {{h:'left'|'center'|'right', v:'top'|'middle'|'bottom'}}
 */
export function anToAnchor(an) {
  const n = Math.min(9, Math.max(1, Math.round(an)));
  return {
    h: /** @type {'left'|'center'|'right'} */ (n % 3 === 1 ? 'left' : n % 3 === 2 ? 'center' : 'right'),
    v: /** @type {'top'|'middle'|'bottom'} */ (n <= 3 ? 'bottom' : n <= 6 ? 'middle' : 'top'),
  };
}

/**
 * 锚点 → PlayRes 参考点坐标。
 * left→marginL / center→w/2 / right→w-marginR；top→marginV / middle→h/2 / bottom→h-marginV。
 * @param {{h:string,v:string}} anchor
 * @param {{w:number,h:number}} res
 * @param {{l:number,r:number,v:number}} margins
 */
export function anchorToXY(anchor, res, margins) {
  const x = anchor.h === 'left' ? margins.l : anchor.h === 'right' ? res.w - margins.r : res.w / 2;
  const y = anchor.v === 'top' ? margins.v : anchor.v === 'middle' ? res.h / 2 : res.h - margins.v;
  return { x, y };
}

/**
 * \fad(t1,t2) 渐入渐出包络（ASS 参数为毫秒）。
 * @param {{t1:number,t2:number}|null} fad
 * @param {number} elapsedUs 相对本事件起点的已流逝时间
 * @param {number} durUs 本事件总显示时长
 * @returns {number} 0~1 不透明度系数
 */
export function fadeFactor(fad, elapsedUs, durUs) {
  if (!fad || durUs <= 0) return 1;
  const t1 = Math.max(0, fad.t1) * 1000;
  const t2 = Math.max(0, fad.t2) * 1000;
  const remain = durUs - elapsedUs;
  let a = 1;
  if (t1 > 0 && elapsedUs < t1) a *= elapsedUs / t1;
  if (t2 > 0 && remain < t2) a *= Math.max(0, remain) / t2;
  return Math.min(1, Math.max(0, a));
}

/**
 * \move(x1,y1,x2,y2[,t1,t2]) 位置插值。t1/t2 缺省（或同为 0）表示全程匀速移动。
 * @param {{x1:number,y1:number,x2:number,y2:number,t1:number,t2:number}} move
 * @param {number} elapsedUs
 * @param {number} durUs
 * @returns {{x:number,y:number}}
 */
export function resolveMove(move, elapsedUs, durUs) {
  const t1 = Math.max(0, move.t1) * 1000;
  const t2 = Math.max(0, move.t2) * 1000;
  let p;
  if (move.t1 <= 0 && move.t2 <= 0) {
    p = durUs > 0 ? Math.min(1, Math.max(0, elapsedUs / durUs)) : 0;
  } else {
    const span = Math.max(1, t2 - t1);
    p = Math.min(1, Math.max(0, (elapsedUs - t1) / span));
  }
  return { x: move.x1 + (move.x2 - move.x1) * p, y: move.y1 + (move.y2 - move.y1) * p };
}

/**
 * 把片段序列按硬换行(\N)拆行后做贪心折行。
 * @param {Segment[]} segments 词法片段（text/tags 交替）
 * @param {number} maxWidth 最大行宽（逻辑单位）
 * @param {(text:string, font:any)=>number} measure 测宽函数
 * @returns {Array<{runs:Segment[], width:number}>} 行列表（每行为片段子序列）
 */
export function wrapSegments(segments, maxWidth, measure) {
  /** @type {Array<{runs:Segment[], width:number}>} */
  const lines = [];
  /** @type {Segment[]} */
  let curRuns = [];
  let curWidth = 0;
  const flush = () => {
    if (curRuns.length) lines.push({ runs: curRuns, width: curWidth });
    curRuns = [];
    curWidth = 0;
  };

  for (const seg of segments) {
    if (seg.type !== 'text') { curRuns.push(seg); continue; }
    const st = seg.style;
    const hardLines = seg.text.split('\n');
    for (let hi = 0; hi < hardLines.length; hi++) {
      if (hi > 0) flush(); // \N 强制换行
      const text = hardLines[hi];
      if (text === '') continue;
      const w = measure(text, { fontSize: st.fontSize, spacing: st.spacing });
      if (curWidth === 0 || curWidth + w <= maxWidth) {
        curRuns.push({ type: 'text', text, style: st });
        curWidth += w;
      } else {
        flush();
        curRuns.push({ type: 'text', text, style: st });
        curWidth = w;
      }
    }
  }
  flush();
  return lines.length ? lines : [{ runs: [], width: 0 }];
}

/**
 * 简化碰撞模型：按给定顺序自下而上堆叠——与已放置矩形相交则上移到刚好不相交处。
 * rect.y 为盒子顶边（内部约定），函数原位修改。
 * @param {Array<{rect:{x:number,y:number,w:number,h:number}}>} items
 * @param {number} [gap=4] 堆叠间隙
 */
export function resolveCollisions(items, gap = 4) {
  /** @type {Array<{x:number,y:number,w:number,h:number}>} */
  const placed = [];
  for (const it of items) {
    const r = it.rect;
    for (const p of placed) {
      const overlapX = r.x < p.x + p.w && p.x < r.x + r.w;
      const overlapY = r.y < p.y + p.h && p.y < r.y + r.h;
      if (overlapX && overlapY) r.y = p.y - r.h - gap;
    }
    placed.push(r);
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} LayoutContext
 * @property {AssStyle[]} [styles]                样式表（ASS）
 * @property {AssStyle} [defaultStyle]            SRT/VTT 兜底样式
 * @property {{w:number,h:number}} playRes        逻辑画布尺寸
 * @property {(text:string, font:any)=>number} [measure] 测宽器（默认近似值）
 *
 * @typedef {Object} Drawable 单事件绘制几何（PlayRes 逻辑坐标）
 * @property {number} layer         层号（大者在上）
 * @property {'left'|'center'|'right'} alignH  canvas textAlign 映射
 * @property {'top'|'middle'|'alphabetic'} baseline canvas textBaseline 映射
 * @property {number} x             绘制参考 X（配合 alignH）
 * @property {number} y             首行基线 Y（alphabetic 时直接可用）
 * @property {{x:number,y:number,w:number,h:number}} rect 内容盒
 * @property {Array<{runs:Segment[], width:number}>} lines 折行结果
 * @property {number} lineHeight    行高
 * @property {number} fontSize      首行字号
 * @property {number} alpha         fade 包络后的不透明度系数（0~1）
 * @property {number} rotationDeg   \frz 度数
 * @property {number} scaleX        \fscx 百分比
 * @property {number} scaleY        \fscy 百分比
 * @property {{x:number,y:number}} pivot 旋转/缩放原点
 * @property {{x1:number,y1:number,x2:number,y2:number}|null} clipRect 矩形裁剪
 * @property {AssStyle} style       基准样式引用
 */

/**
 * 求解某时刻全部活跃事件的绘制几何。
 * @param {Cue[]} cues 全量 cue（内部过滤活跃并按 start 升序稳定排序）
 * @param {number} timeUs 当前时刻
 * @param {LayoutContext} ctx
 * @returns {Drawable[]} 按 layer 升序
 */
export function layoutEvents(cues, timeUs, ctx) {
  const active = findActiveCues(cues, timeUs)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.startUs - b.c.startUs) || ((a.c.layer ?? 0) - (b.c.layer ?? 0)) || (a.i - b.i))
    .map((x) => x.c);

  const built = active.map((cue) => buildOne(cue, ctx));

  // —— 碰撞：仅对无显式定位者做自下而上堆叠（先出现者占下层）——
  resolveCollisions(built.filter((b) => b.needsStack));

  return built.map((b) => finalize(b, timeUs)).sort((a, b) => a.layer - b.layer);
}

/** 内部：构建单个事件的静态几何（不含时刻相关量） */
function buildOne(cue, ctx) {
  const d = /** @type {any} */ (cue);
  const styles = ctx.styles ?? [];
  const style = styles.find((s) => s.name === d.style) ??
    styles[0] ?? ctx.defaultStyle ?? createDefaultStyle();
  const settings = d.settings ?? {};
  const mL = Number(settings.mL) > 0 ? Number(settings.mL) : style.marginL;
  const mR = Number(settings.mR) > 0 ? Number(settings.mR) : style.marginR;
  const mV = Number(settings.mV) > 0 ? Number(settings.mV) : style.marginV;

  const geom = d.geom ?? {};
  const anchor = anToAnchor(geom.an ?? style.alignment);

  // 显式定位优先级：\pos > \move(起点) > 锚点推算
  let refX;
  let refY;
  if (geom.pos) {
    refX = geom.pos.x; refY = geom.pos.y;
  } else if (geom.move) {
    refX = geom.move.x1; refY = geom.move.y1;
  } else {
    const xy = anchorToXY(anchor, ctx.playRes, { l: mL, r: mR, v: mV });
    refX = xy.x; refY = xy.y;
  }

  // 折行：最大宽度 = PlayRes 宽减左右留白；显式定位时放宽到整幅
  const measure = ctx.measure ?? approximateMeasure;
  const maxW = (geom.pos || geom.move) ? ctx.playRes.w : Math.max(40, ctx.playRes.w - mL - mR);
  const segments = d.segments?.length
    ? d.segments
    : [{ type: 'text', text: cue.text, style: snapshotFromStyle(style) }];
  const lines = wrapSegments(segments, maxW, measure);

  const fontSize = firstFontSize(lines) ?? style.fontsize;
  const lineHeight = fontSize * 1.25;
  const boxW = Math.max(1, ...lines.map((l) => l.width));
  const boxH = Math.max(lines.length, 1) * lineHeight;

  // 盒顶边：锚点垂直语义决定盒子相对参考点的位置
  const top = anchor.v === 'top' ? refY : anchor.v === 'middle' ? refY - boxH / 2 : refY - boxH;

  return {
    cue,
    style,
    anchor,
    lines,
    lineHeight,
    fontSize,
    boxW,
    boxH,
    rect: { x: boxLeft(refX, boxW, anchor.h), y: top, w: boxW, h: boxH },
    refX,
    refY,
    needsStack: !geom.pos && !geom.move,
    geom,
  };
}

/** 内部：按时刻完成插值/淡入淡出等最终几何 */
function finalize(b, timeUs) {
  const cue = b.cue;
  const geom = b.geom ?? {};
  const durUs = cue.endUs - cue.startUs;
  const elapsed = Math.max(0, Math.min(durUs, timeUs - cue.startUs));

  // \move 插值覆盖参考点，并同步盒位置
  if (geom.move) {
    const p = resolveMove(geom.move, elapsed, durUs);
    b.refX = p.x; b.refY = p.y;
    b.rect.x = boxLeft(p.x, b.boxW, b.anchor.h);
    b.rect.y = b.anchor.v === 'top' ? p.y : b.anchor.v === 'middle' ? p.y - b.boxH / 2 : p.y - b.boxH;
  }

  // 绘制参考坐标从盒子导出（与碰撞结果一致）
  const drawX = b.anchor.h === 'left' ? b.rect.x : b.anchor.h === 'right' ? b.rect.x + b.boxW : b.rect.x + b.boxW / 2;
  const descent = b.fontSize * 0.12; // alphabetic 基线下延近似
  const baseline = b.rect.y + b.lineHeight - descent;

  const pivot = geom.org ?? {
    x: b.rect.x + (b.anchor.h === 'right' ? b.boxW : b.anchor.h === 'center' ? b.boxW / 2 : 0),
    y: b.rect.y + b.boxH / 2,
  };

  return {
    layer: cue.layer ?? 0,
    alignH: b.anchor.h,
    baseline: b.anchor.v === 'top' ? 'top' : b.anchor.v === 'middle' ? 'middle' : 'alphabetic',
    x: drawX,
    y: baseline,
    rect: b.rect,
    lines: b.lines,
    lineHeight: b.lineHeight,
    fontSize: b.fontSize,
    alpha: fadeFactor(geom.fad ?? null, elapsed, durUs),
    rotationDeg: geom.rotation ?? b.style.angle,
    scaleX: geom.scaleX ?? b.style.scaleX,
    scaleY: geom.scaleY ?? b.style.scaleY,
    pivot,
    clipRect: geom.clip ? { x1: geom.clip.x1, y1: geom.clip.y1, x2: geom.clip.x2, y2: geom.clip.y2 } : null,
    style: b.style,
  };
}

/** 内部：盒子左边缘 X */
function boxLeft(x, w, h) {
  return h === 'left' ? x : h === 'right' ? x - w : x - w / 2;
}

/** 内部：取折行里首个文本片段字号 */
function firstFontSize(lines) {
  for (const line of lines) {
    for (const run of line.runs) {
      if (run.type === 'text') return run.style.fontSize;
    }
  }
  return undefined;
}

/** 内部：样式 → 片段样式快照（SRT/VTT 无标签时用） */
function snapshotFromStyle(style) {
  return {
    fontName: style.fontname,
    fontSize: style.fontsize,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikeout: style.strikeout,
    spacing: style.spacing,
    primary: style.primary,
    outlineColor: style.outlineColor,
    outlineWidth: style.outlineWidth,
    scaleX: style.scaleX,
    scaleY: style.scaleY,
    rotation: style.angle,
  };
}
