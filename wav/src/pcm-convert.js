/**
 * wav/src/pcm-convert.js — PCM 字节 → f32-planar 归一化转换
 * ------------------------------------------------------------
 * 契约 §5.2：管线内唯一 PCM 形态为 f32-planar（每通道一个 Float32Array）。
 * 归一化规则：
 *   u8  → (v - 128) / 128
 *   s16 → v / 32768
 *   s24 → v / 8388608          （小端 3 字节，符号扩展）
 *   s32 → v / 2147483648
 *   f32 → 原值
 */

/**
 * 将整段 PCM 字节转为 f32-planar。
 * @param {Uint8Array} pcmBytes data 子块内的原始字节
 * @param {{formatTag:number, channels:number, bitsPerSample:number}} fmt
 *   formatTag 取 WAVE_FORMAT.PCM / IEEE_FLOAT（EXTENSIBLE 已在头部解析时还原）。
 * @returns {{planar:Float32Array[], frames:number}} 每通道数组与总帧数
 */
import { notSupported, stateError } from './errors.js';

export function convertToFloat32Planar(pcmBytes, fmt) {
  const { formatTag, channels, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample >> 3;
  if (!bytesPerSample) throw stateError(`非法位深 ${bitsPerSample}`);
  const totalFrames = Math.floor(pcmBytes.length / (bytesPerSample * channels));
  const dv = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, totalFrames * bytesPerSample * channels);

  /** @type {Float32Array[]} */
  const planar = [];
  for (let c = 0; c < channels; c++) planar.push(new Float32Array(totalFrames));

  switch (`${formatTag}:${bitsPerSample}`) {
    case '1:8': { // u8
      for (let i = 0; i < totalFrames; i++) {
        for (let c = 0; c < channels; c++) {
          planar[c][i] = (dv.getUint8(i * channels + c) - 128) / 128;
        }
      }
      break;
    }
    case '1:16': { // s16 小端
      for (let i = 0; i < totalFrames; i++) {
        for (let c = 0; c < channels; c++) {
          planar[c][i] = dv.getInt16((i * channels + c) * 2, true) / 32768;
        }
      }
      break;
    }
    case '1:24': { // s24 小端：3 字节拼装 + 符号扩展
      for (let i = 0; i < totalFrames; i++) {
        for (let c = 0; c < channels; c++) {
          const o = (i * channels + c) * 3;
          let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
          if (v & 0x800000) v |= ~0xFFFFFF; // 符号位扩展到 32 位
          planar[c][i] = v / 8388608;
        }
      }
      break;
    }
    case '1:32': { // s32 小端
      for (let i = 0; i < totalFrames; i++) {
        for (let c = 0; c < channels; c++) {
          planar[c][i] = dv.getInt32((i * channels + c) * 4, true) / 2147483648;
        }
      }
      break;
    }
    case '3:32': { // IEEE float32 小端；NaN/±Inf 钳制为 0，禁止直通音频图
      for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < channels; ch++) {
          const v = dv.getFloat32((i * channels + ch) * 4, true);
          planar[ch][i] = Number.isFinite(v) ? v : 0;
        }
      }
      break;
    }
    default:
      throw notSupported(`不支持的 PCM 组合 format=${formatTag} bits=${bitsPerSample}`);
  }
  return { planar, frames: totalFrames };
}

/**
 * 从整段 planar 数据中切出 [startFrame, endFrame) 的连续 interleaved 字节区间
 * 对应的 planar 视图（零拷贝 subarray，供 seek 后预填充 worklet 环形缓冲）。
 * @param {Float32Array[]} planar
 * @param {number} startFrame
 * @param {number} endFrame
 * @returns {Float32Array[]}
 */
export function sliceFrames(planar, startFrame, endFrame) {
  const a = Math.max(0, Math.min(startFrame, planar[0].length));
  const b = Math.max(a, Math.min(endFrame, planar[0].length));
  return planar.map((ch) => ch.subarray(a, b));
}
