/**
 * pcr.test.js —— TS PCR（节目时钟基准）提取与时长兜底
 * 重点覆盖 round-1 第十波修复：ts PCR 此前完全未提取（时长估算退化）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TsStreamEngine } from '../src/ts-stream-engine.js';

/** 构造一个 188 字节 TS 包：AF 含 PCR（base 33 位，ext 默认 0） */
function pcrPacket(pid, base, { discontinuity = false } = {}) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pid >> 8) & 0x1f); // pusi=1
  pkt[2] = pid & 0xff;
  pkt[3] = 0x30;                       // AF + payload，cc=0
  pkt[4] = 7;                         // afLen = flags(1) + PCR(6)
  pkt[5] = 0x10 | (discontinuity ? 0x80 : 0); // PCR_flag (+ 可选 discontinuity)
  const b0 = (base >> 25) & 0xff;
  const b1 = (base >> 17) & 0xff;
  const b2 = (base >> 9) & 0xff;
  const b3 = (base >> 1) & 0xff;
  const b4 = (base & 0x01) << 7;      // PCR_extension = 0
  pkt[6] = b0; pkt[7] = b1; pkt[8] = b2; pkt[9] = b3; pkt[10] = b4; pkt[11] = 0;
  return pkt;
}

test('PCR 从自适应域提取并 emit pcr 事件（90kHz tick）', () => {
  const e = new TsStreamEngine();
  e.packetSize = 188;
  e.syncOffsetInCell = 0;
  const evs = [];
  e.on('pcr', (p) => evs.push(p));
  e._parsePacket(pcrPacket(0x0100, 90000)); // 1s
  assert.equal(evs.length, 1);
  assert.equal(evs[0].pid, 0x0100);
  assert.equal(evs[0].pcr90k, 90000);
  assert.equal(evs[0].discontinuity, false);
  assert.equal(e._pcrFirst, 90000);
  assert.equal(e._pcrLast, 90000);
  assert.equal(e._pcrSeen, 1);
});

test('PCR 跨度驱动时长兜底（DTS 不可用时）', () => {
  const e = new TsStreamEngine();
  // 无 DTS 的轨道（首/尾 DTS 为 null）
  e.trackState.set('t:256', { track: { id: 256 }, firstDts: null, lastDtsRaw: null });
  e._pcrFirst = 0;
  e._pcrLast = 90000 * 10; // 10s
  let meta = null;
  e.on('metadata', (m) => (meta = m));
  e._emitMetadata(true);
  assert.ok(meta);
  assert.equal(meta.durationMs, 10000, '时长应由 PCR 跨度(10s)兜底');
  assert.equal(meta.pcrDurationMs, 10000);
});

test('DTS 跨度优先于 PCR 跨度（媒体时间线更准）', () => {
  const e = new TsStreamEngine();
  e.trackState.set('t:256', { track: { id: 256 }, firstDts: 0, lastDtsRaw: 90000 * 5 }); // 5s
  e._pcrFirst = 0;
  e._pcrLast = 90000 * 10; // PCR 跨度 10s
  let meta = null;
  e.on('metadata', (m) => (meta = m));
  e._emitMetadata(true);
  assert.equal(meta.durationMs, 5000, 'DTS 跨度(5s)应优先于 PCR(10s)');
  assert.equal(meta.pcrDurationMs, 10000);
});

test('PCR 不连续（discontinuity）重置跨度基准', () => {
  const e = new TsStreamEngine();
  e.packetSize = 188;
  e.syncOffsetInCell = 0;
  e._parsePacket(pcrPacket(0x0100, 90000));
  // 注入不连续 PCR（如拼接点），基准应重置而非累加
  e._parsePacket(pcrPacket(0x0100, 0, { discontinuity: true }));
  assert.equal(e._pcrFirst, 0);
  assert.equal(e._pcrLast, 0);
});
