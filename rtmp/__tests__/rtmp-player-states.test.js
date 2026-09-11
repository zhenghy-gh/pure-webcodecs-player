/**
 * WsFlvPlayer 状态机 / 生命周期 正向边界补测（零网络）。
 *
 * 复用 rtmp-player-fake.test.js 的 FakeWebSocket 注入手法（替换 globalThis.WebSocket），
 * 仅覆盖该文件未触及的状态机分支：
 *   1. 非法转移：连接已 PLAYING / 已 ERROR 时再次 start → STATE_ERROR；
 *   2. stop() 从 IDLE 进入（未 start 即停止）→ STOPPED + statechange(IDLE→STOPPED)；
 *   3. flushPending() 在媒体轨就绪前（remuxer 未 ready）为 no-op，不调用 sink、不抛错；
 *   4. 已 stop() 之后 source close → 不触发 will-reconnect（_userStopped 守卫）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
import { FlvLoopSource } from '../../samples/gateway/src/index.js';

/* ------------------------------------------------------------------ FakeWS */

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
  send(d) {
    this.sent.push(d);
  }
  close(code, reason) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code = 1006, reason = 'gone') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const RealWebSocket = globalThis.WebSocket;
before(() => {
  globalThis.WebSocket = FakeWebSocket;
});
after(() => {
  globalThis.WebSocket = RealWebSocket;
});

function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function feed(ws, buf) {
  ws.onmessage?.({ data: ab(buf) });
}
function join(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) out.set(p, off), (off += p.length);
  return out;
}
function initAndFrames(n = 5) {
  const src = new FlvLoopSource({ frameCount: Math.max(n, 1) });
  return { init: src.initChunk(), frames: join(src.take(n)) };
}

const BACKOFF = { baseMs: 30, factor: 1, maxMs: 30, jitter: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await sleep(5);
  }
}
const latest = () => FakeWebSocket.instances.at(-1);

/* ------------------------------------------------------------------- tests */

test('非法转移：已 PLAYING 时再次 start → STATE_ERROR', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  const { init, frames } = initAndFrames(2);
  feed(latest(), init);
  feed(latest(), frames);
  await until(() => p.state === PLAYER_STATES.PLAYING);

  await assert.rejects(
    () => p.start('ws-flv://gw/live/y'),
    (e) => e.code === 'STATE_ERROR' && /不能 start/.test(e.message),
    'PLAYING 态不允许二次 start',
  );
  p.stop();
});

test('非法转移：已 ERROR 时再次 start → STATE_ERROR（maxReconnectAttempts=0 触发 error 路径）', async () => {
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    maxReconnectAttempts: 0,
    firstDataTimeoutMs: 5000,
    flushIntervalMs: 40,
  });
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  const { init, frames } = initAndFrames(2);
  feed(latest(), init);
  feed(latest(), frames);
  await until(() => p.state === PLAYER_STATES.PLAYING);

  // 断线且重连次数上限=0 → 直接 fail 进入 ERROR
  latest().serverClose(1006, 'drop');
  await until(() => p.state === PLAYER_STATES.ERROR);
  assert.equal(p.stats.lastError?.code, 'NETWORK_ERROR');
  assert.match(p.stats.lastError?.message, /重连次数已达上限/);

  await assert.rejects(
    () => p.start('ws-flv://gw/live/z'),
    (e) => e.code === 'STATE_ERROR',
    'ERROR 态不允许 start',
  );
  p.stop();
});

test('stop() 从 IDLE（未 start 即停止）→ 进入 STOPPED 且发 statechange(IDLE→STOPPED)', () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF });
  assert.equal(p.state, PLAYER_STATES.IDLE);
  const states = [];
  p.on('statechange', ({ from, to }) => states.push(`${from}->${to}`));
  p.stop();
  assert.equal(p.state, PLAYER_STATES.STOPPED, 'IDLE 直接停止应进入 STOPPED');
  assert.deepEqual(states, ['idle->stopped'], '应发 IDLE→STOPPED 状态迁移');
  assert.equal(p._source, null, '未 start 不应创建任何 source/WS 连接');
});

test('flushPending() 在媒体轨就绪前：remuxer 未 ready → 不调用 sink、不抛错', () => {
  const calls = { init: 0, frag: 0 };
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    sink: { onInitSegment: () => calls.init++, onFragment: () => calls.frag++ },
  });
  assert.doesNotThrow(() => p.flushPending(), '就绪前 flushPending 不应抛错');
  assert.doesNotThrow(() => p.flushPending({ force: true }), 'force 变体同样安全');
  assert.equal(calls.init, 0, '未就绪不应产出 init segment');
  assert.equal(calls.frag, 0, '未就绪不应产出 fragment');
  assert.equal(p._remuxer.ready, false, '前置条件：remuxer 确无轨道未 ready');
});

test('已 stop() 后 source close → 不触发 will-reconnect（_userStopped 守卫）', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  let willReconnect = 0;
  p.on('will-reconnect', () => willReconnect++);
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  const { init, frames } = initAndFrames(2);
  feed(latest(), init);
  feed(latest(), frames);
  await until(() => p.state === PLAYER_STATES.PLAYING);

  p.stop();
  assert.equal(p.state, PLAYER_STATES.STOPPED);
  // 停止后再收到 close：不应企图重连
  latest().serverClose(1006, 'drop after stop');
  await sleep(80);
  assert.equal(willReconnect, 0, '停止后 close 不应调度重连');
  assert.equal(p.state, PLAYER_STATES.STOPPED, '状态保持在 STOPPED');
});
