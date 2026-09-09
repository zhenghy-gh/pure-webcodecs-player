/**
 * @player/rtmp —— WebSocket-FLV（RTMP 桥接形态）播放器客户端。
 *
 * 契约形状（CONTRACTS §10）：传输层导出 createSource(...)；另提供完整播放器
 * WsFlvPlayer 与 URL 映射工具。不导出 demuxer（FLV 解析由 flv/ 模块负责，
 * 本模块内置的 FlvDemuxer 为传输联调自含实现，接口与 flv/ 适配壳对齐）。
 */

export { resolveSourceUrl, parseWsFlvUrl, mapRtmpToGateway, isWebSocketUrl } from './url.js';
export { GatewayChunkSource, createSource } from './gateway-source.js';
export { FlvDemuxer, avcCodecString, parseAudioSpecificConfig } from './flv-demuxer.js';
export { Fmp4Remuxer, esdsFromAsc } from './mp4-mux.js';
export { WsFlvPlayer, PLAYER_STATES } from './player.js';
export { PlayerError, errors } from './errors.js';
export { Backoff } from './backoff.js';

/** §10 传输层能力自述 */
export const transportName = 'rtmp';
export const capabilities = {
  bridging: 'websocket-flv',
  urlSchemes: ['ws-flv', 'wss-flv', 'ws', 'wss', 'rtmp→gateway', 'rtmps→gateway'],
  codecs: ['h264', 'aac'],
  live: true,
  seekable: false,
  notes: '浏览器无 TCP API，RTMP 必须经 WebSocket-FLV 网关桥接（见 docs/00-需求与可行性结论.md）',
};
