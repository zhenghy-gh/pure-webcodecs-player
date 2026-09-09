import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InterleavedWireParser, parseResponse } from '../src/framing.js';

function collect() {
  const got = { interleaved: [], responses: [] };
  const p = new InterleavedWireParser();
  p.onInterleaved = (ch, bytes) => got.interleaved.push([ch, Array.from(bytes)]);
  p.onResponse = (r) => got.responses.push(r);
  return { p, got };
}

test('$ 块：整块一次喂入', () => {
  const { p, got } = collect();
  p.push(Uint8Array.from([0x24, 0, 0, 3, 10, 20, 30]));
  assert.deepEqual(got.interleaved, [[0, [10, 20, 30]]]);
});

test('$ 块：逐字节喂入（极端半包）', () => {
  const { p, got } = collect();
  const block = Uint8Array.from([0x24, 1, 0, 2, 9, 8]);
  for (const b of block) p.push(Uint8Array.from([b]));
  assert.deepEqual(got.interleaved.length, 1);
  assert.equal(got.interleaved[0][0], 1);
});

test('连续多个 $ 块粘包', () => {
  const { p, got } = collect();
  const a = Uint8Array.from([0x24, 0, 0, 1, 7]);
  const b = Uint8Array.from([0x24, 2, 0, 0]);
  p.push(new Uint8Array([...a, ...b]));
  assert.equal(got.interleaved.length, 2);
  assert.equal(got.interleaved[1][0], 2);
  assert.deepEqual(got.interleaved[1][1], []);
});

test('RTSP 响应与 $ 块交错，响应跨消息切分', () => {
  const { p, got } = collect();
  const resp = 'RTSP/1.0 200 OK\r\nCSeq: 3\r\nContent-Length: 4\r\n\r\nBODY';
  const rtp = Uint8Array.from([0x24, 0, 0, 2, 1, 1]);

  // 第一条消息：响应前半 + $ 块
  p.push(new TextEncoder().encode(resp.slice(0, 12)));
  p.push(new TextEncoder().encode(resp.slice(12)));
  assert.equal(got.responses.length, 1);

  // 第二条：$ 块与下一响应头交叉
  const next = 'RTSP/1.0 404 Not\r\n\r\n';
  const mixed = new Uint8Array([...rtp, ...new TextEncoder().encode(next.slice(0, 6))]);
  p.push(mixed);
  p.push(new TextEncoder().encode(next.slice(6)));
  assert.equal(got.interleaved.length, 1);
  assert.equal(got.responses.length, 2);
  assert.equal(got.responses[1].code, 404);
});

test('parseResponse 字段抽取', () => {
  const r = parseResponse('RTSP/1.0 200 OK\r\nCSeq: 5\r\nSession: ABC;timeout=60\r\nContent-Length: 0', '');
  assert.equal(r.code, 200);
  assert.equal(r.version, '1.0');
  assert.equal(r.headers['cseq'], '5');
  assert.equal(r.headers['session'], 'ABC;timeout=60');
});

test('带 body 的 DESCRIBE 响应（body 跨消息边界）', () => {
  const { p, got } = collect();
  const body = 'v=0\r\nm=video 0 RTP/AVP 96\r\n';
  const head = `RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n`;
  const all = head + body;
  p.push(new TextEncoder().encode(all.slice(0, all.length - 5)));
  p.push(new TextEncoder().encode(all.slice(all.length - 5)));
  assert.equal(got.responses.length, 1);
  assert.equal(got.responses[0].body, body);
});
