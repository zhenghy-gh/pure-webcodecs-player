/**
 * subtitle/src/renderer.js — Canvas 2D 字幕渲染器
 *
 * 职责：把 layoutEvents 求解出的几何绘制到 <canvas> 上，并提供
 * attach(clock) 按时间驱动（rAF 循环）。绘制全部在 PlayRes 逻辑坐标
 * 进行（整体 ctx.scale 到画布像素），保证与求解器数值一致。
 *
 * Node 环境：本文件顶部 import 不触碰 DOM；构造函数在无 Canvas 时抛
 * SubtitleError('STATE_ERROR')（调用方错误，非环境探测；契约 §11.3
 * 定稿码名，草案 INVALID_STATE 已废弃），并导出
 * isRendererSupported() 供能力探测。
 */

import { findActiveCues } from './cue.js';
import { createDefaultStyle } from './style.js';
import { rgbaToCss } from './style.js';
import { layoutEvents, approximateMeasure } from './layout.js';
import { SubtitleError, ErrorCode } from './errors.js';

/** @typedef {import('./cue.js').Cue} Cue */
/** @typedef {import('./style.js').AssStyle} AssStyle */
/** @typedef {import('./layout.js').Drawable} Drawable */

/**
 * 渲染器是否可用（浏览器且 canvas 可创建）。
 * @returns {boolean} Node 下恒 false
 */
export function isRendererSupported() {
  return typeof document !== 'undefined' &&
    typeof /** @type {any} */ (document).createElement === 'function' &&
    !!/** @type {any} */ (document).createElement('canvas').getContext;
}

/**
 * Canvas 字幕渲染器。
 *
 * 用法一（手动驱动）：`r.setCues(result); r.renderAt(us);`
 * 用法二（时钟驱动）：`const stop = r.attach(videoEl); … stop();`
 */
export class SubtitleCanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas 目标画布
   * @param {{defaultStyle?: AssStyle, playRes?: {w:number,h:number}}} [options]
   */
  constructor(canvas, options = {}) {
    const ok = typeof canvas === 'object' && canvas !== null &&
      typeof (/** @type {any} */ (canvas).getContext) === 'function';
    if (!ok) {
      throw new SubtitleError(ErrorCode.STATE_ERROR, 'SubtitleCanvasRenderer 需要 <canvas> 元素（Node 环境不可用）');
    }
    /** @private 2D 上下文 */
    this.#ctx = /** @type {CanvasRenderingContext2D} */ (
      /** @type {any} */ (canvas).getContext('2d')
    );
    if (!this.#ctx) {
      throw new SubtitleError('NOT_SUPPORTED', '当前环境不支持 Canvas 2D 上下文');
    }
    /** @readonly 目标画布 */
    this.canvas = /** @type {any} */ (canvas);
    this.#defaultStyle = options.defaultStyle ?? createDefaultStyle();
    this.#playResFallback = options.playRes ?? { w: 640, h: 360 };
    /** @type {Cue[]} */
    this.#cues = [];
    /** @type {AssStyle[]} */
    this.#styles = [];
    this.#info = {};
    this.#rafId = 0;
    this.#detachClock = null;
  }

  /** @private @type {CanvasRenderingContext2D} */
  #ctx;
  /** @private @type {AssStyle} */
  #defaultStyle;
  /** @private @type {{w:number,h:number}} */
  #playResFallback;
  /** @private @type {Cue[]} */
  #cues;
  /** @private @type {AssStyle[]} */
  #styles;
  /** @private @type {{playResX?:number, playResY?:number}} */
  #info;
  /** @private @type {number} */
  #rafId;
  /** @private @type {null | (() => void)} */
  #detachClock;

  /**
   * 装载解析结果（parseSrt/parseVtt/parseAss 的返回值均可）。
   * @param {{cues: Cue[], styles?: AssStyle[], info?: {playResX?:number, playResY?:number}}} parsed
   */
  setCues(parsed) {
    this.#cues = parsed?.cues ?? [];
    this.#styles = parsed?.styles ?? [];
    this.#info = parsed?.info ?? {};
  }

  /** 清空已装载的字幕 */
  clear() {
    this.#cues = [];
    this.#styles = [];
    this.#info = {};
  }

  /**
   * 渲染指定时刻（整数微秒）。重复调用安全：每次先清画布。
   * @param {number} timeUs
   */
  renderAt(timeUs) {
    const cv = this.canvas;
    const w = cv.width || 1;
    const h = cv.height || 1;
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.#cues.length) return;

    const res = {
      w: this.#info.playResX || this.#playResFallback.w,
      h: this.#info.playResY || this.#playResFallback.h,
    };
    // 真实测宽器：借用同一 2D 上下文按逻辑字号测量后除以缩放系数
    const sx = w / res.w;
    const sy = h / res.h;
    /** @type {(text:string, font:any)=>number} */
    const measure = (text, font) => {
      ctx.save();
      ctx.font = fontString(font.fontSize, font);
      const width = ctx.measureText(text).width / ((sx + sy) / 2);
      ctx.restore();
      return Number.isFinite(width) && width > 0 ? width : approximateMeasure(text, font);
    };

    const drawables = layoutEvents(this.#cues, timeUs, {
      styles: this.#styles,
      defaultStyle: this.#defaultStyle,
      playRes: res,
      measure,
    });

    ctx.save();
    ctx.scale(sx, sy); // 之后一切绘制使用 PlayRes 逻辑单位
    for (const d of drawables) paint(ctx, d);
    ctx.restore();
  }

  /**
   * 绑定时钟源自动驱动渲染。
   * @param {HTMLVideoElement | (() => number) | {currentTimeUs: () => number}} clock
   *        <video> 元素 / 返回微秒的函数 / 带 currentTimeUs() 的对象
   * @returns {() => void} 停止驱动函数
   */
  attach(clock) {
    this.stop();
    /** @returns {number} 当前时刻（µs） */
    const readUs = () => {
      if (typeof clock === 'function') return clock();
      if (typeof /** @type {any} */ (clock)?.currentTimeUs === 'function') {
        return /** @type {any} */ (clock).currentTimeUs();
      }
      const v = /** @type {HTMLVideoElement} */ (clock);
      return Math.round((v?.currentTime ?? 0) * 1e6);
    };
    const loop = () => {
      this.renderAt(readUs());
      this.#rafId = /** @type {any} */ (globalThis).requestAnimationFrame(loop);
    };
    // Node 环境无 rAF：安全降级为不驱动（契约 §0.3，不抛异常）
    if (typeof globalThis.requestAnimationFrame !== 'function') return () => {};
    this.#rafId = /** @type {any} */ (globalThis).requestAnimationFrame(loop);
    this.#detachClock = () => this.stop();
    return () => this.stop();
  }

  /** 停止自动驱动 */
  stop() {
    if (this.#rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.#rafId);
    }
    this.#rafId = 0;
  }

  /** 释放（停止驱动并清空数据；不销毁外部画布） */
  destroy() {
    this.stop();
    this.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 绘制细节
 * ------------------------------------------------------------------ */

/** 由样式快照拼 CSS font 字符串 */
function fontString(sizePx, st) {
  const italic = st.italic ? 'italic ' : '';
  const weight = st.bold ? '700' : '400';
  return `${italic}${weight} ${sizePx}px "${st.fontName}", sans-serif`;
}

/** 单个 drawable 的完整绘制（含变换/裁剪/描边/阴影/底框/下划线删除线） */
function paint(ctx, d) {
  if (d.alpha <= 0) return;
  ctx.save();

  // 矩形裁剪 \clip(x1,y1,x2,y2)
  if (d.clipRect) {
    ctx.beginPath();
    ctx.rect(d.clipRect.x1, d.clipRect.y1,
      d.clipRect.x2 - d.clipRect.x1, d.clipRect.y2 - d.clipRect.y1);
    ctx.clip();
  }

  // 旋转与轴缩放：围绕 pivot（\org 或锚点缺省）
  ctx.translate(d.pivot.x, d.pivot.y);
  if (d.rotationDeg) ctx.rotate((d.rotationDeg * Math.PI) / 180);
  if (d.scaleX !== 100 || d.scaleY !== 100) ctx.scale(d.scaleX / 100, d.scaleY / 100);
  ctx.translate(-d.pivot.x, -d.pivot.y);

  ctx.textAlign = /** @type {any} */ (d.alignH);
  ctx.textBaseline = /** @type {any} */ (d.baseline);
  const style = d.style;

  let lineY = d.y;
  for (let li = 0; li < d.lines.length; li++) {
    const line = d.lines[li];
    drawLineRuns(ctx, d, line.runs, lineY, d.alpha, style);
    lineY += d.lineHeight;
  }
  ctx.restore();
}

/** 绘制一行内的多个样式片段 */
function drawLineRuns(ctx, d, runs, y, alpha, baseStyle) {
  for (const run of runs) {
    if (run.type !== 'text') continue; // tags 片段无可见内容
    const st = run.style;
    ctx.font = fontString(st.fontSize, st);

    // 行内水平定位：left 从盒左起排，center/right 需要累计偏移
    let x = d.x;
    const idx = runs.indexOf(run);
    if (idx > 0) {
      // 同一行前序片段宽度累计（近似测宽即可满足演示精度）
      x += runs.slice(0, idx)
        .filter((r) => r.type === 'text')
        .reduce((acc, r) => acc + ctx.measureText(/** @type {any} */ (r).text).width +
          (/** @type {any} */ (r).style.spacing ?? 0), 0);
    }

    ctx.globalAlpha = alpha * (st.primary.alpha ?? 1);

    // BorderStyle 3：先画整行底框
    if ((baseStyle.borderStyle ?? 1) === 3) {
      const w = ctx.measureText(run.text).width;
      ctx.fillStyle = rgbaToCss(baseStyle.back);
      ctx.fillRect(x - 4, y - st.fontSize * 0.95, w + 8, st.fontSize * 1.25);
    } else if (baseStyle.shadow > 0) {
      // 阴影层（偏移 shadow px）
      ctx.fillStyle = rgbaToCss(baseStyle.back);
      ctx.fillText(run.text, x + baseStyle.shadow, y + baseStyle.shadow);
    }

    // 描边层
    if ((st.outlineWidth ?? baseStyle.outline) > 0 && baseStyle.borderStyle !== 3) {
      ctx.lineWidth = (st.outlineWidth ?? baseStyle.outline) * 2; // 外扩 outline px
      ctx.lineJoin = 'round';
      ctx.strokeStyle = rgbaToCss(st.outlineColor);
      ctx.strokeText(run.text, x, y);
    }

    // 主填充
    ctx.fillStyle = rgbaToCss(st.primary);
    ctx.fillText(run.text, x, y);

    // 下划线 / 删除线
    const tw = ctx.measureText(run.text).width;
    if (st.underline) {
      ctx.fillStyle = rgbaToCss(st.primary);
      ctx.fillRect(x, y + st.fontSize * 0.12, tw, Math.max(1, st.fontSize / 16));
    }
    if (st.strikeout) {
      ctx.fillStyle = rgbaToCss(st.primary);
      ctx.fillRect(x, y - st.fontSize * 0.3, tw, Math.max(1, st.fontSize / 16));
    }
    ctx.globalAlpha = 1;
  }
}
