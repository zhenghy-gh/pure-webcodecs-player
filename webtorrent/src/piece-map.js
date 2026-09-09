/**
 * piece-map.js —— piece 级映射与确定性调度
 *
 * PRD 验收点名：固定种子 piece 决策可复现 / 跨 piece 映射。
 * 全部为纯函数，同输入必同输出。
 */

import { PlayerError } from '../../core/src/errors.js';

/**
 * 把字节区间 [offset, offset+length) 映射到 piece 列表（支持跨片）。
 * @param {number} offset
 * @param {number} length
 * @param {number} pieceLength
 * @param {number} numPieces 用于末端钳制
 * @returns {Array<{index:number, start:number, end:number}>} start/end 为片内偏移（半开区间）
 */
export function rangesToPieces(offset, length, pieceLength, numPieces) {
  if (pieceLength <= 0) throw new PlayerError('PARSE_ERROR', `非法 pieceLength: ${pieceLength}`);
  if (length <= 0 || offset < 0) return [];
  const first = Math.floor(offset / pieceLength);
  const last = Math.floor((offset + length - 1) / pieceLength);
  const out = [];
  for (let idx = first; idx <= Math.min(last, numPieces - 1); idx++) {
    const pieceStart = idx * pieceLength;
    out.push({
      index: idx,
      start: Math.max(0, offset - pieceStart),
      end: Math.min(pieceLength, offset + length - pieceStart),
    });
  }
  return out;
}

/** 某文件布局下的按序分片计划起点：包含该字节偏移的 piece 序号 */
export function pieceIndexFor(offset, pieceLength) {
  return Math.floor(offset / pieceLength);
}

/**
 * 顺序优先的确定性取片决策：
 *   从 firstIndex 起环绕全表，先正序推进到末尾；可选尾部回绕补齐前段。
 * 同参数多次调用结果逐元素相等（可复现），无随机源、无时钟依赖。
 *
 * @param {{numPieces:number, firstIndex?:number, wrapFirst?:boolean}} spec
 * @returns {number[]} 建议请求顺序的 piece 序号数组
 */
export function planSequentialPieces({ numPieces, firstIndex = 0, wrapFirst = false }) {
  if (!Number.isInteger(numPieces) || numPieces <= 0) {
    throw new PlayerError('PARSE_ERROR', `非法 numPieces: ${numPieces}`);
  }
  const first = ((firstIndex % numPieces) + numPieces) % numPieces;
  const order = [];
  for (let i = first; i < numPieces; i++) order.push(i);
  if (wrapFirst && first > 0) {
    for (let i = 0; i < first; i++) order.push(i); // 头部回绕段放最后（边下边播头部已就绪时仍可补齐校验）
  }
  return wrapFirst ? order : order.concat(first > 0 ? range(0, first) : []);
}

function range(a, b) {
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
