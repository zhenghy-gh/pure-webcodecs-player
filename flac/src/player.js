/**
 * flac/src/player.js — FLAC 高层播放器（复用 wav 模块的 worklet 管线）
 * ------------------------------------------------------------
 * 解码主路径（任务书 T16）：WebAudio `decodeAudioData`（浏览器原生 FLAC
 *   解码，Chrome/Firefox/Safari 现代版本均支持）→ AudioBuffer → f32-planar。
 * 回退路径：纯 JS 参考解码器 FlacDecoder（本模块 src/，覆盖四类子帧全谱），
 *   在 decodeAudioData 拒绝（老浏览器/畸形流）时自动接管；另可按 README
 *   声明替换为 WASM libflac 增强。
 * 终点：f32 WAV 内存封装 → wav 模块 WavPlayer（AudioWorklet 调度全继承）。
 * 跨目录相对导入 '../../wav/src/player.js' 符合契约 §6.2。
 *
 * 说明：「解码全部再播」，适合演示与中等长度曲目；边解边推的流式管线
 * 在 M3 由 core player 统一编排。
 */
import { FlacDecoder } from './decoder.js';
import { parseMetadata } from './metadata.js';
import { findSync } from './frame-header.js';
import { isWavPlaybackSupported, WavPlayer } from '../../wav/src/player.js';

/** 浏览器能力探测：Node 下恒 false */
export function isFlacPlaybackSupported() {
  return isWavPlaybackSupported();
}

/**
 * 浏览器专属工厂：不支持环境返回 null（契约 §0.3）。
 * @returns {WavPlayer|null} 对外协议与 WavPlayer 完全一致
 */
export function createFlacPlayer() {
  if (!isFlacPlaybackSupported()) return null;
  return new WavPlayer();
}

/**
 * 智能装载（推荐入口）：主路径 decodeAudioData，失败回退纯 JS 解码器。
 * @param {WavPlayer} player createFlacPlayer() 产物
 * @param {Uint8Array} flacBytes 完整 FLAC 文件字节
 * @returns {Promise<{via:'decode-audio-data'|'js-decoder-fallback',
 *           sampleRate:number, channels:number, totalSamples:number,
 *           tags:Record<string,string>>}}
 */
export async function loadFlacSmart(player, flacBytes) {
  // ① 主路径：浏览器原生解码
  const AC = /** @type {any} */ (globalThis).AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
  if (typeof AC === 'function') {
    try {
      const ctx = new AC();
      // decodeAudioData 会分离 buffer，传拷贝避免锁定调用方数据
      const buf = await ctx.decodeAudioData(flacBytes.slice().buffer);
      await ctx.close();
      player.load(encodeF32PlanarToWavBytes(audioBufferToPlanar(buf), buf.sampleRate));
      return {
        via: 'decode-audio-data', sampleRate: buf.sampleRate,
        channels: buf.numberOfChannels, totalSamples: buf.length, tags: parseTagsSafe(flacBytes),
      };
    } catch { /* 原生不支持/数据异常 → 回退 */ }
  }
  // ② 回退：纯 JS 参考解码器
  const r = decodeFlacToPlayable(flacBytes);
  player.load(r.wavBytes);
  return { via: 'js-decoder-fallback', sampleRate: r.sampleRate, channels: r.channels, totalSamples: r.totalSamples, tags: r.tags };
}

/** AudioBuffer → f32-planar（getChannelData 视图直接复用，零拷贝） */
function audioBufferToPlanar(buf) {
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(new Float32Array(buf.getChannelData(c)));
  return out;
}

/** 仅提取 VORBIS_COMMENT 标签（主路径下不做整段元数据解析） */
function parseTagsSafe(bytes) {
  try { return { ...parseMetadata(bytes).tags }; } catch { return {}; }
}

/**
 * 解码整个 FLAC 文件并封装为内存中的 f32 WAV 字节，
 * 可直接交给 createFlacPlayer() 返回的播放器 load()。
 * @param {Uint8Array} flacBytes
 * @returns {{wavBytes:Uint8Array, sampleRate:number, channels:number,
 *           totalSamples:number, tags:Record<string,string>}}
 */
export function decodeFlacToPlayable(flacBytes) {
  const meta = parseMetadata(flacBytes);
  const si = meta.streamInfo;
  const decoder = new FlacDecoder({
    sampleRate: si.sampleRate, channels: si.channels, bitsPerSample: si.bitsPerSample,
  });

  /** 交错整数样本块列表 */
  /** @type {Int32Array[]} */
  const blocks = [];
  let totalSamples = 0;
  let pos = meta.audioOffset;
  while (pos < flacBytes.length - 2) {
    try {
      pos = findSync(flacBytes, pos);
      if (pos < 0) break;
      const frame = decoder.decodeFrame(flacBytes, pos);
      const n = frame.blockSize;
      const chs = frame.channelsCount;
      const inter = new Int32Array(n * chs);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < chs; c++) inter[i * chs + c] = frame.channels[c][i];
      }
      blocks.push(inter);
      totalSamples += n;
      pos = frame.endByte;
    } catch {
      pos++; // 损坏帧 → 向后重同步
    }
  }

  // 交错块 → planar f32 归一化
  const channels = Math.max(1, si.channels);
  const peakScale = 2 ** (si.bitsPerSample - 1);
  const planar = [];
  for (let c = 0; c < channels; c++) planar.push(new Float32Array(totalSamples));
  let w = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i += channels) {
      for (let c = 0; c < channels; c++) planar[c][w] = b[i + c] / peakScale;
      w++;
    }
  }

  return {
    wavBytes: encodeF32PlanarToWavBytes(planar, si.sampleRate),
    sampleRate: si.sampleRate,
    channels,
    totalSamples,
    tags: { ...meta.tags },
  };
}

/**
 * 把 f32-planar 封装为内存 WAV（IEEE float 32 位格式）。
 * 仅用于进程内交接，不落盘。
 * @param {Float32Array[]} planar
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeF32PlanarToWavBytes(planar, sampleRate) {
  const ch = planar.length;
  const frames = planar[0].length;
  const dataBytes = frames * ch * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const dv = new DataView(bytes.buffer);

  const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); dv.setUint32(4, bytes.length - 8, true); w4(8, 'WAVE');
  w4(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);              // IEEE float
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * 4, true);
  dv.setUint16(32, ch * 4, true);
  dv.setUint16(34, 32, true);
  w4(36, 'data'); dv.setUint32(40, dataBytes, true);

  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) { dv.setFloat32(p, planar[c][i], true); p += 4; }
  }
  return bytes;
}
