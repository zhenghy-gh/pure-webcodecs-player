/**
 * subtitle/src/cue.js — Cue 数据工具
 *
 * Cue 是三种格式的统一输出单元：
 * @typedef {Object} Cue
 * @property {number} startUs  开始时间（整数微秒，含）
 * @property {number} endUs    结束时间（整数微秒，不含）
 * @property {string} text     原始文本（保留换行与内联标签）
 * @property {number} [layer]  ASS 层号（SRT/VTT 恒为 0）
 * @property {string} [style]  ASS 样式名（其他格式缺省）
 * @property {Record<string,string>} [settings] VTT cue settings / SRT 坐标段原文
 */

/**
 * 去除 BOM、统一换行为 \n。
 * @param {string} text 原文
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * 去除内联标签（`<v 名字>`、`<i>`、`{\...}` 等），保留标签内文本。
 * 用于把 SRT/VTT 的富文本降级成纯文本。
 * @param {string} text 原始文本
 * @returns {string} 纯文本
 */
export function stripCueTags(text) {
  return String(text)
    .replace(/\{\\[^}]*\}/g, '') // ASS 覆盖块（防御性）
    .replace(/<[^>]+>/g, '');   // HTML/VTT 内联标签
}

/**
 * 按 startUs 升序稳定排序（不修改入参，返回新数组）。
 * @param {Cue[]} cues
 * @returns {Cue[]}
 */
export function sortCues(cues) {
  return cues.map((c, i) => /** @type {any} */ ({ c, i }))
    .sort((a, b) => (a.c.startUs - b.c.startUs) || (a.i - b.i))
    .map((x) => x.c);
}

/**
 * 平移全部时间戳（返回新 Cue 对象，不改原数组）。
 * @param {Cue[]} cues
 * @param {number} deltaUs 平移量（整数微秒，可为负）
 * @returns {Cue[]} 平移后的新数组
 */
export function shiftCues(cues, deltaUs) {
  return cues.map((c) => ({
    ...c,
    startUs: Math.max(0, c.startUs + deltaUs),
    endUs: Math.max(0, c.endUs + deltaUs),
  }));
}

/**
 * 取某时刻正在显示的 Cue（线性扫描；字幕量级 <1e4 条足够）。
 * 区间语义：startUs <= t < endUs。
 * @param {Cue[]} cues 已按 startUs 升序更佳（乱序也能正确返回）
 * @param {number} us 目标时刻（整数微秒）
 * @returns {Cue[]} 命中的 cue 列表（保持输入顺序）
 */
export function findActiveCues(cues, us) {
  const out = [];
  for (const c of cues) {
    if (c.startUs <= us && us < c.endUs) out.push(c);
  }
  return out;
}

/**
 * 计算整组 cue 的时间跨度（最后一条的 endUs；空数组为 0）。
 * @param {Cue[]} cues
 * @returns {number} 整数微秒
 */
export function cuesDurationUs(cues) {
  let max = 0;
  for (const c of cues) if (c.endUs > max) max = c.endUs;
  return max;
}
