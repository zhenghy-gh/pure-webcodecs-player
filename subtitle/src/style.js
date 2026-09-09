/**
 * subtitle/src/style.js — ASS 样式基础件：颜色解析 / 九宫锚点 / 默认样式
 *
 * ASS 颜色约定：&HAABBGGRR（小端序！BB=蓝 GG=绿 RR=红；AA 为透明度，
 * 00=不透明，FF=全透明）。本模块统一转成 {r,g,b,alpha}，其中
 * alpha ∈ [0,1] 为 CSS 语义的不透明度（与 ASS 的 AA 相反）。
 */

import { SubtitleError } from './errors.js';

/** @typedef {{r:number,g:number,b:number,alpha:number}} RgbaColor CSS 语义 RGBA（alpha 0~1 不透明度） */

/**
 * 解析 ASS 颜色字面量。支持：`&HAABBGGRR`、`&HBBGGRR`、可省略尾部 `&`、
 * 纯十进制数字（部分生成器会写十进制）。
 * @param {string|number} raw 颜色原文
 * @returns {RgbaColor}
 * @throws {SubtitleError} PARSE_ERROR——无法识别的字面量
 */
export function parseAssColor(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') throw new SubtitleError('PARSE_ERROR', '颜色值为空');
  if (/^\d+$/.test(s)) {
    // 十进制整数：按 BGR 排列的数值
    const n = Number.parseInt(s, 10);
    return { b: n & 0xff, g: (n >> 8) & 0xff, r: (n >> 16) & 0xff, alpha: 1 };
  }
  if (!/^&H[0-9a-fA-F]+&?$/i.test(s)) {
    throw new SubtitleError('PARSE_ERROR', `无法解析 ASS 颜色「${raw}」`);
  }
  const hex = s.slice(2).replace(/&$/, '').padStart(6, '0').slice(-8);
  // 从右往左：RR GG BB [AA]
  const rr = hex.slice(hex.length - 2, hex.length);
  const gg = hex.slice(hex.length - 4, hex.length - 2);
  const bb = hex.slice(hex.length - 6, hex.length - 4);
  const aa = hex.length >= 8 ? hex.slice(0, hex.length - 6) : '00';
  return {
    r: parseInt(rr, 16),
    g: parseInt(gg, 16),
    b: parseInt(bb, 16),
    alpha: 1 - parseInt(aa, 16) / 255, // AA=00 → alpha 1（不透明）
  };
}

/**
 * RGBA → CSS `rgba()` 字符串。
 * @param {RgbaColor} c
 * @returns {string}
 */
export function rgbaToCss(c) {
  return `rgba(${c.r},${c.g},${c.b},${Number(c.alpha.toFixed(3))})`;
}

/**
 * ASS 九宫锚点数字（numpad 1-9）→ 锚点描述。
 * 1=左下 2=中下 3=右下 / 4=左中 5=居中 6=右中 / 7=左上 8=中上 9=右上
 * @param {number} an 1~9
 * @returns {{h:'left'|'center'|'right', v:'top'|'middle'|'bottom'}}
 */
export function anToAnchor(an) {
  const n = Math.min(9, Math.max(1, Math.round(an)));
  const h = /** @type {const} */ ((n % 3 === 1) ? 'left' : (n % 3 === 2) ? 'center' : 'right');
  const v = /** @type {const} */ ((n <= 3) ? 'bottom' : (n <= 6) ? 'middle' : 'top');
  return { h, v };
}

/**
 * ASS Style 行的默认模板（libass 兼容缺省值）。
 * @returns {AssStyle}
 * @typedef {Object} AssStyle
 * @property {string} name
 * @property {string} fontname
 * @property {number} fontsize          PlayRes 坐标系下的字号
 * @property {RgbaColor} primary        主填充色
 * @property {RgbaColor} secondary      次色（卡拉OK用，本期仅保留）
 * @property {RgbaColor} outlineColor   描边颜色
 * @property {number} outlineWidth      描边宽 px
 * @property {RgbaColor} back           阴影/背景色
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} underline
 * @property {boolean} strikeout
 * @property {number} scaleX            \fscx 百分比
 * @property {number} scaleY            \fscy
 * @property {number} spacing           字间距（\fsp 同义，px）
 * @property {number} angle             \frz 度数
 * @property {number} borderStyle       1=描边+阴影 3=不透明底框
 * @property {number} shadow            阴影偏移 px
 * @property {number} alignment         numpad 1-9
 * @property {number} marginL
 * @property {number} marginR
 * @property {number} marginV
 */
export function createDefaultStyle(name = 'Default') {
  return {
    name,
    fontname: 'sans-serif',
    fontsize: 48,
    primary: { r: 255, g: 255, b: 255, alpha: 1 },
    secondary: { r: 255, g: 0, b: 0, alpha: 1 },
    outlineColor: { r: 0, g: 0, b: 0, alpha: 1 },
    back: { r: 0, g: 0, b: 0, alpha: 1 },
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    outlineWidth: 2,
    shadow: 2,
    alignment: 2,
    marginL: 10,
    marginR: 10,
    marginV: 10,
  };
}
