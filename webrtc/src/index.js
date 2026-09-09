/**
 * index.js —— webrtc 模块统一出口
 *
 * 定位（契约 §2.5/§6）：传输接入层——只做信令抽象 + 播放端，
 * 媒体走 RTCPeerConnection 原生管线直达 <video>/<audio>，不产 Sample。
 */

export const containerName = 'webrtc';
export const extensions = [];
export const mimeTypes = [];

export {
  parseSdp,
  parseCandidateLine,
  summarizeSdp,
} from './sdp-utils.js';

export {
  WhepSignal,
  WebSocketSignal,
  createSignalChannel,
} from './signaling.js';
export { createMockSignalChannel, createLoopbackSignalPair } from './mock-signaling.js';

export {
  WebRtcPlayer,
  WebRtcState,
  computeBackoffMs,
  parsePlayerUrl,
} from './player.js';

export { extractMetrics, StatsCollector } from './stats.js';

/**
 * 工厂（契约 §10 同形替换）：createSource 对传输层语义为"建立收流会话"，
 * 返回 {stream, stats, destroy}；不导出 demuxer。
 */
export async function createSource(url, options = {}) {
  const player = new WebRtcPlayer(options);
  await player.play(url, options.elements || {});
  return {
    get stream() {
      return player.stream;
    },
    get stats() {
      return player.stats;
    },
    destroy: () => player.destroy(),
  };
}
