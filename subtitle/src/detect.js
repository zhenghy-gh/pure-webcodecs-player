/**
 * subtitle/src/detect.js — 字幕格式嗅探
 *
 * 契约对齐（CONTRACTS §2.4 subtitle 行 / §3）：按内容嗅探输出 codec 串
 * x-srt / x-vtt / x-ass；无法识别返回 null。
 */

import { normalizeText } from './cue.js';
import { parseSrt } from './srt.js';
import { parseVtt } from './vtt.js';
import { parseAss } from './ass.js';
import { SubtitleError } from './errors.js';

/** @typedef {'srt'|'vtt'|'ass'} SubtitleFormat */
/** @typedef {'x-srt'|'x-vtt'|'x-ass'} SubtitleCodec */

/**
 * 嗅探字幕格式（纯文本特征，无副作用）。
 * 判定顺序：WEBVTT 签名 → 无签名 VTT 特征 → 按文件中的先后顺序消歧 ASS 结构与 SRT 时间行。
 * @param {string} text 文件内容
 * @returns {SubtitleFormat|null}
 */
export function detectFormat(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const t = normalizeText(text);

  if (/^WEBVTT($|[ \t\n])/.test(t)) return 'vtt';

  // 无签名 VTT（评审建议）：标识符行 + 点毫秒时间行 → 判 vtt。
  // 先于宽松 SRT 时间特征，以免把带标识符的 VTT cue 误判为 SRT。
  const unsignedVtt = /(^|\n)(?!\d)[^\n\r]+\r?\n(?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3}\s*-->/.test(t);
  if (unsignedVtt && !/\n\s*\d+\r?\n\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(t)) return 'vtt';

  // SRT 的时间行必须独占一行（可有行首空格）；这比正文中的 ASS 节头/Dialogue 字样
  // 更有格式辨识力，同时不会把 Dialogue payload 中的时间片段当成 cue。
  const srtTimingLine = /(?:^|\n)[ \t]*(?:\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})[ \t]*-->/m;
  const srtTimingMatch = srtTimingLine.exec(t);
  const assStructure = /^[ \t]*\[script info\][ \t]*$|^[ \t]*\[v4\+? styles\][ \t]*$|^[ \t]*Dialogue\s*:/im;
  const assMatch = assStructure.exec(t);
  // If ASS structure occurs first it remains authoritative; otherwise a standalone timing line
  // is stronger evidence than ASS-looking text embedded in an SRT cue payload.
  if (srtTimingMatch && (!assMatch || srtTimingMatch.index < assMatch.index)) return 'srt';
  if (assMatch) return 'ass';
  return null;
}

/**
 * 嗅探并映射为契约 codec 串。
 * @param {string} text 文件内容
 * @returns {SubtitleCodec|null}
 */
export function probeSubtitleCodec(text) {
  const f = detectFormat(text);
  return f === 'srt' ? 'x-srt' : f === 'vtt' ? 'x-vtt' : f === 'ass' ? 'x-ass' : null;
}

/**
 * 自动解析：嗅探后分派到对应解析器。
 * @param {string} text 文件内容
 * @param {{strict?: boolean}} [options]
 * @returns {ReturnType<import('./srt.js').parseSrt> | ReturnType<import('./vtt.js').parseVtt> | ReturnType<import('./ass.js').parseAss>}
 * @throws {SubtitleError} NOT_SUPPORTED——无法识别的格式
 */
export function parseAuto(text, options = {}) {
  switch (detectFormat(text)) {
    case 'vtt': return parseVtt(text, options);
    case 'ass': return parseAss(text, options);
    case 'srt': return parseSrt(text, options);
    default:
      throw new SubtitleError('NOT_SUPPORTED', '无法识别的字幕格式（支持 SRT/WebVTT/ASS/SSA）');
  }
}
