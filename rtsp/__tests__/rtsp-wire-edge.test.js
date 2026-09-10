/**
 * 线缆层边界测试（framing.parseResponse / InterleavedWireParser / rtp.parseRtp）：
 * 聚焦畸形/截断报文、大小写不敏感、header 续行、Content-Length 未满足时的等待、
 * 以及 RTP 解析的各种截断/越界错误分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseResponse, InterleavedWireParser } from '../src/framing.js';
import { parseRtp } from '../src/rtp.js';

// 手工构造 RTP 包，避免依赖外部样本编码器
function makeRtp(opts = {}) {
  const {
    version = 2, padding = false, extension = false, csrcCount = 0,
    marker = false, payloadType = 96, sequence = 1, timestamp = 1, ssrc = 1,
    payload = new Uint8Array(0), extLenUnits = 0, csrcList = [],
  } = opts;
  const head = new Uint8Array(12);
  let b0 = (version << 6) | (csrcCount & 0x0f);
  if (padding) b0 |= 0x20;
  if (extension) b0 |= 0x10;
  head[0] = b0;
  head[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  const dv = new DataView(head.buffer);
  dv.setUint16(2, sequence);
  dv.setUint32(4, timestamp);
  dv.setUint32(8, ssrc);
  const parts = [head];
  for (const c of csrcList) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, c);
    parts.push(b);
  }
  if (extension) {
    const ext = new Uint8Array(4 + extLenUnits * 4);
    new DataView(ext.buffer).setUint16(2, extLenUnits); // 以 4 字节为单位的长度
    parts.push(ext);
  }
  parts.push(payload);
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const x of parts) { out.set(x, off); off += x.length; }
  return out;
}

// ---------------- parseResponse 边界 ----------------

test('parseResponse：畸形状态行 → code=0, version 默认 1.0, reason 空', () => {
  const r = parseResponse('GARBAGE-NO-RTSP-PREFIX');
  assert.equal(r.code, 0);
  assert.equal(r.version, '1.0');
  assert.equal(r.reason, '');
  assert.equal(r.statusLine, 'GARBAGE-NO-RTSP-PREFIX');
  assert.deepEqual(r.headers, {});
});

test('parseResponse：header 名大小写不敏感（统一小写）', () => {
  const r = parseResponse('RTSP/1.0 200 OK\r\nContent-Type: X\r\nCSEQ: 4\r\n');
  assert.equal(r.headers['content-type'], 'X');
  assert.equal(r.headers['cseq'], '4');
});

test('parseResponse：header 值前后空白被 trim', () => {
  const r = parseResponse('RTSP/1.0 200 OK\r\nX-Foo:   spaced value   \r\n');
  assert.equal(r.headers['x-foo'], 'spaced value');
});

test('parseResponse：续行（无冒号行）被忽略，不污染 headers', () => {
  const r = parseResponse('RTSP/1.0 200 OK\r\nX: a\r\n continued line\r\n');
  assert.equal(r.headers['x'], 'a');
  assert.equal(Object.keys(r.headers).length, 1);
});

test('parseResponse：bodyText 透传返回', () => {
  const r = parseResponse('RTSP/1.0 200 OK\r\nContent-Length: 3', 'ABC');
  assert.equal(r.body, 'ABC');
});

// ---------------- InterleavedWireParser 边界 ----------------

test('$ 块：length=0 的空载荷，仍触发 onInterleaved', () => {
  const p = new InterleavedWireParser();
  const got = [];
  p.onInterleaved = (ch, bytes) => got.push([ch, Array.from(bytes)]);
  p.push(Uint8Array.from([0x24, 3, 0, 0]));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], [3, []]); // channel=3, 空载荷
});

test('响应头不完整（缺尾随 \\r\\n\\r\\n）：不提前触发，补全后才发', () => {
  const p = new InterleavedWireParser();
  const got = [];
  p.onResponse = (r) => got.push(r);
  p.push(new TextEncoder().encode('RTSP/1.0 200 OK\r\nCSeq: 1\r\n'));
  assert.equal(got.length, 0, '头未闭合不应触发');
  p.push(new TextEncoder().encode('\r\n')); // 仅补气
  assert.equal(got.length, 1);
  assert.equal(got[0].code, 200);
});

test('响应 Content-Length 声明 > 已到 body：等待补齐后才收束', () => {
  const p = new InterleavedWireParser();
  const got = [];
  p.onResponse = (r) => got.push(r);
  const head = 'RTSP/1.0 200 OK\r\nCSeq: 7\r\nContent-Length: 5\r\n\r\n';
  p.push(new TextEncoder().encode(head + 'abc')); // body 只到 3/5
  assert.equal(got.length, 0, 'body 未满足不应触发');
  p.push(new TextEncoder().encode('de'));         // 补齐到 5
  assert.equal(got.length, 1);
  assert.equal(got[0].body, 'abcde');
});

// ---------------- RTP 错误分支 ----------------

test('parseRtp：非 Uint8Array 输入抛错', () => {
  assert.throws(() => parseRtp([1, 2, 3]), /RTP 输入必须是 Uint8Array/);
  assert.throws(() => parseRtp('0102'), /RTP 输入必须是 Uint8Array/);
});

test('parseRtp：包长度 < 12 字节抛「过短」', () => {
  assert.throws(() => parseRtp(new Uint8Array(11)), /过短|short/i);
  assert.throws(() => parseRtp(new Uint8Array(0)), /过短|short/i);
});

test('parseRtp：版本号非 2 抛「版本」错误', () => {
  const b = makeRtp({ version: 3, payload: new Uint8Array([1, 2, 3]) });
  assert.throws(() => parseRtp(b), /版本/);
});

test('parseRtp：CSRC 区被截断抛错', () => {
  // 声明 CC=2 但未提供 CSRC 字节（总长仅 12 < 12+8）
  const b = makeRtp({ csrcCount: 2 });
  assert.throws(() => parseRtp(b), /CSRC|截断/);
});

test('parseRtp：扩展头载荷被截断抛错', () => {
  // 手动构造：X=1，扩展头长度字段声明 1 个 4 字节单元，但实际未提供扩展载荷
  const b = new Uint8Array(16); // 仅 12 头 + 4 字节扩展头（无扩展数据）
  b[0] = (2 << 6) | 0x10;      // V=2, X=1
  b[1] = 96;
  const dv = new DataView(b.buffer);
  dv.setUint16(2, 1); dv.setUint32(4, 1); dv.setUint32(8, 1);
  dv.setUint16(14, 1);          // 扩展头长度字段（offset 12+2）= 1 单元 → 需再 4 字节，但缺
  // 解析时判定 16 < 12 + (4 + 1*4) = 20 → 抛「扩展头载荷被截断」
  assert.throws(() => parseRtp(b), /扩展|截断/);
});

test('parseRtp：padding 末字节大于载荷长度 → 非法', () => {
  const b = makeRtp({ payload: new Uint8Array([7, 1, 2, 3]) });
  b[0] |= 0x20;          // 置 P 位
  b[b.length - 1] = 9;   // padding 计数 = 9 > 载荷 4
  assert.throws(() => parseRtp(b), /padding|非法/);
});

test('parseRtp：合法最小包（V=2, 无扩展/CSRC）可被成功解析', () => {
  const b = makeRtp({ payload: new Uint8Array([0x65, 1, 2]) });
  const p = parseRtp(b);
  assert.equal(p.version, 2);
  assert.equal(p.payloadType, 96);
  assert.deepEqual(Array.from(p.payload), [0x65, 1, 2]);
  assert.equal(p.csrc.length, 0);
});
