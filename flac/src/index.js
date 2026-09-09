/**
 * flac/src/index.js — FLAC 模块唯一入口（具名导出，契约 §0.4）
 *
 * 能力总览：
 *   解析层：FlacDemuxer / parseMetadata（STREAMINFO·SEEKTABLE·VORBIS COMMENT·PICTURE…）
 *   解码层：FlacDecoder + 子帧解码器 —— JS 参考实现，
 *           覆盖 CONSTANT / VERBATIM / FIXED(0~4) / LPC(1~32) + Rice 残差全分区
 *           与 left-side / right-side / mid-side 立体声还原。
 *   播放层：createFlacPlayer 工厂（复用 wav worklet 管线；Node 返回 null）
 *   工具层：BitReader/BitWriter、CRC-8/CRC-16
 */
import { probeFailed } from './errors.js';

import { FlacDemuxer } from './demuxer.js';
export { FlacDemuxer };
export { parseMetadata, BLOCK_TYPE } from './metadata.js';
export { FlacDecoder } from './decoder.js';
export { decodeSubframe, restoreStereo, SUBFRAME_TYPE } from './subframe.js';
export { parseFrameHeader, findSync, FRAME_SYNC, CHANNEL_MODE } from './frame-header.js';
export { BitReader, BitWriter } from './bit-reader.js';
export { crc8, crc16 } from './crc.js';
export { createFlacPlayer, isFlacPlaybackSupported, decodeFlacToPlayable, encodeF32PlanarToWavBytes, loadFlacSmart } from './player.js';
export { PlayerError, ErrorCode } from './errors.js';

/* ---- CONTRACTS v0.2 §10 模块注册形状 ---- */
export const containerName = 'flac';
export const extensions = ['flac'];
export const mimeTypes = ['audio/flac', 'audio/x-flac'];

/** 同步嗅探（§10：命中 ProbeResult，否则 null；禁止抛异常） */
export function probe(bytes) {
  return FlacDemuxer.probe(bytes);
}

/** 工厂：DataSource → 构造 + open，resolve 已就绪的 FlacDemuxer；
 *  嗅探失败 reject PlayerError('PROBE_FAILED')。 */
export async function createDemuxer(source, options) {
  const size = source?.size ?? 4096;
  const head = await source.read(0, Math.min(4096, size));
  if (!FlacDemuxer.probe(head)) {
    throw probeFailed('FLAC 嗅探未命中：文件头缺少 fLaC 魔数');
  }
  const demuxer = new FlacDemuxer(source, options);
  await demuxer.open();
  return demuxer;
}
