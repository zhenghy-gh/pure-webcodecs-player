/**
 * @player/mov —— QuickTime 兼容层统一出口。
 */
// 本地绑定供 §10 probe/createDemuxer 使用
import { MovDemuxer } from './demuxer.js';
export {
  QT_BRANDS,
  QT_TOP_ATOMS,
  looksLikeQuickTime,
  listTopLevelAtoms,
  detectCompressedMoov,
  parseUdtaTags,
  interpretEdits,
  isTimecodeHandler,
} from './atom-compat.js';
export { MovDemuxer };
// 复用 mp4 的解析/构造/加载器能力，转出口方便上层单点引入
export {
  iterateBoxes,
  parseMoov,
  parseTrak,
  parseSampleEntry,
} from '../../mp4/src/box-parser.js';
export { HttpRangeDataSource } from '../../mp4/src/range-loader.js';

/* ---------------- CONTRACTS §10 模块注册形状 ---------------- */

export const containerName = 'mov';
export const extensions = ['mov'];
export const mimeTypes = ['video/quicktime'];

/** 同步嗅探：命中 ProbeResult，否则 null；禁止抛异常 */
export function probe(bytes) {
  return MovDemuxer.probe(bytes);
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
  if (!head || !MovDemuxer.probe(head)) {
    throw probeFailed('mov: createDemuxer 无法识别该数据源', { containerName });
  }
  const demuxer = new MovDemuxer(src, options);
  return demuxer.open().then(() => demuxer);
}
