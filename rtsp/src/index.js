/**
 * @player/rtsp —— WebSocket 中继 RTSP 播放器客户端（纯 ESM，零依赖）。
 *
 * 快速使用：
 *   import { RtspWsClient } from './index.js';
 *   const c = new RtspWsClient({ url: 'ws://127.0.0.1:8322/rtsp' });
 *   c.on('frame', f => render(f));   // f.annexB 可直接喂 WebCodecs/MSE
 *   c.start();
 */

export { parseSdp, parseFmtpParams, b64ListToNals, pickVideoTrack } from './sdp.js';
export { parseRtp, RtpPacket, seqNewer } from './rtp.js';
export { toAnnexb, fromAnnexb, avccToNals, nalsToAvcc, h264IsKeyframe, h265IsKeyframe } from './nal.js';
export { H264Depacketizer } from './depacketize-h264.js';
export { H265Depacketizer } from './depacketize-h265.js';
export { InterleavedWireParser, splitBareRtpMessage, parseResponse } from './framing.js';
export { RtspWsClient, Backoff, STATES } from './client.js';
export { createSource, RtspChunkSource } from './source.js';
export { PlayerError, errors } from './errors.js';

/** §10 传输层能力自述（site 汇总页/注册表消费） */
export const transportName = 'rtsp';
export const capabilities = {
  bridging: 'websocket-relay',
  framings: ['interleaved', 'rtp'],
  codecs: ['h264', 'h265'],
  live: true,
  seekable: false,
  notes: '浏览器无 TCP/UDP API，RTSP 必须 WebSocket 中继（见 docs/00-需求与可行性结论.md）',
};
