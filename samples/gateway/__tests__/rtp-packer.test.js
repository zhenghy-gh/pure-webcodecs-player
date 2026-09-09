import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeRtp,
  packetizeNal,
  packetizeAccessUnit,
  interleaveFrame,
  makeSenderReport,
} from '../src/rtp-packer.js';

function makeNal(len, fill = 0xab) {
  const nal = new Uint8Array(len);
  nal[0] = 0x65; // IDR slice, nri=3
  for (let i = 1; i < len; i++) nal[i] = fill;
  return nal;
}

function parseRtp(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[0] >> 6,
    marker: (bytes[1] & 0x80) !== 0,
    pt: bytes[1] & 0x7f,
    seq: dv.getUint16(2),
    timestamp: dv.getUint32(4),
    ssrc: dv.getUint32(8),
    payload: bytes.subarray(12),
  };
}

test('serializeRtp：版本/M 位/PT/序列号/时间戳/SSRC', () => {
  const p = parseRtp(serializeRtp({ marker: true, payloadType: 96, sequence: 65535, timestamp: 90000, ssrc: 7, payload: Uint8Array.from([9]) }));
  assert.equal(p.version, 2);
  assert.equal(p.marker, true);
  assert.equal(p.pt, 96);
  assert.equal(p.seq, 65535);
  assert.equal(p.timestamp, 90000);
  assert.equal(p.ssrc, 7);
  assert.deepEqual(Array.from(p.payload), [9]);
});

test('小 NAL → 单 NAL 包（type 不变）', () => {
  const nal = makeNal(50);
  const chunks = packetizeNal(nal, { mtu: 1200 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fuIndicator, null);
  assert.deepEqual(Array.from(chunks[0].payload), Array.from(nal));
});

test('大 NAL → FU-A 分片：S/E 位正确且可重组还原', () => {
  const nal = makeNal(1000);
  const chunks = packetizeNal(nal, { mtu: 300 });
  assert.ok(chunks.length >= 4);
  // 首 S=1 E=0；尾 E=1 S=0；中段皆无
  assert.equal(chunks[0].fuHeader & 0x80, 0x80);
  assert.equal(chunks[0].fuHeader & 0x40, 0);
  assert.equal(chunks.at(-1).fuHeader & 0x40, 0x40);
  assert.equal(chunks.at(-1).fuHeader & 0x80, 0);
  for (let i = 1; i < chunks.length - 1; i++) {
    assert.equal(chunks[i].fuHeader & 0xc0, 0);
  }
  // indicator 的 NRI 与类型
  assert.equal(chunks[0].fuIndicator >> 5, 3); // NRI 复用
  assert.equal(chunks[0].fuIndicator & 0x1f, 28);
  // FU type 携带原始 NAL 类型
  assert.equal(chunks[0].fuHeader & 0x1f, 5);
  // 独立重组还原原 NAL
  let out = [((chunks[0].fuIndicator >> 5) << 5) | (chunks[0].fuHeader & 0x1f)];
  for (const c of chunks) out = out.concat(Array.from(c.payload));
  assert.deepEqual(out, Array.from(nal));
});

test('多小 NAL → STAP-A 聚合，可解析回原 NAL 序列', () => {
  const sps = makeNal(12, 0x11); sps[0] = 0x67;
  const pps = makeNal(8, 0x22); pps[0] = 0x68;
  const idr = makeNal(30, 0x33);
  const packets = packetizeAccessUnit([sps, pps, idr], { mtu: 1200, sequence: 100, timestamp: 6000, ssrc: 1 });
  assert.equal(packets.length, 1, '总长小于 MTU 应聚合为单包');
  const rtp = parseRtp(packets[0].bytes);
  assert.equal(rtp.marker, true, 'AU 末包置 Marker');
  assert.equal(rtp.payload[0] & 0x1f, 24, 'STAP-A type');
  // 解析 STAP-A 条目
  const parsed = [];
  let off = 1;
  while (off < rtp.payload.length) {
    const len = (rtp.payload[off] << 8) | rtp.payload[off + 1];
    parsed.push(Array.from(rtp.payload.subarray(off + 2, off + 2 + len)));
    off += 2 + len;
  }
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], Array.from(sps));
  assert.deepEqual(parsed[2], Array.from(idr));
});

test('interleaveFrame 与 SenderReport 格式', () => {
  const f = interleaveFrame(0, Uint8Array.from([1, 2, 3]));
  assert.deepEqual(Array.from(f.subarray(0, 4)), [0x24, 0, 0, 3]);
  assert.deepEqual(Array.from(f.subarray(4)), [1, 2, 3]);
  const sr = makeSenderReport({ ssrc: 9, rtpTimestamp: 1, packetCount: 2, octetCount: 3, ntpSec: 4, ntpFrac: 5 });
  assert.equal(sr.length, 52);
  assert.equal(sr[1], 200);
  const dv = new DataView(sr.buffer);
  assert.equal(dv.getUint16(2), 12); // length words - 1 = (52/4)-1
});
