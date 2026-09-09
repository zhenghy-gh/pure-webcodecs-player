/**
 * subtitle/src/tags.js — ASS 覆盖标签（override tags）词法与状态机
 *
 * 白名单（PRD §3.10 本期承诺集）：
 *   字符样式：\b \i \u \s \fn \fs \fs+/- \fsp \c(\1c) \2c \3c \alpha
 *   定位变换：\pos \move \org \an \fad \fscx \fscy \frz
 *   矩形裁剪：\clip(矩形)
 * 白名单之外的标签一律进入「未支持清单」，不崩溃、不中断解析。
 */

import { parseAssColor } from './style.js';
import { createDefaultStyle } from './style.js';

/** @typedef {import('./style.js').RgbaColor} RgbaColor */
/** @typedef {import('./style.js').AssStyle} AssStyle */

/** 本期白名单集合（不含参数形态差异，如 \fad/\fade 归并处理） */
export const TAG_WHITELIST = new Set([
  'b', 'i', 'u', 's', 'fn', 'fs', 'fsp',
  'c', '1c', '2c', '3c', 'alpha',
  'pos', 'move', 'org', 'an', 'fad', 'fscx', 'fscy', 'frz', 'clip',
]);

/**
 * @typedef {Object} AssOverrideTag 单个覆盖标签
 * @property {string} name   标签名（小写）
 * @property {string} arg    参数原文（可空）
 * @property {boolean} supported 是否在白名单内
 *
 * @typedef {Object} TextRun 文本片段
 * @property {'text'} type
 * @property {string} text          显示文本（\N→\n，\h→nbsp）
 * @property {TagState} style       该片段生效的样式快照
 *
 * @typedef {Object} TagRun 标签段（纯标记，渲染时跳过）
 * @property {'tags'} type
 * @property {AssOverrideTag[]} tags
 *
 * @typedef {TextRun|TagRun} Segment
 */

/**
 * 标签状态机：从基准 Style 出发，按序应用标签，随时可快照。
 * 数值叠加语义：\fs+10 / \fs-5 相对当前字号；\fscx/fscy 为百分比直接量；
 * 颜色与 alpha 直接替换。定位类（pos/move/org/an/fad/clip）挂在事件级。
 */
export class TagState {
  /** @param {AssStyle} base 基准样式 */
  constructor(base) {
    const d = createDefaultStyle();
    const b = base ?? d;
    this.fontName = b.fontname;
    this.fontSize = b.fontsize;
    this.bold = b.bold; this.italic = b.italic; this.underline = b.underline; this.strikeout = b.strikeout;
    this.spacing = b.spacing;
    this.primary = b.primary;
    this.outlineColor = b.outlineColor;
    this.outlineWidth = b.outlineWidth;
    // 事件级字段（整条事件一个值，重复出现取最后一次）
    this.pos = null; this.move = null; this.org = null; this.an = null;
    this.fad = null; this.clip = null;
    this.scaleX = b.scaleX; this.scaleY = b.scaleY; this.rotation = b.angle;
    /** @type {Set<string>} 未支持标签名集合 */
    this.unsupported = new Set();
  }

  /**
   * 应用单个标签；返回是否被支持。
   * @param {{name:string, arg:string}} tag
   * @returns {boolean}
   */
  apply(tag) {
    const name = tag.name;
    // 定位/裁剪类标签的参数带括号：\pos(x,y)、\fad(a,b) 等，统一剥壳
    const rawArg = (tag.arg ?? '').trim();
    const arg = /^[^(]*\(/.test(rawArg) ? rawArg.replace(/^[^(]*\(/, '').replace(/\)\s*$/, '') : rawArg;
    switch (name) {
      case 'b': this.bold = arg !== '0'; return true;
      case 'i': this.italic = arg !== '0'; return true;
      case 'u': this.underline = arg !== '0'; return true;
      case 's': this.strikeout = arg !== '0'; return true;
      case 'fn': if (arg) this.fontName = arg.replace(/^"|"$/g, ''); return true;
      case 'fs':
        if (/^[+-]\d+(\.\d+)?$/.test(arg)) {
          // 相对字号：\fs+10 / \fs-5（PRD 要求验证「\fs+ 叠加」语义）
          this.fontSize = Math.max(1, this.fontSize + parseFloat(arg));
        } else if (/^\d+(\.\d+)?$/.test(arg)) {
          this.fontSize = Math.max(1, parseFloat(arg));
        }
        return true;
      case 'fsp':
        if (/^[+-]?\d+(\.\d+)?$/.test(arg)) this.spacing = parseFloat(arg);
        return true;
      case 'c':
      case '1c':
        if (arg) { try { this.primary = parseAssColor(arg); } catch { /* 非法颜色保持原值 */ } }
        return true;
      case '2c':
      case '3c':
        // 次色/描边色的行内覆盖：3c 映射到描边，2c 本期仅记录不渲染卡拉OK
        if (name === '3c' && arg) { try { this.outlineColor = parseAssColor(arg); } catch { /* 忽略 */ } }
        return true;
      case 'alpha':
        if (/^&H[0-9a-fA-F]+&?$/i.test(arg)) {
          const aa = parseInt(arg.slice(2).replace(/&$/, ''), 16);
          this.primary = { ...this.primary, alpha: 1 - aa / 255 };
        }
        return true;
      case 'pos': {
        const m = arg.match(/^\s*([-\d.]+)\s*,\s*([-\d.]+)\s*$/);
        if (m) this.pos = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
        return true;
      }
      case 'move': {
        const p = arg.split(',').map((v) => parseFloat(v));
        if (p.length >= 4 && p.every((n) => Number.isFinite(n))) {
          this.move = { x1: p[0], y1: p[1], x2: p[2], y2: p[3], t1: p[4] ?? 0, t2: p[5] ?? 0 };
        }
        return true;
      }
      case 'org': {
        const m = arg.match(/^\s*([-\d.]+)\s*,\s*([-\d.]+)\s*$/);
        if (m) this.org = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
        return true;
      }
      case 'an':
        if (/^\d$/.test(arg)) this.an = Math.min(9, Math.max(1, parseInt(arg, 10)));
        return true;
      case 'fad': {
        const p = arg.split(',').map((v) => parseFloat(v));
        if (p.length >= 1 && Number.isFinite(p[0])) {
          this.fad = { t1: Math.max(0, p[0]), t2: Math.max(0, p[1] ?? p[0]) };
        }
        return true;
      }
      case 'fscx':
        if (/^\d+(\.\d+)?$/.test(arg)) this.scaleX = parseFloat(arg);
        return true;
      case 'fscy':
        if (/^\d+(\.\d+)?$/.test(arg)) this.scaleY = parseFloat(arg);
        return true;
      case 'frz':
        if (/^[+-]?\d+(\.\d+)?$/.test(arg)) this.rotation = parseFloat(arg);
        return true;
      case 'clip': {
        const p = arg.split(',').map((v) => parseFloat(v.trim()));
        // 矩形四参形态：(x1,y1,x2,y2[,scale])；矢量绘图形态本期不支持 → 未支持清单
        if (p.length >= 4 && p.slice(0, 4).every((n) => Number.isFinite(n))) {
          this.clip = { x1: p[0], y1: p[1], x2: p[2], y2: p[3] };
          return true;
        }
        this.unsupported.add('clip(矢量)');
        return false;
      }
      default:
        this.unsupported.add(name);
        return false;
    }
  }

  /** 当前状态快照（浅拷贝；颜色对象不可变使用，不深拷贝） */
  snapshot() {
    return {
      fontName: this.fontName,
      fontSize: this.fontSize,
      bold: this.bold,
      italic: this.italic,
      underline: this.underline,
      strikeout: this.strikeout,
      spacing: this.spacing,
      primary: this.primary,
      outlineColor: this.outlineColor,
      outlineWidth: this.outlineWidth,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      rotation: this.rotation,
    };
  }
}

/**
 * 把 Dialogue 文本拆成 text/tags 片段序列：
 * `{\b1}粗{\b0}普通` → [tags(b1), text(粗), tags(b0), text(普通)]
 * 同时完成 \N/\n → 换行、\h → 不换行空格 的转义还原。
 * @param {string} raw Dialogue 的 Text 字段原文
 * @param {AssStyle} baseStyle 基准样式（决定首个 text 片段的快照内容）
 * @returns {{segments: Segment[], state: TagState}}
 */
export function tokenizeDialogue(raw, baseStyle) {
  const state = new TagState(baseStyle);
  /** @type {Segment[]} */
  const segments = [];
  const re = /\{([^}]*)\}/g; // ASS 覆盖块
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', text: unescapeAssText(raw.slice(last, m.index)), style: state.snapshot() });
    }
    /** @type {AssOverrideTag[]} */
    const tags = [];
    for (const tok of splitTagTokens(m[1])) {
      // splitTagTokens 已按 `\` 切好：token 形如 'pos(320,50)'/'fs+8'/'b1'
      // 规则：字母前缀为标签名，其余为参数原文。
      // 评审严重1：\1c/\2c/\3c/\4c 与 \1a.. 为「数字前缀」标签，
      // 必须优先匹配，否则整串落入 unsupported 使 apply 分支不可达。
      const digitM = /^([1-4][a-zA-Z]+)/.exec(tok);
      const alphaM = digitM ? null : /^([a-zA-Z]+)/.exec(tok);
      const name = digitM ? digitM[1] : (alphaM ? alphaM[1] : '');
      const arg = digitM ? tok.slice(digitM[1].length)
                : alphaM   ? tok.slice(alphaM[1].length)
                : '';
      const t = {
        name: (name || tok).toLowerCase(),
        arg,
        supported: false,
      };
      t.supported = state.apply(t);
      tags.push(t);
    }
    segments.push({ type: 'tags', tags });
    last = re.lastIndex;
  }
  if (last < raw.length) {
    segments.push({ type: 'text', text: unescapeAssText(raw.slice(last)), style: state.snapshot() });
  }
  return { segments, state };
}

/**
 * 把覆盖块内部按 `\` 切成单标签 token。
 * 例："\\fs+8\\fsp2\\c&HFF0000&" → ['fs+8','fsp2','c&HFF0000&']
 * 注意保留嵌套括号里的逗号参数（clip/move 等），因此不能简单 split(',')。
 * @param {string} block 花括号内原文
 * @returns {string[]}
 */
function splitTagTokens(block) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '\\') {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [block];
}

/**
 * ASS 文本转义还原：`\N`/`\n` → 换行；`\h` → 不换行空格(U+00A0)。
 * @param {string} s
 * @returns {string}
 */
export function unescapeAssText(s) {
  return s.replaceAll('\\N', '\n').replaceAll('\\n', '\n').replaceAll('\\h', '\u00A0');
}
