import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRtp, seqNewer } from '../src/rtp.js';
import { serializeRtp } from '../../samples/gateway/src/rtp-packer.js';

test('基础字段解析（与网关 serializeRtp 互操作）', () => {
  const bytes = serializeRtp({ marker: true, payloadType: 96, sequence: 1024, timestamp: 90000 * 3, ssrc: 0xdeadbeef, payload: Uint8Array.from([1, 2, 3, 4]) });
  const p = parseRtp(bytes);
  assert.equal(p.version, 2);
  assert.equal(p.marker, true);
  assert.equal(p.payloadType, 96);
  assert.equal(p.sequence, 1024);
  assert.equal(p.timestamp, 270000);
  assert.equal(p.ssrc, 0xdeadbeef);
  assert.deepEqual(Array.from(p.payload), [1, 2, 3, 4]);
  assert.deepEqual(p.csrc, []);
  assert.equal(p.headerExtension, null);
});

test('CSRC 与扩展头跳过', () => {
  // 手工构造：V=2 CC=2 X=1 M=0 PT=97
  const payload = Uint8Array.from([9, 9, 9]);
  const ext = new Uint8Array(8); // 扩展头 4B 头 + 4B 数据
  ext[2] = 0; ext[3] = 1; // 长度=1 个 4 字节单元
  const head = new Uint8Array(12);
  head[0] = (2 << 6) | (1 << 4) | 2; // X + CC=2
  head[1] = 97;
  // 布局：12 头 + 8 CSRC + 8 扩展 + 3 载荷（RTP 无长度字段，缓冲区必须精确）
  const buf = new Uint8Array(12 + 8 + ext.length + payload.length);
  buf.set(head, 0);
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, 5); // seq
  dv.setUint32(4, 77); // ts
  dv.setUint32(8, 1); // ssrc
  let off = 12;
  dv.setUint32(off, 111); off += 4;
  dv.setUint32(off, 222); off += 4;
  buf.set(ext, off); off += ext.length;
  buf.set(payload, off);

  const p = parseRtp(buf);
  assert.deepEqual(p.csrc, [111, 222]);
  assert.ok(p.extension);
  assert.equal(p.headerExtension.length, 8);
  assert.equal(p.payloadType, 97);
  assert.equal(p.sequence, 5);
  assert.deepEqual(Array.from(p.payload), [9, 9, 9]);
});

test('padding 解析', () => {
  // RFC 3550：末字节为需忽略的填充字节数（含自身）。
  // 数据 [7] + 填充 [1,2,3] + 计数字节 4 → 共 5 字节载荷字段
  const bytes = serializeRtp({ payloadType: 96, sequence: 1, timestamp: 1, ssrc: 1, payload: Uint8Array.from([7, 1, 2, 3, 4]) });
  bytes[0] |= 0x20; // P 位
  const p = parseRtp(bytes);
  assert.equal(p.padding, true);
  assert.equal(p.paddingLength, 4);
  assert.deepEqual(Array.from(p.payload), [7]);
});

test('畸形包抛错', () => {
  assert.throws(() => parseRtp(new Uint8Array(11)), /过短|short/i);
  const bad = serializeRtp({ payloadType: 96, sequence: 1, timestamp: 1, ssrc: 1, payload: new Uint8Array(4) });
  bad[0] = (3 << 6) | bad[0] & 0x3f; // 版本改 3
  assert.throws(() => parseRtp(bad), /版本/);
});

test('序列号回绕比较 seqNewer', () => {
  assert.equal(seqNewer(1, 0), true);
  assert.equal(seqNewer(0, 65535), true, '回绕后应判新');
  assert.equal(seqNewer(65535, 0), false);
  assert.equal(seqNewer(100, 100), false);
});
