/**
 * subtitle/src/vtt.js — WebVTT（.vtt）解析器
 *
 * 容错能力（PRD §3.10）：
 *   - BOM / CRLF 归一；毫秒分隔符句点为主、逗号容忍
 *   - 小时位可缺省（MM:SS.mmm）
 *   - NOTE / STYLE / REGION 块跳过并计数
 *   - cue identifier 行可缺省
 *   - 时间行尾 cue settings（align/line/position/size/vertical）解析为键值表
 */

import { SubtitleError } from './errors.js';
import { parseTimestamp, formatVttTimestamp } from './time.js';
import { normalizeText } from './cue.js';

/** @typedef {import('./cue.js').Cue} Cue */

/**
 * @typedef {Object} VttStats
 * @property {number} cueCount
 * @property {number} skippedBlocks  跳过的畸形块数
 * @property {number} noteBlocks     NOTE 块数
 * @property {number} styleBlocks    STYLE 块数
 * @property {number} regionBlocks   REGION 块数
 * @property {string[]} warnings
 *
 * @typedef {Object} VttResult
 * @property {'vtt'} format
 * @property {'x-vtt'} codec
 * @property {Record<string,string>} header  头部元数据（Key: Value 行）
 * @property {Cue[]} cues
 * @property {number} durationUs
 * @property {VttStats} stats
 *
 * @typedef {Object} VttOptions
 * @property {boolean} [strict=false]
 */

/** 时间行：`start --> end[ k:v k:v …]` */
const TIMING_RE = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/;

/**
 * 把 cue settings 原文解析为键值表。
 * 例："align:start line:0 position:50% size:60" → { align:'start', line:'0', position:'50%', size:'60' }
 * @param {string} raw
 * @returns {Record<string,string>}
 */
function parseSettings(raw, strict = false, blockNumber = 0) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!raw) return out;
  const seen = new Set();
  const fail = (token, key, value) => {
    throw new SubtitleError('PARSE_ERROR', `第 ${blockNumber} 块 cue setting 非法：「${token}」`, { detail: { block: blockNumber, setting: key, value } });
  };
  const isPercentage = (value) => /^\d+(?:\.\d+)?%$/.test(value) && Number.parseFloat(value) <= 100;
  const isLineValue = (value) => {
    const [position, alignment, ...rest] = value.split(',');
    const validPosition = /^-?\d+$/.test(position) || isPercentage(position);
    return rest.length === 0 && validPosition && (alignment === undefined || /^(?:start|center|end)$/.test(alignment));
  };
  const isPositionValue = (value) => {
    const [position, alignment, ...rest] = value.split(',');
    return rest.length === 0 && isPercentage(position) && (alignment === undefined || /^(?:line-left|center|line-right)$/.test(alignment));
  };
  const settingsText = strict ? raw.replace(/^[ \t]+|[ \t]+$/g, '') : raw.trim();
  const tokens = settingsText ? settingsText.split(strict ? /[ \t]+/ : /\s+/) : [];
  for (const token of tokens) {
    const idx = token.indexOf(':');
    if (idx <= 0) {
      if (strict) fail(token, '', token);
      continue;
    }
    const key = token.slice(0, idx);
    const value = token.slice(idx + 1);
    if (strict) {
      if (!['vertical', 'line', 'position', 'size', 'align', 'region'].includes(key) || seen.has(key)) {
        fail(token, key, value);
      }
      let valid = false;
      if (key === 'vertical') valid = /^(?:rl|lr)$/.test(value);
      else if (key === 'line') valid = isLineValue(value);
      else if (key === 'position') valid = isPositionValue(value);
      else if (key === 'size') valid = isPercentage(value);
      else if (key === 'align') valid = /^(?:start|center|end|left|right)$/.test(value);
      else if (key === 'region') valid = !/[ \t]|-->/.test(value);
      if (!valid) fail(token, key, value);
      seen.add(key);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 解析 WebVTT 文本。
 * @param {string} text 文件内容
 * @param {VttOptions} [options]
 * @returns {VttResult}
 * @throws {SubtitleError} 缺少 WEBVTT 签名、strict 模式下畸形块抛 PARSE_ERROR；空输入抛 PARSE_ERROR
 */
export function parseVtt(text, options = {}) {
  const strict = options.strict === true;
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    throw new SubtitleError('PARSE_ERROR', '输入为空，不是有效的字幕文件');
  }
  const normalized = normalizeText(raw);
  // 签名校验（BOM 已剥离）：WEBVTT 后必须是行尾或空白符
  if (!/^WEBVTT($|[ \t\n])/.test(normalized)) {
    throw new SubtitleError('PARSE_ERROR', '缺少 WEBVTT 签名头，不是有效的 WebVTT 文件');
  }

  const blocks = normalized.split(/\n[ \t]*\n+/);
  /** @type {Record<string,string>} */
  const header = {};
  /** @type {Cue[]} */
  const cues = [];
  /** @type {string[]} */
  const warnings = [];
  let skippedBlocks = 0;
  let noteBlocks = 0;
  let styleBlocks = 0;
  let regionBlocks = 0;

  for (let bi = 0; bi < blocks.length; bi++) {
    const lines = blocks[bi].split('\n').map((l) => l.trimEnd());
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) continue;
    const first = lines[i];

    // —— 首块：WEBVTT 头（可携带元数据行 Key: Value）——
    if (/^WEBVTT($|[ \t])/.test(first)) {
      for (let k = i + 1; k < lines.length; k++) {
        const kv = /^([^:\s]+)\s*:\s*(.+)$/.exec(lines[k].trim());
        if (kv) header[kv[1]] = kv[2];
      }
      continue;
    }
    // —— 注释与样式/区域块：跳过并计数 ——
    if (/^NOTE(?![A-Za-z0-9])/.test(first)) { noteBlocks += 1; continue; }
    if (/^STYLE(?![A-Za-z0-9])/.test(first)) { styleBlocks += 1; continue; }
    if (/^REGION(?![A-Za-z0-9])/.test(first)) { regionBlocks += 1; continue; }

    // —— Cue 块：可选 id 行 + 时间行 + 文本行 ——
    let ti = first.includes('-->') ? i : -1;
    if (ti === -1) {
      ti = i + 1 < lines.length && lines[i + 1].includes('-->') ? i + 1 : -1;
    }
    if (ti === -1) {
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块缺少时间行，已跳过`);
      if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${bi + 1} 块缺少时间行`, { detail: { block: first } });
      continue;
    }

    const tm = TIMING_RE.exec(lines[ti].trim());
    if (!tm) {
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块时间行格式非法，已跳过`);
      if (strict) {
        throw new SubtitleError('PARSE_ERROR', `第 ${bi + 1} 块时间行格式非法`, { detail: { block: first, timing: lines[ti] } });
      }
      continue;
    }
    let startUs = 0;
    let endUs = 0;
    try {
      startUs = parseTimestamp(tm[1]);
      endUs = parseTimestamp(tm[2]);
    } catch (err) {
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块时间码无法解析：「${lines[ti]}」，已跳过`);
      if (strict) throw err;
      continue;
    }
    if (endUs <= startUs) {
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块时间区间非法，已跳过`);
      if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${bi + 1} 块时间区间非法：end<=start`);
      continue;
    }

    cues.push({
      startUs,
      endUs,
      text: lines.slice(ti + 1).join('\n'),
      raw: blocks[bi],                             // 原始条目（契约 §8 Cue.raw）
      layer: 0,
      settings: tm[3] ? parseSettings(tm[3], strict, bi + 1) : undefined,
    });
  }

  let durationUs = 0;
  for (const c of cues) if (c.endUs > durationUs) durationUs = c.endUs;

  return {
    format: 'vtt',
    codec: 'x-vtt',
    header,
    cues,
    durationUs,
    stats: { cueCount: cues.length, skippedBlocks, noteBlocks, styleBlocks, regionBlocks, warnings },
  };
}

export { formatVttTimestamp };
