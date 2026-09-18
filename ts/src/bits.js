/**
 * bits.js —— 大端位流读取器 / 写入器与 TS 时间戳解回绕
 *
 * 按位读写统一收敛到 core（audit-79 D：BitReader×4 / BitWriter×2 收敛），
 * 本模块仅保留 MPEG-TS 专属的 33bit 时间戳解回绕工具。
 */

export { BitReader, BitWriter } from '../../core/src/bit-reader.js';

/**
 * MPEG-TS 时间戳（33bit）解回绕：检测向前/向后跳变并折叠到连续时间轴。
 * PTS/DTS 每 2^33 (~26.5h @90kHz) 回绕一次。
 * @param {number} value 当前原始 tick
 * @param {number|null} lastValue 上一次已解绕 tick
 * @returns {number} 连续化后的 tick
 */
export function unwrapTimestamp(value, lastValue) {
  if (lastValue == null) return value;
  const WRAP = 2 ** 33;
  const HALF = 2 ** 32;
  let delta = value - (lastValue % WRAP);
  if (delta > HALF) delta -= WRAP;      // 刚发生回绕：当前值实际在下一圈
  else if (delta < -HALF) delta += WRAP; // 上次值已在下一圈而当前值回到本圈
  return lastValue + delta;
}
