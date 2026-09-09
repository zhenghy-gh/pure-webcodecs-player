import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWsFlvUrl, mapRtmpToGateway, resolveSourceUrl, isWebSocketUrl } from '../src/url.js';

test('ws-flv:// → ws://，缺省端口 80', () => {
  const r = parseWsFlvUrl('ws-flv://example.com/live/stream');
  assert.equal(r.url, 'ws://example.com:80/live/stream');
  assert.equal(r.secure, false);
});

test('wss-flv:// → wss://，缺省端口 443；显式端口保留', () => {
  assert.equal(parseWsFlvUrl('wss-flv://example.com/live/stream').url, 'wss://example.com:443/live/stream');
  assert.equal(parseWsFlvUrl('ws-flv://127.0.0.1:8321/live/test?x=1').url, 'ws://127.0.0.1:8321/live/test?x=1');
});

test('query 串透传', () => {
  const r = parseWsFlvUrl('ws-flv://h/p?a=1&b=2');
  assert.equal(r.query, '?a=1&b=2');
});

test('非 ws-flv 形态返回 null', () => {
  assert.equal(parseWsFlvUrl('http://x/y'), null);
});

test('isWebSocketUrl：ws/wss 通过，其余否', () => {
  assert.equal(isWebSocketUrl('ws://a/b'), true);
  assert.equal(isWebSocketUrl('wss://a/b'), true);
  assert.equal(isWebSocketUrl('rtmp://a/b'), false);
});

test('rtmp:// 默认映射：1935→8000 且追加 .flv', () => {
  const r = mapRtmpToGateway('rtmp://host.example/live/stream');
  assert.equal(r.url, 'ws://host.example:8000/live/stream.flv');
  assert.equal(r.sourcePort, 1935);
  assert.equal(r.gatewayPort, 8000);
});

test('rtmps:// → wss://；显式端口时源端口记录、网关仍用约定端口', () => {
  const r = mapRtmpToGateway('rtmps://host:1936/app/name');
  assert.equal(r.url.startsWith('wss://host:'), true);
  assert.ok(r.url.endsWith(':8000/app/name.flv'));
  assert.equal(r.sourcePort, 1936);
});

test('appendSuffix=false 不加后缀', () => {
  const r = mapRtmpToGateway('rtmp://host/live/stream.flv', { appendSuffix: false });
  assert.ok(r.url.endsWith('/live/stream.flv'));
});

test('resolveSourceUrl：四种形态统一出口', () => {
  assert.equal(resolveSourceUrl('ws-flv://a/x'), 'ws://a:80/x');
  assert.equal(resolveSourceUrl('ws://a:9000/x'), 'ws://a:9000/x');
  assert.equal(resolveSourceUrl('rtmp://a/live/s'), 'ws://a:8000/live/s.flv');
  // §9 通道中继形态：gatewayBase 指定时按频道名拼接且不加 .flv
  assert.equal(
    resolveSourceUrl('rtmp://192.168.1.3/live/cam1', { gatewayBase: 'ws://127.0.0.1:8090/stream' }),
    'ws://127.0.0.1:8090/stream/live/cam1',
  );
});

test('resolveSourceUrl：空串与未知 scheme 抛 TypeError', () => {
  assert.throws(() => resolveSourceUrl(''), TypeError);
  assert.throws(() => resolveSourceUrl('gopher://x/y'), TypeError);
});
