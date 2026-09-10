/**
 * GatewayChunkSource 构造期 URL 安全校验（§9.4 / I5）：仅校验构造函数传入的 url，
 * 不打开 WebSocket，因此零网络、零浏览器依赖。覆盖 assertSafeWsUrl 对危险协议的拒绝
 * 与对 ws/wss 的放行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GatewayChunkSource } from '../src/gateway-source.js';

test('拒绝 javascript: 协议（XSS/代码注入）→ NETWORK_ERROR', () => {
  assert.throws(
    () => new GatewayChunkSource({ url: 'javascript:alert(1)' }),
    (e) => e.code === 'NETWORK_ERROR',
    'javascript: 应被 URL 守卫拒绝',
  );
});

test('拒绝 http:/file: 等非 ws 协议 → NETWORK_ERROR', () => {
  for (const bad of ['http://127.0.0.1:8000/x', 'https://h/x', 'file:///etc/passwd', 'data:text/plain,hi', 'blob:xyz']) {
    assert.throws(
      () => new GatewayChunkSource({ url: bad }),
      (e) => e.code === 'NETWORK_ERROR',
      `应拒绝 ${bad}`,
    );
  }
});

test('拒绝 rtmp:（须先经 resolveSourceUrl 映射，网关只收 ws/wss）→ NETWORK_ERROR', () => {
  assert.throws(
    () => new GatewayChunkSource({ url: 'rtmp://127.0.0.1/live/x' }),
    (e) => e.code === 'NETWORK_ERROR',
  );
});

test('放行 ws:/wss: 合法网关地址，不抛错并正确保存字段', () => {
  const ws = new GatewayChunkSource({ url: 'ws://127.0.0.1:8000/live/x' });
  assert.equal(ws.opts.url, 'ws://127.0.0.1:8000/live/x');
  assert.equal(ws.stopped, false);
  assert.equal(ws.connected, false, '未 start 时不应视为已连接');

  const wss = new GatewayChunkSource({ url: 'wss://gw.example.com/stream?a=1' });
  assert.equal(wss.opts.url, 'wss://gw.example.com/stream?a=1');
});

test('空 url：构造不抛（url 缺省为 ""，start 阶段才校验/建连）', () => {
  const s = new GatewayChunkSource({});
  assert.equal(s.opts.url, '');
  assert.equal(s.stopped, false);
});
