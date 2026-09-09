/**
 * mkv —— 浏览器 MKV/WebM 播放器（EBML 解析 + Matroska Demux）
 *
 * 纯 ESM、零构建；浏览器与 Node ≥22 通用。
 * 公开面逐字对齐 docs/CONTRACTS.md v0.2：
 *   §10 注册形状（containerName/extensions/mimeTypes/probe/createDemuxer/MkvDemuxer）
 *   §1  数据形状（Sample/Track/MediaInfo/ProbeResult，µs 整数时间基，description 定稿名）
 *   §2.2 方法名（open/readSample/samples/seek/destroy + metadata 属性）
 *
 * 内部工具层（ebml/lacing/codecs/source）一并具名导出供测试与复用。
 */

import { PlayerError } from '../../core/src/errors.js';

// ── 契约注册形状（§10）───────────────────────────────────

export const containerName = 'mkv';
/** 小写扩展名，无点（含 WebM 家族：DocType=webm 同属本模块解析域） */
export const extensions = ['mkv', 'mk3d', 'mka', 'mks', 'webm'];
export const mimeTypes = [
  'video/x-matroska',
  'audio/x-matroska',
  'video/webm',
  'audio/webm',
];

/**
 * 同步嗅探（契约：命中 ProbeResult(confidence≥0.8)，否则 null；禁止抛异常）。
 * @param {Uint8Array} bytes 建议 4KiB 文件头
 */
export function probe(bytes) {
  return MkvDemuxer.probe(bytes);
}

/**
 * 工厂：接受 url|string|File|Blob|Uint8Array|ArrayBuffer|DataSource，
 * 内部完成 探测→构造→open()；识别失败 reject PlayerError('PROBE_FAILED')。
 * @returns {Promise<MkvDemuxer>} 已 ready 的 demuxer
 */
export async function createDemuxer(source, options) {
  const { createByteSource } = await import('./source.js');
  let src;
  try {
    src = createByteSource(source, options);
  } catch (err) {
    throw new PlayerError('SOURCE_ERROR', `无法构造数据源: ${err?.message ?? err}`);
  }
  // 先嗅探前 64B（URL 源惰性探测后读取）
  const head = await src.read(0, 64);
  const hit = probe(head);
  if (!hit || hit.confidence < 0.8) {
    src.close?.();
    throw new PlayerError('PROBE_FAILED', `非 Matroska/WebM 内容（confidence=${hit?.confidence ?? 0}）`);
  }
  const d = new MkvDemuxer(src, options);
  await d.open();
  return d;
}

// ── 主类与内部实现导出 ──────────────────────────────────

import { MkvDemuxer } from './demuxer.js';
export { MkvDemuxer };
export { BufferSource, BlobSource, FetchSource, createByteSource, SourceError } from './source.js';

// EBML 基础层
export {
  EbmlError,
  vintLength, readId, readSize, encodeSize, encodeUnknownSize, encodeId,
  readUInt, readInt, readFloat, readDate, readString, decodeValueByType,
  iterElements, findElement, childrenOf, parseTree,
  EbmlWriter, encodeUIntPayload, encodeIntPayload, encodeFloatPayload, asciiBytes,
} from './ebml.js';
export { TYPE, ID, SCHEMA, TRACK_TYPE_NAME } from './schema.js';
export {
  CODEC_TABLE, normalizeCodec,
  avccToCodecString, hevcToCodecString, parseAacAsc, parseOpusHead, parseFlacStreaminfo,
} from './codecs.js';
export {
  LACING_NONE, LACING_XIPH, LACING_FIXED, LACING_EBML,
  decodeLacing, signedVintValue, encodeSignedVint,
  encodeXiphHeader, encodeEbmlLacingHeader,
} from './lacing.js';

export const VERSION = '0.2.0';

