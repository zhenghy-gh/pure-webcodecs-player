/**
 * H264Depacketizer 残余分支补测（131 波）：
 * reset() 状态清空、type 0/29-31 未定义类型忽略、未完成 FU 被新 NAL/未定义类型作废。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { H264Depacketizer } from '../src/depacketize-h264.js';

/** FU-A 首片：indicator(NRI=3,28) + FU header(S=1,Type=type) + 载荷 */
function fuStart(type, data, nri = 3) {
  return new Uint8Array([(nri << 5) | 28, 0x80 | type, ...data]);
}
/** FU-A 中间片 */
function fuMid(type, data, e = false) {
  return new Uint8Array([0x7c, (e ? 0x40 : 0) | type, ...data]);
}

test('reset()：全部状态归零，行为等同新实例', () => {
  const d = new H264Depacketizer();
  d.push(fuStart(5, [1, 2, 3]), false, 1, 1000);
  d.push(new Uint8Array([0x65, 9]), true, 2, 1000); // 触发 FU 作废 + AU 收束
  assert.ok(d.stats.fuStarted >= 1);
  d.reset();
  assert.equal(d.fuPayload, null);
  assert.deepEqual(d.auNals, []);
  assert.equal(d.maxSeqSeen, null);
  assert.deepEqual(d.stats, { packets: 0, lost: 0, frames: 0, fuStarted: 0, fuDropped: 0, stap: 0 });
  // reset 后序列号从零重新接受
  const out = d.push(new Uint8Array([0x65, 7]), true, 1, 2000);
  assert.equal(out.keyframe, true);
  assert.equal(out.nals.length, 1);
});

test('未定义类型（29）到达 → 忽略且未完成 FU 被作废（fuDropped 计数）', () => {
  const d = new H264Depacketizer();
  d.push(fuStart(5, [1, 2, 3]), false, 1, 1000);
  assert.equal(d.stats.fuStarted, 1);
  assert.ok(d.fuPayload, 'FU 进行中');
  const out = d.push(new Uint8Array([0x1d, 0xaa]), false, 2, 1000); // type 29
  assert.deepEqual(out, {});
  assert.equal(d.fuPayload, null);
  assert.equal(d.stats.fuDropped, 1);
});

test('未完成 FU 遇到新单 NAL → 作废（#abortFu body）且 AU 照常收束', () => {
  const d = new H264Depacketizer();
  d.push(fuStart(5, [1, 2, 3]), false, 1, 1000);
  const out = d.push(new Uint8Array([0x65, 9, 9]), true, 2, 1000); // 单 NAL IDR + marker
  assert.equal(d.stats.fuDropped, 1);
  assert.equal(out.nals.length, 1);
  assert.equal(out.keyframe, true);
  assert.equal((out.nals[0][0] & 0x1f), 5);
});

test('FU-A：保留位、S/E 同时置位及非法 NAL 类型均拒绝', () => {
  for (const fuHeader of [0xa5, 0xc5, 0x80]) {
    const d = new H264Depacketizer();
    const out = d.push(Uint8Array.from([0x7c, fuHeader, 1, 2]), true, 1, 1000);
    assert.deepEqual(out.nals, []);
    assert.equal(d.fuPayload, null);
  }
});

test('STAP-A/B：截断的聚合条目不输出前序部分 NAL', () => {
  for (const stap of [
    Uint8Array.from([24, 0, 1, 0x65, 0, 2, 0x41]),
    Uint8Array.from([25, 0, 1, 0, 1, 0x65, 0, 2, 0x41]),
    Uint8Array.from([24, 0, 1, 0x65, 0]),
  ]) {
    const d = new H264Depacketizer();
    const out = d.push(stap, true, 1, 1000);
    assert.deepEqual(out.nals, []);
  }
});

test('Marker：在途 FU 未收到结束片时作废，后续访问单元不继承残片', () => {
  const d = new H264Depacketizer();
  d.push(fuStart(5, [1, 2, 3]), false, 1, 1000);
  const out = d.push(fuMid(5, [4, 5]), true, 2, 2000);
  assert.deepEqual(out.nals, []);
  assert.equal(d.fuPayload, null);
  assert.equal(d.stats.fuDropped, 1);

  const next = d.push(new Uint8Array([0x41, 9]), true, 3, 3000);
  assert.equal(next.nals.length, 1);
  assert.deepEqual(Array.from(next.nals[0]), [0x41, 9]);
});

test('type 0（未定义）静默忽略，不产生 NAL', () => {
  const d = new H264Depacketizer();
  const out = d.push(new Uint8Array([0x00, 0xaa]), true, 1, 1000);
  assert.deepEqual(out, { nals: [], keyframe: false });
  assert.equal(d.stats.packets, 1);
});
