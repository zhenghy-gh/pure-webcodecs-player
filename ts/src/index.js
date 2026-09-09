/**
 * index.js —— ts 模块统一出口（CONTRACTS v0.2 §10 注册形状）
 *
 * 契约导出：
 *   containerName / extensions / mimeTypes / probe / createDemuxer / TsDemuxer
 * 另导出解析内核与工具函数（psi/pes/nalu/aac/bits），供 hls/ 等上层复用。
 */

export { TsStreamEngine } from './ts-stream-engine.js';
import { TsDemuxer as _TsDemuxer, createTsDemuxer as _createTsDemuxer } from './ts-demuxer.js';

/* ------------------------------ §10 注册形状 ------------------------------ */

/** 容器名（§1.3 枚举） */
export const containerName = 'ts';

/** 支持的小写扩展名 */
export const extensions = ['ts', 'mts', 'm2ts'];

/** 标准 MIME */
export const mimeTypes = ['video/mp2t', 'video/mp2t;streams=avc'];

/**
 * 同步嗅探（§10：命中 ProbeResult（confidence≥0.8 视为命中），否则 null；禁止抛异常）。
 */
export function probe(bytes) {
  try {
    return _TsDemuxer.probe(bytes);
  } catch {
    return null;
  }
}

/**
 * 工厂（§10）：接受 url|Uint8Array|ArrayBuffer|File|Blob|DataSource|ChunkSource，
 * 内部完成构造+attach+open，resolve 已 ready 的 TsDemuxer；
 * 识别失败 reject PlayerError('PROBE_FAILED')。
 */
export async function createDemuxer(source, options) {
  return _createTsDemuxer(source, options);
}

/** 主类再导出（契约 §10） */
export const TsDemuxer = _TsDemuxer;
export { _createTsDemuxer as createTsDemuxer };

/* ------------------------------ 可复用工具 ------------------------------ */

// PSI
export { mpegCrc32, PsiAssembler, parsePAT, parsePMT, STREAM_TYPE_MAP } from './psi.js';
// PES
export {
  decodeTimestamp5, encodeTimestamp5, parsePESHeader, isVideoStreamId, isAudioStreamId,
} from './pes.js';
// 位流
export { BitReader, BitWriter, unwrapTimestamp } from './bits.js';
// NALU
export {
  findStartCode, splitAnnexB, classify, nalusToAnnexB,
  annexbToAvcc,
  buildAvcc, buildHvcc,
  parseH264SpsDimensions, parseHevcSpsDimensions,
  h264NalType, hevcNalType, H264_NAL_TYPES, HEVC_NAL_TYPES,
} from './nalu.js';
// AAC
export {
  parseAdtsHeader, splitAdtsFrames, parseLatmSyncStream, splitLatmUnits,
  buildAudioSpecificConfig, parseAudioSpecificConfig, AAC_SAMPLE_RATES,
} from './aac.js';
