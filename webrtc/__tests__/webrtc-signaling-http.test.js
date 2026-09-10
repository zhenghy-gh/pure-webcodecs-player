/**
 * webrtc 补充单测：signaling.js HTTP/WS 协议边界
 *  - WHEP：javascript: 协议白名单拒绝、错误响应 body 读取抛错被吞、
 *    错误 body 超过 200 字符被截断、Content-Type 带 charset、200 OK 同样走成功分支、
 *    sendCandidate 不带 Authorization、close() 无 resourceUrl 时不发请求、
 *    close 后再 sendCandidate 抛错、Location 同源相对路径正确解析为绝对地址
 *  - WebSocketSignal：connect() ws onerror → reject networkError、
 *    exchange() ws.readyState=2/3 → stateError、close() ws=null 不抛、
 *    收到超大 text (>8MB) 静默忽略、收到非字符串 ev.data 静默忽略
 *  - isValidSignalMessage：candidate 是数组/字符串/数字都拒绝
 *  - createSignalChannel：完全无效 URL 抛错、ws 信令带端口
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WhepSignal,
  WebSocketSignal,
  createSignalChannel,
  isValidSignalMessage,
} from '../src/signaling.js';
import { ErrorCode } from '../../core/src/errors.js';

const ANSWER = 'v=0\no=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\n';

/* ---------------- WHEP 协议白名单与错误体边界 ---------------- */

test('WHEP：Location 指向 javascript: 协议抛 networkError', async () => {
  const impl = async (_u, init = {}) => {
    if (init.method === 'POST') {
      return {
        status: 201,
        ok: true,
        headers: {
          get: (h) => (h.toLowerCase() === 'location' ? 'javascript:alert(1)' : 'application/sdp'),
        },
        text: async () => ANSWER,
      };
    }
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('O'),
    (e) => {
      assert.equal(e.code, ErrorCode.NETWORK_ERROR);
      assert.match(e.message, /不允许的协议/);
      return true;
    }
  );
});

test('WHEP：错误响应 body 读取抛错时 detail 退化为空串、不连带抛', async () => {
  const impl = async () => ({
    status: 502,
    ok: false,
    headers: { get: () => 'text/plain' },
    text: async () => { throw new Error('socket hang up'); },
  });
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('O'),
    (e) => {
      assert.equal(e.code, ErrorCode.NETWORK_ERROR);
      // detail 部分空字符串（catch 吞掉），只含状态码
      assert.match(e.message, /HTTP 502/);
      assert.doesNotMatch(e.message, /socket hang up/);
      return true;
    }
  );
});

test('WHEP：错误响应 body 超过 200 字符时 detail 截断', async () => {
  const big = 'X'.repeat(500);
  const impl = async () => ({
    status: 503,
    ok: false,
    headers: { get: () => 'text/plain' },
    text: async () => big,
  });
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(
    () => sig.exchange('O'),
    (e) => {
      assert.match(e.message, /HTTP 503/);
      // 200 字符 X：应被 .slice(0, 200) 截断
      const xCount = (e.message.match(/X/g) || []).length;
      assert.equal(xCount, 200);
      return true;
    }
  );
});

test('WHEP：Content-Type 带 charset (application/sdp;charset=UTF-8) 仍视作 sdp', async () => {
  const calls = [];
  const impl = async (_u, init = {}) => {
    calls.push({ method: init.method });
    return {
      status: 201,
      ok: true,
      headers: {
        get: (h) => (h.toLowerCase() === 'content-type' ? 'application/sdp;charset=UTF-8' : null),
      },
      text: async () => ANSWER,
    };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  const { sdp } = await sig.exchange('O');
  assert.equal(sdp, ANSWER);
  assert.equal(calls.length, 1);
});

test('WHEP：200 OK 同样走成功分支（兼容非 201 实现）', async () => {
  const impl = async (_u, init = {}) => {
    return {
      status: 200,
      ok: true,
      headers: {
        get: (h) => (h.toLowerCase() === 'content-type' ? 'application/sdp' : null),
      },
      text: async () => ANSWER,
    };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  const { sdp } = await sig.exchange('O');
  assert.equal(sdp, ANSWER);
});

test('WHEP：sendCandidate PATCH 不带 Authorization 头（与 POST 不同）', async () => {
  const seenHeaders = [];
  const impl = async (_u, init = {}) => {
    seenHeaders.push({ method: init.method, headers: init.headers });
    if (init.method === 'POST') {
      return {
        status: 201,
        ok: true,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'application/sdp' : (h.toLowerCase() === 'location' ? '/s/1' : null)),
        },
        text: async () => ANSWER,
      };
    }
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl, authToken: 'tok' });
  await sig.exchange('O');
  await sig.sendCandidate('a=candidate:1 1 UDP 1 1.2.3.4 5 typ host');
  const post = seenHeaders.find((c) => c.method === 'POST');
  const patch = seenHeaders.find((c) => c.method === 'PATCH');
  assert.equal(post.headers.Authorization, 'Bearer tok');
  assert.equal(patch.headers.Authorization, undefined, 'PATCH 不应携带 Bearer token');
  assert.equal(patch.headers['Content-Type'], 'application/trickle-ice-sdpfrag');
  assert.equal(patch.headers['If-Match'], '*');
});

test('WHEP：close() 在无 resourceUrl 时不发请求、直接返回', async () => {
  let callCount = 0;
  const impl = async () => { callCount += 1; return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' }; };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await sig.close();
  assert.equal(callCount, 0, '未 exchange 之前 close 不应发起请求');
});

test('WHEP：close 后再 sendCandidate 应抛 stateError（resourceUrl 已置 null）', async () => {
  const impl = async (_u, init = {}) => {
    if (init.method === 'POST') {
      return {
        status: 201,
        ok: true,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'application/sdp' : (h.toLowerCase() === 'location' ? '/s/1' : null)),
        },
        text: async () => ANSWER,
      };
    }
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await sig.exchange('O');
  await sig.close();
  await assert.rejects(
    () => sig.sendCandidate('x'),
    (e) => {
      assert.equal(e.code, ErrorCode.STATE_ERROR);
      return true;
    }
  );
});

test('WHEP：Location 同源相对路径正确解析为绝对地址', async () => {
  const impl = async (_u, init = {}) => {
    return {
      status: 201,
      ok: true,
      headers: {
        get: (h) => {
          const lh = h.toLowerCase();
          if (lh === 'location') return '/sessions/xyz?token=abc';
          if (lh === 'content-type') return 'application/sdp';
          return null;
        },
      },
      text: async () => ANSWER,
    };
  };
  const sig = new WhepSignal('https://edge.example.com/whep', { fetchImpl: impl });
  const { resourceUrl } = await sig.exchange('O');
  assert.equal(resourceUrl, 'https://edge.example.com/sessions/xyz?token=abc');
});

/* ---------------- WebSocketSignal 边界 ---------------- */

test('WebSocketSignal：connect() ws.onerror 触发 reject networkError', async () => {
  const wsInstance = {
    readyState: 0,
    onopen: null,
    onerror: null,
    onmessage: null,
    send() {},
    close() {},
  };
  const WSImpl = function () { return wsInstance; };
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: WSImpl });
  const p = sig.connect();
  // 立即触发 error
  wsInstance.onerror();
  await assert.rejects(
    () => p,
    (e) => {
      assert.equal(e.code, ErrorCode.NETWORK_ERROR);
      assert.match(e.message, /WebSocket 连接失败/);
      return true;
    }
  );
});

test('WebSocketSignal：exchange() ws.readyState=2 (CLOSING) 抛 stateError', async () => {
  const ws = { readyState: 2, send() {}, close() {}, onopen() {}, onerror() {}, onmessage() {} };
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return ws; } });
  // 直接模拟已"打开"过（readyState=1）→ 后续置为 2
  ws.readyState = 2;
  await assert.rejects(
    () => sig.exchange('O'),
    (e) => {
      assert.equal(e.code, ErrorCode.STATE_ERROR);
      assert.match(e.message, /WebSocket 未连接/);
      return true;
    }
  );
});

test('WebSocketSignal：exchange() ws.readyState=3 (CLOSED) 抛 stateError', async () => {
  const ws = { readyState: 3, send() {}, close() {}, onopen() {}, onerror() {}, onmessage() {} };
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return ws; } });
  await assert.rejects(
    () => sig.exchange('O'),
    (e) => {
      assert.equal(e.code, ErrorCode.STATE_ERROR);
      return true;
    }
  );
});

test('WebSocketSignal：close() 在 ws=null 时不抛错且 resolve', async () => {
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return { readyState: 0, send() {}, close() {} }; } });
  // 不调用 connect —— ws 仍为 null
  await assert.doesNotReject(() => sig.close());
});

test('WebSocketSignal：收到非字符串 ev.data 静默忽略', async () => {
  const ws = { readyState: 0, sent: [], onopen() {}, onerror() {}, onmessage: null, send() {}, close() {} };
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return ws; } });
  const p = sig.connect();
  ws.readyState = 1;
  ws.onopen();
  await p;
  // 非字符串 data：不抛错、不影响候选缓冲
  ws.onmessage({ data: new Uint8Array([1, 2, 3]) });
  ws.onmessage({ data: null });
  ws.onmessage({ data: 42 });
  assert.equal(sig.drainRemoteCandidates().length, 0);
});

test('WebSocketSignal：超过 8MB 的文本消息静默忽略（不解析、不入候选缓冲）', async () => {
  const ws = { readyState: 0, onopen() {}, onerror() {}, onmessage: null, send() {}, close() {} };
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return ws; } });
  const p = sig.connect();
  ws.readyState = 1;
  ws.onopen();
  await p;
  // 9MB 候选字符串 → 长度熔断
  const big = 'x'.repeat((8 << 20) + 1);
  ws.onmessage({ data: big });
  // 正常候选仍能收到（对比确认熔断分支生效）
  ws.onmessage({ data: JSON.stringify({ type: 'candidate', candidate: { candidate: 'c1' } }) });
  const drained = sig.drainRemoteCandidates();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].candidate, 'c1');
});

/* ---------------- isValidSignalMessage 类型边界 ---------------- */

test('isValidSignalMessage：candidate 是数组/字符串/数字/布尔均拒绝', () => {
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: [] }), false);
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: 'c1' }), false);
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: 42 }), false);
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: null }), false);
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: true }), false);
});

test('isValidSignalMessage：constructor/prototype 危险键与 __proto__ 同样拒绝', () => {
  const dangerous1 = {};
  Object.defineProperty(dangerous1, 'constructor', { value: { polluted: 1 }, enumerable: true });
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: dangerous1 }), false);
  const dangerous2 = {};
  Object.defineProperty(dangerous2, 'prototype', { value: { polluted: 1 }, enumerable: true });
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: dangerous2 }), false);
});

test('isValidSignalMessage：sdp 字段为 null/undefined（非字符串）拒绝', () => {
  assert.equal(isValidSignalMessage({ type: 'offer', sdp: null }), false);
  assert.equal(isValidSignalMessage({ type: 'offer', sdp: undefined }), false);
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: '' }), true, '空串是合法的字符串 sdp');
});

test('isValidSignalMessage：candidate 字段缺失时仍合法（按 type 校验）', () => {
  assert.equal(isValidSignalMessage({ type: 'answer' }), true);
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: 'X' }), true);
  assert.equal(isValidSignalMessage({ type: 'candidate' }), true, 'candidate 可不带 candidate 字段');
});

/* ---------------- createSignalChannel 边界 ---------------- */

test('createSignalChannel：http / ws 均按协议分发', () => {
  assert.ok(createSignalChannel('http://e/whep').constructor.name === 'WhepSignal');
  assert.ok(createSignalChannel('https://e/whep').constructor.name === 'WhepSignal');
  assert.ok(createSignalChannel('ws://sig:8080/x').constructor.name === 'WebSocketSignal');
  assert.ok(createSignalChannel('wss://sig/x').constructor.name === 'WebSocketSignal');
});

test('createSignalChannel：未知协议（如 stun:/data:/about:）抛 parseError', () => {
  assert.throws(() => createSignalChannel('stun:x'), /无法识别的信令地址协议/);
  assert.throws(() => createSignalChannel('data:text/plain,foo'), /无法识别的/);
  assert.throws(() => createSignalChannel('about:blank'), /无法识别的/);
});