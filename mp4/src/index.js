/**
 * @player/mp4 —— ISO-BMFF 容器模块统一出口。
 */
import { Mp4Demuxer } from './demuxer.js';
export * from './box-parser.js';
export * from './box-builder.js';
export { Mp4Demuxer, expandSampleTable, parseMoofTracks } from './demuxer.js';
export {
  Fmp4Remuxer,
  batchSamplesByGop,
  remuxDemuxer,
} from './remuxer.js';
export {
  Mp4WebCodecsPipeline,
  buildVideoConfig,
  buildAudioConfig,
} from './webcodecs-pipeline.js';
export { HttpRangeDataSource } from './range-loader.js';
export { attachFileDrop, pickFile } from './file-source.js';

/* ---------------- CONTRACTS §10 模块注册形状 ---------------- */

export const containerName = 'mp4';
export const extensions = ['mp4', 'm4v'];
export const mimeTypes = ['video/mp4', 'audio/mp4'];

/** 同步嗅探：命中 ProbeResult（confidence≥0.8），否则 null；禁止抛异常 */
export function probe(bytes) {
  return Mp4Demuxer.probe(bytes);
}

/** 工厂：DataSource 直入，构造 + open 一体化；识别失败 reject PROBE_FAILED */
export async function createDemuxer(source, options = {}) {
  const { MemoryDataSource, probeFailed } = await import('../../core/src/index.js');
  const src = source instanceof Uint8Array || source instanceof ArrayBuffer
    ? new MemoryDataSource(source)
    : source;
  let head = null;
  try {
    const size = typeof src.size === 'number' ? src.size : null;
    head = await src.read(0, size === null ? 64 : Math.min(64, size));
  } catch {
    head = null;
  }
  if (!head || !Mp4Demuxer.probe(head)) {
    throw probeFailed('mp4: createDemuxer 无法识别该数据源', { containerName });
  }
  const demuxer = new Mp4Demuxer(src, options);
  return demuxer.open().then(() => demuxer);
}
