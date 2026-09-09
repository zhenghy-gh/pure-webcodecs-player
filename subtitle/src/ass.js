/**
 * subtitle/src/ass.js — ASS/SSA 解析器（本期尽力档：样式段 + Dialogue 白名单标签）
 *
 * 支持：
 *   - [Script Info] 键值（PlayResX/PlayResY 等保留）
 *   - [V4+ Styles] 与 [V4 Styles]（SSA）：按 Format 行动态映射列序
 *   - [Events]：Format 行映射 + Dialogue/Comment；Text 字段内逗号不切分
 *   - 覆盖标签走 tags.js 白名单状态机，白名单外进入未支持清单
 * 不支持（如实标注，见 README 已知限制）：\t 动画、矢量绘图 \p、卡拉OK \k 等。
 */

import { SubtitleError } from './errors.js';
import { parseTimestamp, formatAssTimestamp } from './time.js';
import { normalizeText } from './cue.js';
import { createDefaultStyle, parseAssColor } from './style.js';
import { tokenizeDialogue } from './tags.js';

/** @typedef {import('./cue.js').Cue} Cue */
/** @typedef {import('./style.js').AssStyle} AssStyle */
/** @typedef {import('./tags.js').Segment} Segment */

/**
 * @typedef {Cue} AssCue
 * @property {Segment[]} [segments] 词法片段（渲染器消费）
 * @property {string[]} [unsupported] 本条事件出现的未支持标签名
 * @property {Object} [geom] 事件级几何覆盖（由标签状态机导出）
 * @property {{name:string}} [styleRef]
 *
 * @typedef {Object} AssInfo Script Info 键值表
 * @property {number} [playResX]
 * @property {number} [playResY]
 *
 * @typedef {Object} AssStats
 * @property {number} dialogueCount
 * @property {number} commentCount
 * @property {number} styleCount
 * @property {number} skippedBlocks   畸形跳过计数
 * @property {string[]} warnings
 *
 * @typedef {Object} AssResult
 * @property {'ass'} format
 * @property {'x-ass'} codec
 * @property {AssInfo} info
 * @property {AssStyle[]} styles
 * @property {AssCue[]} cues
 * @property {string[]} unsupportedTags 全文件唯一未支持标签清单（排序去重）
 * @property {number} durationUs
 * @property {AssStats} stats
 *
 * @typedef {Object} AssOptions
 * @property {boolean} [strict=false]
 */

/** 无 Format 行时的默认列序（V4+） */
const DEFAULT_EVENT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/**
 * 解析 ASS/SSA 文本。
 * @param {string} text 文件内容
 * @param {AssOptions} [options]
 * @returns {AssResult}
 * @throws {SubtitleError} 空输入 / strict 模式下畸形行抛 PARSE_ERROR；非 ASS 结构抛 NOT_SUPPORTED
 */
export function parseAss(text, options = {}) {
  const strict = options.strict === true;
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    throw new SubtitleError('PARSE_ERROR', '输入为空，不是有效的字幕文件');
  }
  const normalized = normalizeText(raw);
  // 结构识别：ASS 必须有节头或 Dialogue 行。
  // I5：`^\s*\[.*\]` 里的 `\s`/`.` 可跨越换行，配合 m 标志会让每个行首都成为起点、
  // 每次再向后吞掉整段空白 —— 大量空行输入下退化成 O(n²)（灾难性回溯）。
  // 改为行内字符类（不含 \n）后，单次匹配成本与行长线性相关，整体 O(n)。
  const looksAss = /^[ \t]*\[[^\]\n]*\]/m.test(normalized) || /^[ \t]*Dialogue:/m.test(normalized);
  if (!looksAss) {
    throw new SubtitleError('NOT_SUPPORTED', '内容不具备 ASS/SSA 结构（缺少节头与 Dialogue 行）');
  }

  /** @type {AssInfo} */
  const info = {};
  /** @type {AssStyle[]} */
  const styles = [];
  /** @type {AssCue[]} */
  const cues = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Set<string>} */
  const unsupportedAll = new Set();
  let dialogueCount = 0;
  let commentCount = 0;
  let skippedBlocks = 0;

  /** 当前节的 Format 列序 */
  let styleFormat = ['name', 'fontname', 'fontsize', 'primarycolour', 'secondarycolour', 'outlinecolour', 'backcolour', 'bold', 'italic', 'underline', 'strikeout', 'scalex', 'scaley', 'spacing', 'angle', 'borderstyle', 'outline', 'shadow', 'alignment', 'marginl', 'marginr', 'marginv', 'encoding'];
  let eventFormat = null;

  /** @type {string|null} */
  let section = null;
  const lines = normalized.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith(';')) continue; // 注释行（; 开头）

    // —— 节头切换 ——
    const secM = /^\[([^\]]+)\]$/.exec(line);
    if (secM) {
      section = secM[1].trim().toLowerCase();
      continue;
    }

    // —— [script info]：key=value ——
    if (section === 'script info') {
      const kv = /^([^:]+):(.*)$/.exec(line);
      if (kv) {
        const key = kv[1].trim().toLowerCase();
        const val = kv[2].trim();
        info[key] = val;
        if (key === 'playresx') info.playResX = Number.parseInt(val, 10);
        if (key === 'playresy') info.playResY = Number.parseInt(val, 10);
      }
      continue;
    }

    // —— 样式节：Format / Style ——
    if (section && section.startsWith('v4')) {
      if (/^format\s*:/i.test(line)) {
        styleFormat = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase());
        continue;
      }
      if (/^style\s*:/i.test(line)) {
        const body = line.slice(line.indexOf(':') + 1);
        const parts = body.split(',');
        if (parts.length < styleFormat.length) {
          skippedBlocks += 1;
          warnings.push(`第 ${li + 1} 行 Style 字段数少于 Format 声明，已跳过`);
          if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${li + 1} 行 Style 字段数不足`);
          continue;
        }
        /** @type {Record<string,string>} */
        const rec = {};
        styleFormat.forEach((k, i) => { rec[k] = (parts[i] ?? '').trim(); });
        const st = createDefaultStyle(rec['name'] || `Style${styles.length + 1}`);
        try {
          st.fontname = rec['fontname'] || st.fontname;
          st.fontsize = numOr(rec['fontsize'], st.fontsize);
          if (rec['primarycolour']) st.primary = parseAssColor(rec['primarycolour']);
          if (rec['secondarycolour']) st.secondary = parseAssColor(rec['secondarycolour']);
          if (rec['outlinecolour']) st.outlineColor = parseAssColor(rec['outlinecolour']);
          if (rec['backcolour']) st.back = parseAssColor(rec['backcolour']);
          st.bold = boolOr(rec['bold'], st.bold);
          st.italic = boolOr(rec['italic'], st.italic);
          st.underline = boolOr(rec['underline'], st.underline);
          st.strikeout = boolOr(rec['strikeout'], st.strikeout);
          st.scaleX = numOr(rec['scalex'], st.scaleX);
          st.scaleY = numOr(rec['scaley'], st.scaleY);
          st.spacing = numOr(rec['spacing'], st.spacing);
          st.angle = numOr(rec['angle'], st.angle);
          st.borderStyle = numOr(rec['borderstyle'], st.borderStyle);
          st.outlineWidth = numOr(rec['outline'], st.outlineWidth);
          st.shadow = numOr(rec['shadow'], st.shadow);
          st.alignment = Math.min(9, Math.max(1, numOr(rec['alignment'], st.alignment)));
          st.marginL = numOr(rec['marginl'], st.marginL);
          st.marginR = numOr(rec['marginr'], st.marginR);
          st.marginV = numOr(rec['marginv'], st.marginV);
        } catch (err) {
          warnings.push(`第 ${li + 1} 行样式含非法颜色值，相关字段回退默认：${/** @type {Error} */ (err).message}`);
        }
        styles.push(st);
        continue;
      }
      continue;
    }

    // —— 事件节：Format / Dialogue / Comment ——
    if (section === 'events') {
      if (/^format\s*:/i.test(line)) {
        eventFormat = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase());
        continue;
      }
      const isDialogue = /^dialogue\s*:/i.test(line);
      const isComment = /^comment\s*:/i.test(line);
      if (!isDialogue && !isComment) continue; // Picture/Sound/Font 等命令行忽略

      if (isComment) commentCount += 1; // 作者注释：计数不入轨

      const fmt = eventFormat ?? inferEventFormat(section, styleFormat);
      const body = line.slice(line.indexOf(':') + 1);
      const parts = body.split(',');
      if (parts.length < fmt.length) {
        skippedBlocks += 1;
        warnings.push(`第 ${li + 1} 行 ${isDialogue ? 'Dialogue' : 'Comment'} 字段数少于 Format 声明，已跳过`);
        if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${li + 1} 行事件字段数不足`);
        continue;
      }
      /** @type {Record<string,string>} */
      const rec = {};
      fmt.forEach((k, i) => { rec[k] = i < fmt.length - 1 ? parts[i].trim() : parts.slice(fmt.length - 1).join(',').trim(); });

      let startUs = 0;
      let endUs = 0;
      try {
        startUs = parseTimestamp(rec['start'] ?? '');
        endUs = parseTimestamp(rec['end'] ?? '');
      } catch (err) {
        skippedBlocks += 1;
        warnings.push(`第 ${li + 1} 行时间码无法解析：「${rec['start']}→${rec['end']}」，已跳过`);
        if (strict) throw err;
        continue;
      }
      if (isDialogue) {
        if (endUs <= startUs) {
          skippedBlocks += 1;
          warnings.push(`第 ${li + 1} 行时间区间非法，已跳过`);
          if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${li + 1} 行时间区间非法：end<=start`);
          continue;
        }
        dialogueCount += 1;
        const styleName = rec['style'] || 'Default';
        const baseStyle = styles.find((s) => s.name.toLowerCase() === styleName.toLowerCase()) ?? styles[0] ?? createDefaultStyle();
        const { segments, state } = tokenizeDialogue(rec['text'] ?? '', baseStyle);
        const __rawLine = lines[li];  // Dialogue 行原文（未 trim，含标签，契约 Cue.raw 来源）
        const plain = segments.filter((s) => s.type === 'text').map((s) => /** @type {any} */ (s).text).join('');
        const unsupported = [...state.unsupported];
        for (const u of unsupported) unsupportedAll.add(u);
        cues.push({
          startUs,
          endUs,
          text: plain,
          raw: new TextEncoder().encode(__rawLine),
          layer: intOr(rec['layer'], intOr(rec['marked'], 0)),
          style: baseStyle.name,
          settings: {
            name: rec['name'] ?? '',
            effect: rec['effect'] ?? '',
            mL: rec['marginl'] ?? '0', mR: rec['marginr'] ?? '0', mV: rec['marginv'] ?? '0',
          },
          segments,
          unsupported,
          // 事件级几何覆盖（\pos/\move/\org/\an/\fad/clip/fscx/fscy/frz 最后值）
          geom: {
            pos: state.pos ?? null,
            move: state.move ?? null,
            org: state.org ?? null,
            an: state.an ?? null,
            fad: state.fad ?? null,
            clip: state.clip ?? null,
            scaleX: state.scaleX,
            scaleY: state.scaleY,
            rotation: state.rotation,
          },
        });
      }
      continue;
    }
    // 其余节（fonts/graphics/globals…）：忽略
  }

  let durationUs = 0;
  for (const c of cues) if (c.endUs > durationUs) durationUs = c.endUs;

  return {
    format: 'ass',
    codec: 'x-ass',
    info,
    styles,
    cues,
    unsupportedTags: [...unsupportedAll].sort(),
    durationUs,
    stats: { dialogueCount, commentCount, styleCount: styles.length, skippedBlocks, warnings },
  };
}

/** 数字或默认值（容忍空串/非法输入） */
function numOr(s, dflt) {
  const n = Number.parseFloat(String(s ?? '').trim());
  return Number.isFinite(n) ? n : dflt;
}

/** 整数或默认值 */
function intOr(s, dflt) {
  const n = Number.parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) ? n : dflt;
}

/** ASS 布尔：-1/非零为真 */
function boolOr(s, dflt) {
  const t = String(s ?? '').trim();
  if (t === '') return dflt;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n !== 0 : dflt;
}

/** 无 Events Format 时推断列序：SSA(V4) 用 Marked，V4+ 用 Layer */
function inferEventFormat(_section, _styleFormat) {
  return DEFAULT_EVENT_FORMAT.slice();
}

export { formatAssTimestamp };
