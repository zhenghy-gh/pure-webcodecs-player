/**
 * index.js —— flv 模块统一出口（CONTRACTS v0.2 §10 注册形状）
 *
 * 定位：FLV 解析地基 + 薄播放壳（rtmp/WebSocket-FLV 桥接的必选依赖）。
 * 生产场景请使用 flv.js——本模块价值在解析器本身与契约参考实现。
 */

import { FlvDemuxer as _FlvDemuxer, createFlvDemuxer as _createFlvDemuxer } from './flv-demuxer.js';

/* ------------------------------ §10 注册形状 ------------------------------ */

export const containerName = 'flv';
export const extensions = ['flv'];
export const mimeTypes = ['video/x-flv', 'video/flv', 'flv-application/octet-stream'];

/** 同步嗅探（§10）：命中 ProbeResult，否则 null；禁止抛异常 */
export function probe(bytes) {
  try {
    return _FlvDemuxer.probe(bytes);
  } catch {
    return null;
  }
}

/** 工厂（§10）：url|File|Blob|DataSource|ChunkSource → 已 ready 的 FlvDemuxer */
export async function createDemuxer(source, options) {
  return _createFlvDemuxer(source, options);
}

/** 主类再导出（契约 §10） */
export const FlvDemuxer = _FlvDemuxer;
export { _createFlvDemuxer as createFlvDemuxer };

/* ------------------------------ 其余公共件 ------------------------------ */

export { FlvParser } from './flv-parser.js';
/* —— 低层遍历接口（供 rtmp/WebSocket-FLV 模块直接 import 复用）—— */
export {
  parseFlvHeader, FlvTagStream, iterateTags,
  FLV_TAG_AUDIO, FLV_TAG_VIDEO, FLV_TAG_SCRIPT,
} from './tag-stream.js';
export { FlvRemuxer, VIDEO_TRACK_ID, AUDIO_TRACK_ID } from './fmp4-remuxer.js';
export { decodeAmf0, decodeAmf0All, encodeAmf0, encodeScriptPair } from './amf0.js';
export {
  parseAvcConfig, parseHevcConfig, parseAscInfo,
  parseH264SpsDimensions, parseHevcSpsDimensions,
} from './codec-info.js';
export * from './iso-bmff.js';
