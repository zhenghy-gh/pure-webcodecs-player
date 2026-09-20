/**
 * signaling-gaps.test.js —— webrtc/signaling.js 残余分支补测（wave 144）
 *
 * 覆盖：
 *   - defaultFetch：无 fetch 环境 → notSupported；有 fetch 时委托调用；
 *   - WhepSignal.exchange：Location 无法解析（isSafeUrl 宽松放行、new URL 严格抛错）
 *     → fallback resourceUrl = 原始 location；
 *   - WebSocketSignal.exchange：等待 answer 超时（mock.timers 虚拟时钟 10s）→ TIMEOUT；
 *   - WebSocketSignal.sendCandidate：连接态实际发送 JSON。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WhepSignal, WebSocketSignal } from '../src/signaling.js';

function sdpRes({ status = 201, sdp = 'v=0', location = null } = {}) {
  return {
    status,
    text: async () => sdp,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/sdp' : k.toLowerCase() === 'location' ? location : null) },
  };
}

test('defaultFetch：无 fetch 环境 → notSupported', async () => {
  const realFetch = globalThis.fetch;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
  try {
    const s = new WhepSignal('https://ep.example/live'); // 不注入 fetchImpl → defaultFetch
    await assert.rejects(
      () => s.exchange('v=0'),
      (e) => e.code === 'NOT_SUPPORTED' && e.message.includes('无 fetch'),
    );
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
    else globalThis.fetch = realFetch;
  }
});

test('defaultFetch：委托全局 fetch', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let called = 0;
  const spy = async (url, init) => {
    called += 1;
    assert.equal(url, 'https://ep.example/live');
    assert.equal(init.method, 'POST');
    return sdpRes();
  };
  Object.defineProperty(globalThis, 'fetch', { value: spy, configurable: true });
  try {
    const s = new WhepSignal('https://ep.example/live');
    const r = await s.exchange('v=0');
    assert.equal(r.sdp, 'v=0');
    assert.equal(called, 1);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
    else globalThis.fetch = undefined;
  }
});

test('exchange：Location 无法解析（宽松放行后严格抛错）→ fallback 保留原始串', async () => {
  const s = new WhepSignal('https://ep.example/live', {
    fetchImpl: async () => sdpRes({ location: 'http://[' }),
  });
  const r = await s.exchange('v=0');
  assert.equal(r.resourceUrl, 'http://[');
  assert.equal(s.resourceUrl, 'http://[');
});

class FakeWs {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = this.onerror = this.onclose = this.onmessage = null;
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

test('exchange：等待 answer 超时（10s 虚拟时钟）→ TIMEOUT', async () => {
  const signal = new WebSocketSignal('ws://sig.example/ws', { WebSocketImpl: FakeWs });
  const pending = signal.connect();
  signal.ws.readyState = 1;
  signal.ws.onopen?.();
  await pending;

  // 必须先启用虚拟时钟再调 exchange（setTimeout 在 exchange 内同步创建）
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  const exchange = signal.exchange('offer-sdp');
  const settled = { done: false, err: null };
  exchange.then(() => { settled.done = true; }, (e) => { settled.done = true; settled.err = e; });
  try {
    mock.timers.tick(10_000);
  } finally {
    mock.timers.reset();
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(settled.done, '超时后 exchange 应 settle');
  assert.equal(settled.err?.code, 'TIMEOUT');
  await signal.close();
});

test('sendCandidate：连接态发送 JSON 帧', () => {
  const signal = new WebSocketSignal('ws://sig.example/ws', { WebSocketImpl: FakeWs });
  const pending = signal.connect();
  signal.ws.readyState = 1;
  signal.ws.onopen?.();
  signal.sendCandidate({ candidate: 'candidate:1', sdpMid: '0' });
  assert.deepEqual(JSON.parse(signal.ws.sent.at(-1)), {
    type: 'candidate',
    candidate: { candidate: 'candidate:1', sdpMid: '0' },
  });
});
