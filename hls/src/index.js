/**
 * index.js —— hls 模块入口
 *
 * 纯 ESM，零构建。浏览器直接 import，Node 下解析层可独立单测。
 *
 * @example 浏览器快速使用
 *   import { HlsPlayer } from './hls/src/index.js'
 *   const player = new HlsPlayer({ lowLatencyMode: false })
 *   player.on('error', e => console.error(e))
 *   await player.attach('https://example.com/master.m3u8', document.querySelector('video'))
 */

export { parseMaster, parseMedia, parsePlaylist, detectPlaylistType } from './m3u8-parser.js';
export { SegmentLoader, LoadError } from './segment-loader.js';
export { LevelController } from './level-controller.js';
export { MseController } from './mse-controller.js';
export {
  Transmuxer,
  sniffContainer,
  TsToFmp4Transmuxer,
} from './transmuxer.js';
export { TsToFmp4Transmuxer as Fmp4Remuxer, buildEsds } from './fmp4-muxer.js';
export {
  Aes128Decrypter,
  ivFromMediaSequence,
  looksLikePlaintext,
} from './decrypter.js';
export { aesCbcDecryptNoPadding, stripPkcs7, expandKey128 } from './aes-cbc.js';
export {
  computeResumeIndexBySn,
  computeResumeIndexByTimeUs,
  enableLog,
  logger,
  resolveUrl,
  parseAttributes,
  parseByteRange,
  hexToUint8,
  EwmaBandwidthEstimator,
  EventBus,
  splitCodecs,
  buildMime,
} from './utils.js';
export { HlsPlayer, PlayerState } from './player.js';
export {
  createHlsSource,
  HlsChunkSource,
} from './data-source.js';
