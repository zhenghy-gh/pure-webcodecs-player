/**
 * webrtc 补充单测：signaling.js 错误分支与 schema 校验
 *  - WhepSignal：5xx→networkError、4xx→parseError、Content-Type 非 sdp→parseError、
 *    Location 指向不安全协议(file:/data:)→networkError、错误响应正文带入 detail
 *  - WebSocketSignal：无实现注入 connect 抛 notSupported、未连接即 exchange 抛 stateError
 *  - isValidSignalMessage：长度熔断、类型白名单、sdp 类型、危险键(__proto__) 拒绝
 * 全部注入 fetch/WebSocket mock，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WhepSignal,
  WebSocketSignal,
  isValidSignalMessage,
} from '../src/signaling.js';
import { ErrorCode } from '../../core/src/errors.js';

const ANSWER = 'v=0\no=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\n';

/* ---------------- WHEP 错误分支 ---------------- */

test('WhepSignal：5xx 抛 networkError（含状态码与正文）', async () => {
  const impl = async () => ({
    status: 503,
    ok: false,
    headers: { get: () => 'text/plain' },
    text: async () => 'busy',
  });
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('OFFER'),
    (e) => {
      assert.match(e.message, /HTTP 503/);
      assert.equal(e.code, ErrorCode.NETWORK_ERROR);
      assert.match(e.message, /busy/);
      return true;
    }
  );
});

test('WhepSignal：4xx 抛 parseError', async () => {
  const impl = async () => ({
    status: 403,
    ok: false,
    headers: { get: () => 'text/plain' },
    text: async () => 'forbidden',
  });
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('OFFER'),
    (e) => {
      assert.match(e.message, /HTTP 403/);
      assert.equal(e.code, ErrorCode.PARSE_ERROR);
      return true;
    }
  );
});

test('WhepSignal：响应 Content-Type 非 sdp 抛 parseError', async () => {
  const impl = async () => ({
    status: 200,
    ok: true,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => ANSWER,
  });
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('OFFER'),
    (e) => {
      assert.match(e.message, /Content-Type 异常/);
      assert.equal(e.code, ErrorCode.PARSE_ERROR);
      return true;
    }
  );
});

test('WhepSignal：Location 指向 file:/data: 不安全协议抛 networkError', async () => {
  const impl = async (_url, init = {}) => {
    if (init.method === 'POST') {
      return {
        status: 201,
        ok: true,
        headers: {
          get: (h) => (h.toLowerCase() === 'location' ? 'file:///etc/passwd' : 'application/sdp'),
        },
        text: async () => ANSWER,
      };
    }
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('OFFER'),
    (e) => {
      assert.match(e.message, /不允许的协议/);
      assert.equal(e.code, ErrorCode.NETWORK_ERROR);
      return true;
    }
  );
});

test('WhepSignal：connect 为无操作（直接 resolve）', async () => {
  const sig = new WhepSignal('https://e/whep', { fetchImpl: async () => ({}) });
  await assert.doesNotReject(() => sig.connect());
});

/* ---------------- WebSocketSignal 错误分支 ---------------- */

test('WebSocketSignal：未注入实现（全局亦无）时 connect 抛 notSupported', async () => {
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = undefined; // 赋值（非 delete，兼容性更好）
  try {
    const sig = new WebSocketSignal('wss://sig/x'); // 不传 WebSocketImpl
    await assert.rejects(
      () => sig.connect(),
      (e) => {
        assert.match(e.message, /WebSocket 实现/);
        assert.equal(e.code, ErrorCode.NOT_SUPPORTED);
        return true;
      }
    );
  } finally {
    globalThis.WebSocket = saved;
  }
});

test('WebSocketSignal：未连接直接 exchange 抛 stateError', async () => {
  const fakeWsInstance = { readyState: 0, send() {}, close() {} };
  const WSImpl = function () { return fakeWsInstance; };
  const sig = new WebSocketSignal('wss://sig/x', { WebSocketImpl: WSImpl });
  // 不调用 connect()，this.ws 为 null
  await assert.rejects(
    () => sig.exchange('OFFER'),
    (e) => {
      assert.match(e.message, /WebSocket 未连接/);
      assert.equal(e.code, ErrorCode.STATE_ERROR);
      return true;
    }
  );
});

/* ---------------- isValidSignalMessage schema 校验 ---------------- */

test('isValidSignalMessage：白名单/类型/长度/危险键', () => {
  assert.equal(isValidSignalMessage(null), false);
  assert.equal(isValidSignalMessage('str'), false);
  assert.equal(isValidSignalMessage([]), false);
  assert.equal(isValidSignalMessage({ type: 'ping' }), false, '非白名单 type');
  assert.equal(isValidSignalMessage({ type: 'answer' }), true, '合法 answer');
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: 123 }), false, 'sdp 必须字符串');
  const big = 'x'.repeat((1 << 20) + 10); // 超过 1MB 上限
  assert.equal(isValidSignalMessage({ type: 'offer', sdp: big }), false, 'sdp 超长熔断');
  // __proto__ 必须是真实自有可枚举键才能命中拒绝分支（字面量 __proto__ 会被解释成原型赋值）
  const dangerous = {};
  Object.defineProperty(dangerous, '__proto__', { value: { polluted: 1 }, enumerable: true });
  assert.equal(
    isValidSignalMessage({ type: 'candidate', candidate: dangerous }),
    false,
    '危险键 __proto__ 拒绝'
  );
  assert.equal(
    isValidSignalMessage({ type: 'candidate', candidate: { candidate: 'c1' } }),
    true,
    '正常 candidate 对象通过'
  );
});
