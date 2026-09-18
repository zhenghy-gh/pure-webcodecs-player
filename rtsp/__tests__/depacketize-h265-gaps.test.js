/**
 * H265Depacketizer 残余分支补测（第一百一十九波）
 * ------------------------------------------------------------
 * 覆盖：reset() 清理、乱序/过期 RTP 包丢弃、丢包计数、FU 载荷过短、
 * FU 不连续（单 NAL 插入 / 错序续片）→ #abortFu 的 fuDropped 计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { H265Depacketizer } from '../src/depacketize-h265.js';

const singleNal = (t = 1) => Uint8Array.from([t << 1, 0x01, 0xaa]); // 非 VPS/IRAP 的普通 NAL
const mkFu = (piece, s, e, fuType = 19) => {
  const p = new Uint8Array(3 + piece.length);
  p[0] = (49 << 1) & 0xff;
  p[1] = 0x01;
  p[2] = (s ? 0x80 : 0) | (e ? 0x40 : 0) | fuType;
  p.set(piece, 3);
  return p;
};

test('reset()：清空在途 FU 与缓冲 NAL、忘掉 maxSeqSeen（旧序号可重新接受）', () => {
  const d = new H265Depacketizer();
  d.push(singleNal(32), false, 200, 3000); // VPS，seq=200
  d.push(mkFu([0x11], true, false), false, 201, 3000); // 在途 FU
  d.reset();
  assert.equal(d.auNals.length, 0, 'reset 清空缓冲 NAL');
  assert.equal(d.fuPayload, null, 'reset 丢弃在途 FU');
  assert.equal(d.maxSeqSeen, null, 'reset 忘掉序号水位');
  // reset 后旧序号也可接受；此前在途 FU 的载荷不进任何帧
  const out = d.push(singleNal(1), true, 5, 3000);
  assert.equal(out.nals.length, 1);
  assert.equal(d.stats.packets, 3);
});

test('乱序/过期包：seq 回退 → 静默丢弃，不污染当前访问单元', () => {
  const d = new H265Depacketizer();
  d.push(singleNal(), false, 100, 3000);
  const before = d.auNals.length;
  const dropped = d.push(singleNal(), false, 98, 3000); // 旧序号
  assert.deepEqual(dropped, {}, '过期包返回空对象');
  assert.equal(d.auNals.length, before, '过期包不产生 NAL');
  assert.equal(d.maxSeqSeen, 100, '水位不被旧包回退');
  const out = d.push(singleNal(), true, 101, 3000);
  assert.equal(out.nals.length, 2, '后续新包正常入帧');
});

test('丢包计数：序号跳空 → lost = 跳空数 - 1', () => {
  const d = new H265Depacketizer();
  d.push(singleNal(), false, 1, 3000);
  d.push(singleNal(), true, 5, 3000); // 跳过 2/3/4
  assert.equal(d.stats.lost, 3);
  d.push(singleNal(), true, 6, 3000); // 连续不再累计
  assert.equal(d.stats.lost, 3);
});

test('FU 载荷不足 3 字节：中止在途 FU 并安全返回', () => {
  const d = new H265Depacketizer();
  d.push(mkFu([0x11, 0x22], true, false), false, 1, 3000); // FU 开始
  assert.equal(d.stats.fuStarted, 1);
  const out = d.push(Uint8Array.from([98, 0x01]), false, 2, 3000); // 仅 PayloadHdr
  assert.deepEqual(out, {});
  assert.equal(d.fuPayload, null, '短包触发 #abortFu');
  assert.equal(d.stats.fuDropped, 1);
});

test('FU 不连续：单 NAL 插入与错序续片均丢弃在途 FU', () => {
  const d = new H265Depacketizer();
  // ① 单 NAL 插入打断 FU
  d.push(mkFu([0x11], true, false), false, 1, 3000);
  let out = d.push(singleNal(), true, 2, 3000);
  assert.equal(out.nals.length, 1, '只有单 NAL 出帧');
  assert.equal(d.stats.fuDropped, 1);
  // ② 续片序号不符
  d.push(mkFu([0x22], true, false), false, 3, 3000);
  out = d.push(mkFu([0x33], false, true), true, 10, 3000); // 跳过 4..9
  assert.equal(out.nals.length, 0, '错序续片被整体丢弃，不产生任何 NAL');
  assert.equal(d.stats.fuDropped, 2);
  assert.equal(d.fuPayload, null);
  // ③ 不连续后新 FU 可正常开启
  d.push(mkFu([0x44], true, false), false, 11, 3000);
  const done = d.push(mkFu([0x55], false, true), true, 12, 3000);
  assert.equal(done.nals.length, 1);
  assert.deepEqual(Array.from(done.nals[0].subarray(2)), [0x44, 0x55]);
});
