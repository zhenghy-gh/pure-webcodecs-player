/**
 * GatewayChunkSource 正向管线 + 恢复路径（零网络）。
 *
 * 注入点：gateway-source 通过全局 `WebSocket` 构造连接（无构造参数注入点），
 * 因此本文件用可驱动的 FakeWebSocket 临时替换 globalThis.WebSocket，
 * 以“服务端视角”精确驱动 open / message / close / error 时序，不打开任何真实 socket。
 *
 * 覆盖：握手自报、二进制分块（data/write 双通道）、meta 透传、eos 合成、发布侧 error、
 * hello 回声容忍、未知 type / 非 JSON / 超大文本静默忽略、stop 幂等、服务端 close、
 * 空闲 stall（连接保持）、连接超时 TIMEOUT、连接失败 NETWORK_ERROR、重复 start STATE_ERROR、
 * createSource 工厂、stop 后到达的消息被忽略。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { GatewayChunkSource, createSource } from '../src/gateway-source.js';

/* ------------------------------------------------------------------ FakeWS */

class FakeWebSocket {
  static instances = [];
  /** 构造后立即异步 open（模拟服务端即时握手） */
  static autoOpen = false;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.binaryType = '';
    this.readyState = 0;
    this.sent = [];
    this.closeArgs = null;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this._open());
  }

  send(d) {
    this.sent.push(d);
  }

  close(code, reason) {
    this.closeArgs = [code, reason];
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }

  // —— 服务端侧驱动 ——
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }
  emitMessage(data) {
    this.onmessage?.({ data });
  }
  emitBytes(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.onmessage?.({ data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  }
  emitError() {
    this.onerror?.({});
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
beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.autoOpen = false;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await sleep(5);
  }
}
const last = () => FakeWebSocket.instances.at(-1);

/** 采集全部事件 */
function tap(src) {
  const got = { open: 0, data: [], write: [], meta: [], end: [], stall: [], error: [] };
  src.on('open', () => got.open++);
  src.on('data', (c) => got.data.push(c));
  src.on('write', (c) => got.write.push(c));
  src.on('meta', (m) => got.meta.push(m));
  src.on('end', (e) => got.end.push(e));
  src.on('stall', (s) => got.stall.push(s));
  src.on('error', (e) => got.error.push(e));
  return got;
}

/* ------------------------------------------------------------------- tests */

test('start：握手自报 hello、emit open、connected 为真，二进制分块 data/write 双通道', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  const p = src.start();
  const ws = last();
  assert.equal(ws.binaryType, 'arraybuffer', '二进制类型应为 arraybuffer');
  assert.equal(src.connected, false, '未 open 前 connected=false');
  ws._open();
  await p;

  assert.equal(got.open, 1);
  assert.equal(src.connected, true);
  assert.equal(ws.sent.length, 1, 'open 后应发送一条握手');
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'hello', ua: 'pureplay-rtmp/0.1' });

  ws.emitBytes([1, 2, 3, 4]);
  assert.equal(got.data.length, 1);
  assert.equal(got.write.length, 1, 'ChunkSource 形状：write 与 data 等价外抛');
  assert.deepEqual(Array.from(got.data[0]), [1, 2, 3, 4]);
  assert.equal(src.bytesIn, 4);
  assert.equal(src.opts.url, 'ws://gw/live/x');
  src.stop();
});

test('meta 文本信令：透传并记忆，不伪造（仅真实信令才置 meta）', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  assert.equal(src.meta, null, '初始不得伪造 meta');
  const p = src.start();
  last()._open();
  await p;

  const payload = { type: 'meta', container: 'flv', width: 640 };
  last().emitMessage(JSON.stringify(payload));
  assert.equal(got.meta.length, 1);
  assert.deepEqual(got.meta[0], payload);
  assert.deepEqual(src.meta, payload, '应记忆最近一次 meta');
  src.stop();
});

test('eos 文本信令 → end(reason=eos)', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  const p = src.start();
  last()._open();
  await p;
  last().emitMessage(JSON.stringify({ type: 'eos' }));
  assert.equal(got.end.length, 1);
  assert.equal(got.end[0].reason, 'eos');
  src.stop();
});

test('发布侧 error 信令 → error(NETWORK_ERROR) 且带 code/message', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  const p = src.start();
  last()._open();
  await p;
  last().emitMessage(JSON.stringify({ type: 'error', message: '推流中断', code: 'PUB_GONE' }));
  assert.equal(got.error.length, 1);
  assert.equal(got.error[0].code, 'NETWORK_ERROR');
  assert.match(got.error[0].message, /推流中断/);
  src.stop();
});

test('自回声硬性义务：hello 回声无副作用；未知 type / 非 JSON / 超大文本静默忽略', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  const p = src.start();
  last()._open();
  await p;

  last().emitMessage(JSON.stringify({ type: 'hello' }));      // 自身回声
  last().emitMessage(JSON.stringify({ type: 'bogus', x: 1 })); // 未知 type
  last().emitMessage('这不是 JSON');                            // 非 JSON
  last().emitMessage(JSON.stringify([1, 2, 3]));               // 非对象
  last().emitMessage(JSON.stringify({ noType: true }));        // 缺 type
  last().emitMessage('x'.repeat((1 << 20) + 1));               // 超过 1MB 上限

  assert.equal(got.meta.length, 0);
  assert.equal(got.error.length, 0);
  assert.equal(got.end.length, 0);
  assert.equal(src.meta, null);
  assert.equal(src.bytesIn, 0);
  src.stop();
});

test('stop：幂等、关闭底层连接、emit end(byUser)，stop 后到达的消息被忽略', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = tap(src);
  const p = src.start();
  const ws = last();
  ws._open();
  await p;

  src.stop();
  assert.equal(src.stopped, true);
  assert.deepEqual(ws.closeArgs, [1000, 'client stop']);
  assert.equal(got.end.length, 1);
  assert.equal(got.end[0].byUser, true);

  src.stop(); // 幂等
  assert.equal(got.end.length, 1, '重复 stop 不应再次 emit end');

  const before = src.bytesIn;
  ws.emitBytes([9, 9, 9]);
  ws.emitMessage(JSON.stringify({ type: 'meta', a: 1 }));
  assert.equal(src.bytesIn, before, 'stop 后消息应被忽略');
  assert.equal(got.meta.length, 0);
});

test('服务端 close → close + end(reason=closed) 且 connected 转 false', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const got = { close: [], end: [] };
  src.on('close', (i) => got.close.push(i));
  src.on('end', (i) => got.end.push(i));
  const p = src.start();
  const ws = last();
  ws._open();
  await p;

  ws.serverClose(1006, 'network lost');
  assert.equal(src.connected, false);
  assert.equal(got.close.length, 1);
  assert.deepEqual(got.close[0], { code: 1006, reason: 'network lost' });
  assert.equal(got.end.length, 1);
  assert.equal(got.end[0].reason, 'closed');
  assert.equal(got.end[0].code, 1006);
});

test('空闲超时 → 反复 stall 且不主动断连（等待上游重推自动续播）', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x', idleTimeoutMs: 60 });
  const got = tap(src);
  const p = src.start();
  const ws = last();
  ws._open();
  await p;

  await until(() => got.stall.length >= 2);
  assert.equal(src.connected, true, 'stall 不应关闭连接');
  assert.ok(got.stall[0].idleMs >= 50, 'idleMs 应上报实际（下限 50）');

  // 来数据后 idle 计时被重新武装：继续等待仍能产生新一轮 stall
  ws.emitBytes([1]);
  const seen = got.stall.length;
  await until(() => got.stall.length > seen);
  src.stop();
});

test('未 open → 连接超时 TIMEOUT 并关闭底层连接', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x', connectTimeoutMs: 40 });
  const p = src.start().then(() => null, (e) => e);
  const ws = last();
  const err = await p;
  assert.equal(err?.code, 'TIMEOUT');
  assert.deepEqual(ws.closeArgs, [undefined, undefined], '超时应主动关闭');
  assert.equal(src.started, true);
});

test('open 前 error → NETWORK_ERROR', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const p = src.start().then(() => null, (e) => e);
  last().emitError();
  const err = await p;
  assert.equal(err?.code, 'NETWORK_ERROR');
});

test('重复 start → STATE_ERROR', async () => {
  const src = new GatewayChunkSource({ url: 'ws://gw/live/x' });
  const p = src.start();
  last()._open();
  await p;
  await assert.rejects(() => src.start(), (e) => e.code === 'STATE_ERROR');
  src.stop();
});

test('createSource 工厂：resolve 于 WS 就绪并已 open', async () => {
  FakeWebSocket.autoOpen = true;
  const src = await createSource({ url: 'ws://gw/live/x' });
  assert.ok(src instanceof GatewayChunkSource);
  assert.equal(src.connected, true);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(JSON.parse(last().sent[0]), { type: 'hello', ua: 'pureplay-rtmp/0.1' });
  src.stop();
});
