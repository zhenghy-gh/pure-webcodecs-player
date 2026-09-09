#!/usr/bin/env node
/**
 * mock-flv-ws.js —— E-11 约定的 ws-flv 模拟推流入口（qa/SM-5 冒烟用）。
 *
 * 权威实现见 src/server-wsflv.js；本脚本仅是薄启动壳：
 *   node samples/gateway/mock-flv-ws.js [--port 8321] [--frames N] [--speed fast]
 *
 * 连接地址：ws://127.0.0.1:<port>/live/test
 */

import { createWsFlvGateway } from './src/server-wsflv.js';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(argValue('--port', process.env.PORT || '8321'));
const server = createWsFlvGateway({ host: argValue('--host', '127.0.0.1'), port });

console.log(`[mock-flv-ws] ws://127.0.0.1:${port}/live/test 就绪（循环推送内置 H264 FLV 流）`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
