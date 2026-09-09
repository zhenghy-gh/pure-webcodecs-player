/**
 * subtitle/src/srt.js — SubRip（.srt）解析器
 *
 * 容错能力（PRD §3.10）：
 *   - BOM / CRLF 自动归一
 *   - 毫秒分隔符 `,` 与 `.` 交叉容忍
 *   - 小时位可缺省
 *   - 序号行可缺省/不连续/非数字（宽松模式忽略）
 *   - 时间行尾可携带坐标段（X1:.. X2:.. 等，忽略但保留原文）
 *   - 畸形块：lenient（默认）跳过并计数；strict 直接抛 SubtitleError
 */

import { SubtitleError } from './errors.js';
import { parseTimestamp, formatSrtTimestamp } from './time.js';
import { normalizeText } from './cue.js';

/** @typedef {import('./cue.js').Cue} Cue */

/**
 * @typedef {Object} ParseStats 解析统计（容错计数）
 * @property {number} cueCount      成功解析的 cue 数
 * @property {number} skippedBlocks 被跳过的畸形块数
 * @property {string[]} warnings    逐条警告描述（中文）
 *
 * @typedef {Object} SrtResult
 * @property {'srt'} format
 * @property {'x-srt'} codec            契约 codec 串（CONTRACTS §3）
 * @property {Cue[]} cues
 * @property {number} durationUs        最后一条结束时间；空文件为 0
 * @property {ParseStats} stats
 *
 * @typedef {Object} ParseOptions
 * @property {boolean} [strict=false] true 时遇畸形块抛异常而非跳过
 */

/** 时间行正则：`start --> end[ 任意附加参数]` */
const TIMING_RE = /^\s*(\S+)\s+-->\s+(\S+)\s*(.*)$/;

/**
 * 解析 SRT 文本。
 * @param {string} text 文件内容
 * @param {ParseOptions} [options]
 * @returns {SrtResult}
 * @throws {SubtitleError} strict 模式下畸形块抛 PARSE_ERROR；空输入抛 PARSE_ERROR
 */
export function parseSrt(text, options = {}) {
  const strict = options.strict === true;
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    throw new SubtitleError('PARSE_ERROR', '输入为空，不是有效的字幕文件');
  }
  const normalized = normalizeText(raw);

  /** @type {Cue[]} */
  const cues = [];
  /** @type {string[]} */
  const warnings = [];
  let skippedBlocks = 0;
  // 空白行切块：允许块间出现多个含空白字符的「空」行
  const blocks = normalized.split(/\n[ \t]*\n+/);

  for (let bi = 0; bi < blocks.length; bi++) {
    const lines = blocks[bi].split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) continue;

    // 找到时间行的下标：第一处包含 '-->' 的行
    const ti = lines.findIndex((l) => TIMING_RE.test(l));
    if (ti === -1) {
      // 整块无时间行 → 畸形（可能是纯序号残片或垃圾数据）
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块缺少时间行，已跳过`);
      if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${bi + 1} 块缺少时间行`, { detail: { block: lines[0] } });
      continue;
    }
    // 时间行之前的行视为序号/ID 行（宽松忽略；非纯数字时记警告）
    for (let k = 0; k < ti; k++) {
      if (!/^\d+$/.test(lines[k])) {
        warnings.push(`第 ${bi + 1} 块的序号行不是纯数字：「${lines[k]}」（已忽略）`);
      }
    }

    const tm = TIMING_RE.exec(lines[ti]);
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
    // 区间非法（end<=start）：按畸形处理
    if (endUs <= startUs) {
      skippedBlocks += 1;
      warnings.push(`第 ${bi + 1} 块结束时间不晚于开始时间，已跳过`);
      if (strict) throw new SubtitleError('PARSE_ERROR', `第 ${bi + 1} 块时间区间非法：end<=start`, { detail: { line: lines[ti] } });
      continue;
    }

    const textLines = lines.slice(ti + 1);
    cues.push({
      startUs,
      endUs,
      text: textLines.join('\n'),
      raw: lines.join('\n'),                       // 原始条目（契约 §8 Cue.raw）
      layer: 0,
      settings: tm[3] ? { extra: tm[3].trim() } : undefined,
    });
  }

  let durationUs = 0;
  for (const c of cues) if (c.endUs > durationUs) durationUs = c.endUs;

  return {
    format: 'srt',
    codec: 'x-srt',
    cues,
    durationUs,
    stats: { cueCount: cues.length, skippedBlocks, warnings },
  };
}

export { formatSrtTimestamp };
