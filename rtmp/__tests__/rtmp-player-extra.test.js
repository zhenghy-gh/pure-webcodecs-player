/**
 * WsFlvPlayer 补充正向：source 'stall' 转发、urlResolver 注入、默认 rtmp:// 映射。
 * 注入手法同 rtmp-player-fake.test.js（替换 globalThis.WebSocket，零网络）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
import { FlvLoopSource } from '../../samples/gateway/src/index.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.binaryType = '';
    this.readyState = 0;
    this.sent = [];
    this.onopen = this.onerror = this.onclose = this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close(code, reason) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }
}
const RealWebSocket = globalThis.WebSocket;
before(() => { globalThis.WebSocket = FakeWebSocket; });
after(() => { globalThis.WebSocket = RealWebSocket; });

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const feed = (ws, buf) => ws.onmessage?.({ data: ab(buf) });
function join(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const init = () => new FlvLoopSource({ frameCount: 1 }).initChunk();
const BACKOFF = { baseMs: 30, factor: 1, maxMs: 30, jitter: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until 超时'); await sleep(5); }
}
const latest = () => FakeWebSocket.instances.at(-1);

test('source 空闲 stall → player 转发 stall 事件（等待上游重推自动续播）', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, firstDataTimeoutMs: 80 });
  let states = 0;
  const stalls = [];
  p.on('statechange', () => states++);
  p.on('stall', (i) => stalls.push(i));

  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  feed(latest(), init()); // 首个分块：清 firstData 超时、进入 playing
  await until(() => p.state === PLAYER_STATES.PLAYING);

  // 此后不再来数据 → 应触发空闲 stall，而不进入 error
  await until(() => stalls.length >= 1, 1000);
  assert.ok(stalls[0].idleMs >= 50, '应上报空闲时长');
  assert.equal(p.state, PLAYER_STATES.PLAYING, 'stall 不应终止播放/重连');
  p.stop();
});

test('urlResolver 注入：自定义解析函数完全接管地址映射', async () => {
  let calledWith = null;
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    urlResolver: (u) => { calledWith = u; return 'ws://gateway-injected/live/stream'; },
  });
  const pr = p.start('rtmp://anything/foo/bar');
  assert.equal(calledWith, 'rtmp://anything/foo/bar', '应把原始输入传给 urlResolver');
  const ws = latest();
  assert.equal(ws.url, 'ws://gateway-injected/live/stream', 'WS 应直连注入地址');
  ws._open();
  await pr;
  feed(ws, init());
  await until(() => p.state === PLAYER_STATES.PLAYING);
  p.stop();
});

test('默认 urlResolver：rtmp:// → ws://host:8000/path.flv 网关映射', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF });
  const pr = p.start('rtmp://example.com/live/stream');
  const ws = latest();
  assert.equal(ws.url, 'ws://example.com:8000/live/stream.flv', 'rtmp 应映射为网关 ws 地址并追加 .flv');
  ws._open();
  await pr;
  feed(ws, init());
  await until(() => p.state === PLAYER_STATES.PLAYING);
  p.stop();
});
