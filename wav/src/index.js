/**
 * wav/src/index.js — WAV 模块唯一入口（具名导出，契约 §0.4）
 *
 * 能力总览：
 *   解析层：WavDemuxer（probe/parseInit/samples/seek/stop）、parseWavHeader
 *   转换层：convertToFloat32Planar / sliceFrames
 *   播放层：createWavPlayer 工厂（Node 下返回 null，不抛异常）
 *   波形层：computePeaks / drawWaveform
 */
import { WavPlayer, isWavPlaybackSupported } from './player.js';
import { WavDemuxer } from './demuxer.js';
import { probeFailed } from './errors.js';
export { probeFailed };

export { WavDemuxer } from './demuxer.js';
export { parseWavHeader, waveCodecString, WAVE_FORMAT } from './riff-parser.js';
export { convertToFloat32Planar, sliceFrames } from './pcm-convert.js';
export { computePeaks, drawWaveform } from './waveform.js';
export { WORKLET_NAME, WORKLET_SOURCE } from './worklet-processor.js';
export { WavPlayer, isWavPlaybackSupported } from './player.js';
export { PlayerError, ErrorCode } from './errors.js';

/* ---- CONTRACTS v0.2 §10 模块注册形状 ---- */
export const containerName = 'wav';
export const extensions = ['wav', 'wave'];
export const mimeTypes = ['audio/wav', 'audio/x-wav', 'audio/vnd.wave'];

/** 同步嗅探（§10：命中 ProbeResult，否则 null；禁止抛异常） */
export function probe(bytes) {
  return WavDemuxer.probe(bytes);
}

/** 工厂：DataSource → 构造 + open，resolve 已就绪的 WavDemuxer；
 *  嗅探失败 reject PlayerError('PROBE_FAILED')。 */
export async function createDemuxer(source, options) {
  const size = source?.size ?? 4096;
  const head = await source.read(0, Math.min(4096, size));
  if (!WavDemuxer.probe(head)) {
    throw probeFailed('WAV 嗅探未命中：文件头缺少 RIFF/WAVE 骨架');
  }
  const demuxer = new WavDemuxer(source, options);
  await demuxer.open();
  return demuxer;
}

/**
 * 浏览器专属工厂：环境不支持 WebAudio/AudioWorklet 时返回 null
 * （契约 §0.3：Node 下返回「不支持」，不允许抛异常）。
 * @returns {import('./player.js').WavPlayer|null}
 */
export function createWavPlayer() {
  if (!isWavPlaybackSupported()) return null;
  return new WavPlayer();
}
