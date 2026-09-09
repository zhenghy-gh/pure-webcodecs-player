#!/usr/bin/env node
/**
 * mock-rtsp-relay.js —— E-11 约定的 rtsp-ws 模拟中继入口（qa/SM-5 冒烟用）。
 *
 * 权威实现见 src/server-rtsp.js；本脚本仅是薄启动壳：
 *   node samples/gateway/mock-rtsp-relay.js [--port 8322]
 *
 * 连接地址：
 *   interleaved : ws://127.0.0.1:<port>/rtsp（完整 RTSP 握手 + $ 块媒体）
 *   纯 RTP      : ws://127.0.0.1:<port>/rtp?mode=passive
 *   SDP         : http://127.0.0.1:<port>/sdp
 */

import { createRtspWsRelay } from './src/server-rtsp.js';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(argValue('--port', process.env.PORT || '8322'));
const server = createRtspWsRelay({ host: argValue('--host', '127.0.0.1'), port });

console.log(`[mock-rtsp-relay] ws://127.0.0.1:${port}/rtsp 就绪（interleaved | /rtp?mode=passive | GET /sdp）`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
