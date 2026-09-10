/**
 * subtitle/src/time.js — 时间码解析与格式化
 *
 * 契约对齐：CONTRACTS §0.5 —— 模块边界一律输出「整数微秒（µs）」。
 * 容错目标（PRD §3.10）：
 *   - 毫秒分隔符逗号/句点均可（SRT 逗号、VTT 句点，交叉容忍）
 *   - 小时位可缺省（mm:ss.mmm）
 *   - ASS 的厘秒（H:MM:SS.cc，两位小数）自动按十进制补齐到毫秒
 */

import { SubtitleError } from './errors.js';

/**
 * 通用时间码正则：可选小时位(1-3位) + 分 + 秒 + 可选小数部分(1-3位)。
 * 例：00:00:01,500 / 0:12:34.5 / 05:06.250 / 1:02:03.12(ASS 厘秒)
 */
const TS_RE = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,}))?$/;

/**
 * 解析单个时间码为整数微秒。
 *
 * 支持格式：`HH:MM:SS,mmm`、`HH:MM:SS.mmm`、`H:MM:SS.mmm`、`MM:SS.mmm`、`M:SS,mmm`；
 * 小数位不足三位按十进制补齐（`.5` = 500ms，ASS `.cc` 两位 = 厘秒）。
 *
 * @param {string} str 时间码原文（允许首尾空白）
 * @returns {number} 整数微秒
 * @throws {SubtitleError} PARSE_ERROR——格式非法或分/秒越界（>59）
 */
export function parseTimestamp(str) {
  if (typeof str !== 'string') {
    throw new SubtitleError('PARSE_ERROR', '时间码必须是字符串', { detail: { got: typeof str } });
  }
  const m = TS_RE.exec(str.trim());
  if (!m) {
    throw new SubtitleError('PARSE_ERROR', `无法解析时间码「${str.trim()}」`, { detail: { raw: str } });
  }
  const hours = m[1] ? Number.parseInt(m[1], 10) : 0;
  const minutes = Number.parseInt(m[2], 10);
  const seconds = Number.parseInt(m[3], 10);
  if (minutes > 59 || seconds > 59) {
    throw new SubtitleError('PARSE_ERROR', `时间码分/秒越界（>59）：「${str.trim()}」`, { detail: { raw: str } });
  }
  // 小数位右补零、超长截断到毫秒（3 位）：'5'→500ms，'52'→520ms，'1234'→123ms
  const frac = m[4] ?? '';
  const ms = frac === '' ? 0 : Number.parseInt(frac.slice(0, 3).padEnd(3, '0'), 10);
  return ((hours * 3600 + minutes * 60 + seconds) * 1000 + ms) * 1000;
}

/** 内部：微秒 → {h,m,s,ms} 分量 */
function splitUs(us) {
  const total = Math.max(0, Math.round(us / 1000)); // 毫秒域
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return { h, m, s, ms };
}

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

/**
 * 格式化为 SRT 时间码 `HH:MM:SS,mmm`。
 * @param {number} us 整数微秒
 * @returns {string}
 */
export function formatSrtTimestamp(us) {
  const t = splitUs(us);
  return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)},${p3(t.ms)}`;
}

/**
 * 格式化为 WebVTT 时间码；不足 1 小时输出 `MM:SS.mmm`，达到 1 小时输出 `HH:MM:SS.mmm`。
 * @param {number} us 整数微秒
 * @returns {string}
 */
export function formatVttTimestamp(us) {
  const t = splitUs(us);
  return t.h > 0
    ? `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}.${p3(t.ms)}`
    : `${p2(t.m)}:${p2(t.s)}.${p3(t.ms)}`;
}

/**
 * 格式化为 ASS 时间码 `H:MM:SS.cc`（厘秒，小时不补零）。
 * @param {number} us 整数微秒
 * @returns {string}
 */
export function formatAssTimestamp(us) {
  const cs = Math.max(0, Math.round(us / 10000)); // 厘秒域（四舍五入）
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const cc = cs % 100;
  return `${h}:${p2(m)}:${p2(s)}.${p2(cc)}`;
}
