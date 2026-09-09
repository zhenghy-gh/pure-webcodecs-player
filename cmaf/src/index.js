/**
 * index.js —— cmaf 模块统一出口
 *
 * 定位（契约 §2.5 / §6）：CMAF 低延迟方向。
 *  - chunked CMAF track 解析（ISO-BMFF 最小遍历件，待 core isobmff-* 沉淀后迁移）；
 *  - LL-HLS part 加载策略骨架（纯逻辑，供 hls/ 与统一内核驱动）；
 *  - WebCodecs 直解路线（VideoDecoder/AudioDecoder 配置推导 + 直解骨架）。
 */

// —— 契约 §10 模块注册形状（cmaf 属容器模块）——
export const containerName = 'cmaf';
export const extensions = ['cmf1', 'cmfa', 'cmfv', 'mp4'];
export const mimeTypes = ['video/iso.segment', 'application/vnd.apple.mpegurl'];

export { probe } from './chunk-parser.js';

export {
  iterateBoxes,
  readBoxHeader,
  boxType,
  parseTrun,
  parseTfdt,
  parseTfhd,
  parseMfhd,
  parseMoof,
  parseSidx,
  parsePrft,
  isKeyframeFlag,
  findVideoDecoderConfig,
  findAudioSpecificConfig,
} from './isobmff.js';

export {
  splitChunks,
  parseInitSegment,
  probe as probeCmaf,
} from './chunk-parser.js';

export {
  PartTimeline,
  PartState,
  buildBlockingReloadUrl,
  nextPollTarget,
  shouldPrefetchPreloadHint,
} from './llhls-parts.js';

export {
  CmafWebCodecsPlayer,
  decoderConfigsFromInit,
  codecStringFromAvcC,
  codecStringFromAsc,
} from './webcodecs.js';
