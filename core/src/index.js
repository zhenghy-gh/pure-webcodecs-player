/**
 * @player/core —— 公共内核统一出口（CONTRACTS v0.2 L0 基座）。
 *
 * 分层导出（供各容器模块与播放器内核按需 import）：
 *  - 类型与契约：types / demuxer / data-source
 *  - 位流原语：byte-stream / bit-reader / exp-golomb / nal
 *  - 编解码描述：codec-string（§3 唯一生成收敛点）
 *  - 能力探测与路线裁决：capabilities
 *  - 输出端：mse-helper / video-frame-renderer / audio-worklet-player
 *  - 播放控制：clock / stats
 *  - 基础设施：emitter / errors
 */
export * from './errors.js';
export { raceAbort, throwIfAborted } from './abort.js';
export { Emitter } from './emitter.js';
export * from './types.js';
export {
  ByteStream,
  ByteWriter,
} from './byte-stream.js';
export { BitReader } from './bit-reader.js';
export {
  ExpGolombReader,
  parseH264Sps,
  stripEmulationPrevention,
} from './exp-golomb.js';
export * from './nal.js';
export {
  buildAvcCodecString,
  buildHevcCodecString,
  aacCodecString,
  h264CodecStringFromSps,
  hevcCodecStringFromHvcC,
  aacCodecStringFromAsc,
  fallbackCodecString,
  parseCodecString,
  mseIsTypeSupported,
  buildMseMimeType,
} from './codec-string.js';
export {
  hasWebCodecs,
  hasMSE,
  hasManagedMediaSource,
  hasAudioWorklet,
  hasWebGPU,
  hasCryptoSubtle,
  detectCapabilities,
  resetCapabilityCache,
  canDecodeVideo,
  canDecodeAudio,
  chooseRoute,
  detectCapabilitiesLegacy,
} from './capabilities.js';
export { Demuxer, DEMUXER_STATES } from './demuxer.js';
export {
  registerDemuxer,
  unregisterDemuxer,
  resetRegistry,
  listRegistered,
  probeBuffer,
  createDemuxerAuto,
  detectFromUrl,
} from './registry.js';
export {
  MemoryDataSource,
  BlobDataSource,
  asDataSource,
  ChunkBuffer,
} from './data-source.js';
export { HttpRangeDataSource } from './http-range-source.js';
export {
  FETCH_PROTOCOLS,
  WS_PROTOCOLS,
  IMPORT_PROTOCOLS,
  parseUrl,
  urlProtocol,
  isSafeUrl,
  assertSafeUrl,
  assertSafeWsUrl,
  assertSafeImportUrl,
} from './url-guard.js';
export {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_MOOV_BYTES,
  DEFAULT_MAX_SAMPLE_BYTES,
  DEFAULT_MAX_SMALL_RESOURCE_BYTES,
  DEFAULT_MAX_SCAN_BYTES,
  assertByteLength,
  clampReadLength,
  BoundedMapCache,
} from './limits.js';
export { MseHelper, mseMonotonicTime } from './mse-helper.js';
export { VideoFrameRenderer, createVideoRenderer } from './video-frame-renderer.js';
export {
  AudioWorkletPlayer,
  createAudioOutput,
  PCM_WORKLET_CODE,
  AUDIO_SINK_PROCESSOR_NAME,
  createWorkletUrl,
} from './audio-worklet-player.js';
export {
  PlaybackClock,
  AvSyncController,
  DEFAULT_SYNC_OPTIONS,
} from './clock.js';
export { Stats } from './stats.js';
export { Player, createPlayer, PLAYER_STATES } from './player.js';
export {
  WebCodecsPipeline,
  webcodecsPipelineFactory,
  audioDataToPlanar,
} from './pipeline-webcodecs.js';
export {
  MsePipeline,
  msePipelineFactory,
} from './pipeline-mse.js';
export {
  LogLevel,
  setLogLevel,
  logBytes,
  createLogger,
} from './logger.js';
