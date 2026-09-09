#!/usr/bin/env node
/**
 * 本地联调网关 CLI（samples/gateway = 全仓唯一权威实现，见 CONTRACTS §9 / 终裁#3）。
 *
 *   node bin/gateway.js [--host 127.0.0.1]
 *                       [--wsflv-port 8321] [--rtsp-port 8322] [--relay-port 8090]
 *
 * 环境变量兼容 scripts/gateway.mjs：PORT=<n> 等价 --relay-port <n>。
 *
 * 启动后：
 *   ws-flv 网关     ws://127.0.0.1:8321/live/test
 *   rtsp-ws 中继    ws://127.0.0.1:8322/rtsp | ws://127.0.0.1:8322/rtp?mode=passive
 *                   SDP: http://127.0.0.1:8322/sdp
 *   §9 通道中继     POST http://127.0.0.1:8090/publish/<name>
 *                   WS  ws://127.0.0.1:8090/stream/<name>（与 npm run gateway 行为一致）
 */

import { startGateways } from '../src/index.js';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = argValue('--host', '127.0.0.1');
const wsFlvPort = Number(argValue('--wsflv-port', '8321'));
const rtspPort = Number(argValue('--rtsp-port', '8322'));
// PORT 环境变量为 captain 冻结壳的既有约定，保持兼容
const relayPort = Number(argValue('--relay-port', process.env.PORT || '8090'));

let gw;
try {
  gw = startGateways({ host, wsFlvPort, rtspPort, relayPort });
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[gateway] 端口被占用（可能是另一个 gateway/serve 实例）：${err.message}`);
    console.error('[gateway] 换端口启动示例：node bin/gateway.js --relay-port 8091');
    process.exit(1);
  }
  throw err;
}

console.log(`[gateway] ws-flv  : ws://${host}:${wsFlvPort}/live/test`);
console.log(`[gateway] rtsp-ws : ws://${host}:${rtspPort}/rtsp | ws://${host}:${rtspPort}/rtp?mode=passive`);
console.log(`[gateway] sdp     : http://${host}:${rtspPort}/sdp`);
console.log(`[gateway] relay   : POST http://${host}:${relayPort}/publish/<name> → ws://${host}:${relayPort}/stream/<name>`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    gw.close();
    process.exit(0);
  });
}
