import { test } from 'node:test';
import assert from 'node:assert/strict';

import { H264Depacketizer } from '../src/depacketize-h264.js';
import { H265Depacketizer } from '../src/depacketize-h265.js';

/** 带自增序列号的推包器（timestamp 固定 3000） */
function makeFeeder() {
  let seq = 100;
  return {
    get seq() { return seq; },
    set seq(v) { seq = v; },
    push(d, payload, marker, ts = 3000) {
      const s = seq++;
      return d.push(payload, marker, s & 0xffff, ts);
    },
  };
}

// ---------------- H264 ----------------

test('H264 单 NAL 包 + Marker 出帧', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  const nal = Uint8Array.from([0x65, 1, 2, 3]);
  const out = f.push(d, nal, true, 9000);
  assert.equal(out.nals.length, 1);
  assert.deepEqual(Array.from(out.nals[0]), Array.from(nal));
  assert.equal(out.keyframe, true);
});

test('H264 STAP-A 聚合包解析', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  // STAP-A: type=24 + [len+nal]×2
  const sps = Uint8Array.from([0x67, 0x42, 0xc0, 0x1e]);
  const pps = Uint8Array.from([0x68, 0xcb]);
  const stap = new Uint8Array(1 + 2 + sps.length + 2 + pps.length);
  stap[0] = (3 << 5) | 24;
  let off = 1;
  for (const n of [sps, pps]) {
    stap[off++] = n.length >> 8;
    stap[off++] = n.length & 0xff;
    stap.set(n, off);
    off += n.length;
  }
  const out = f.push(d, stap, true);
  assert.equal(out.nals.length, 2);
  assert.deepEqual(Array.from(out.nals[0]), Array.from(sps));
  assert.deepEqual(Array.from(out.nals[1]), Array.from(pps));
});

test('H264 STAP-B：跳过 2 字节 DON 后正常解析', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  const nal = Uint8Array.from([0x41, 9]); // 非 IDR 单元
  const stapB = new Uint8Array(1 + 2 + 2 + nal.length); // hdr + DON(2) + len + nal
  stapB[0] = (2 << 5) | 25;
  stapB[1] = 0x00; stapB[2] = 0x07; // DON
  stapB[3] = 0; stapB[4] = nal.length;
  stapB.set(nal, 5);
  const out = f.push(d, stapB, false);
  void out; // AU 未结束
  const fin = f.push(d, Uint8Array.from([0x65, 7]), true);
  assert.equal(fin.nals.length, 2);
  assert.deepEqual(Array.from(fin.nals[0]), Array.from(nal));
});

test('H264 FU-A 三片重组还原原始 NAL', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  const orig = new Uint8Array(11);
  orig[0] = 0x65; // IDR
  for (let i = 1; i < orig.length; i++) orig[i] = i * 3;

  const body = orig.subarray(1);
  const pieces = [body.slice(0, 4), body.slice(4, 8), body.slice(8)];
  const fuPacket = (piece, s, e) => {
    const p = new Uint8Array(2 + piece.length);
    p[0] = (orig[0] & 0x60) | 28; // indicator
    p[1] = (s ? 0x80 : 0) | (e ? 0x40 : 0) | 5; // FU header
    p.set(piece, 2);
    return p;
  };

  assert.deepEqual(f.push(d, fuPacket(pieces[0], true, false), false), {});
  assert.deepEqual(f.push(d, fuPacket(pieces[1], false, false), false), {});
  const out = f.push(d, fuPacket(pieces[2], false, true), true);
  assert.equal(out.nals.length, 1, 'Marker 应收束整帧');
  assert.equal(d.stats.fuStarted, 1);
  assert.equal(d.stats.fuDropped, 0);
  assert.deepEqual(Array.from(out.nals[0]), Array.from(orig));
  assert.equal(out.keyframe, true);
});

test('H264 FU-A 中途丢包：丢弃半成品并等待下一个 S 位', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  const body = new Uint8Array(20).fill(0xaa);

  const fuPacket = (piece, off, s, e) => {
    const p = new Uint8Array(2 + piece.length);
    p[0] = (0x60) | 28;
    p[1] = (s ? 0x80 : 0) | (e ? 0x40 : 0) | 5;
    p.set(piece, 2);
    void off;
    return p;
  };
  const pieceA = body.slice(0, 10);
  const pieceB = body.slice(10);

  f.push(d, fuPacket(pieceA, 0, true, false), false); // S 片
  // 模拟丢包：跳过一个序号后直接发 E 片
  f.seq += 1;
  f.push(d, fuPacket(pieceB, 10, false, true), true);
  assert.equal(d.stats.fuDropped, 1, '半成品应被丢弃');

  // 下一个完整单包仍可正常出帧（feeder 序号继续前进，保持"更新"）
  const out = f.push(d, Uint8Array.from([0x65, 5]), true);
  assert.equal(out.nals.length, 1);
  assert.equal(out.nals[0][0], 0x65);
});

test('H264 迟到/重复包被忽略', () => {
  const d = new H264Depacketizer();
  const f = makeFeeder();
  f.push(d, Uint8Array.from([0x65, 1]), true, 1000); // seq=100
  // 手工构造更小序号的迟到重传包
  const late = d.push(Uint8Array.from([0x65, 9]), true, 50, 999);
  assert.equal(late.nals, undefined, '迟到包不应产生新帧');
});

// ---------------- H265 ----------------

test('H265 单 NAL 包（2 字节头）+ Marker 出帧', () => {
  const d = new H265Depacketizer();
  const f = makeFeeder();
  // IDR_W_RADL(19)：首字节 = 19<<1 = 38 = 0x26
  const nal = Uint8Array.from([0x26, 0x01, 0xaa, 0xbb]);
  const out = f.push(d, nal, true);
  assert.equal(out.nals.length, 1);
  assert.equal(out.keyframe, true);
});

test('H265 AP 聚合包解析', () => {
  const d = new H265Depacketizer();
  const f = makeFeeder();
  const vps = Uint8Array.from([0x40, 0x01, 1, 2]);
  const sps = Uint8Array.from([0x42, 0x01, 3, 4, 5]);
  const ap = new Uint8Array(2 + 2 + vps.length + 2 + sps.length);
  ap[0] = (48 << 1) & 0xff; // type 48 → 96 = 0x60
  ap[1] = 0x01;
  let off = 2;
  for (const n of [vps, sps]) {
    ap[off++] = n.length >> 8;
    ap[off++] = n.length & 0xff;
    ap.set(n, off);
    off += n.length;
  }
  const out = f.push(d, ap, true);
  assert.equal(out.nals.length, 2);
  assert.deepEqual(Array.from(out.nals[0]), Array.from(vps));
  assert.deepEqual(Array.from(out.nals[1]), Array.from(sps));
});

test('H265 FU 分片重组：还原 2 字节 NAL 头', () => {
  const d = new H265Depacketizer();
  const f = makeFeeder();
  // 原 NAL：type=19 → hdr = [0x26, 0x01]，体 8 字节
  const origHdr = [0x26, 0x01];
  const body = new Uint8Array(8).fill(0x77);
  const half = Math.ceil(body.length / 2);

  const mkFu = (piece, s, e) => {
    const p = new Uint8Array(3 + piece.length);
    p[0] = (49 << 1) & 0xff; // PayloadHdr type=49 → 98 = 0x62
    p[1] = 0x01;
    p[2] = (s ? 0x80 : 0) | (e ? 0x40 : 0) | 19;
    p.set(piece, 3);
    return p;
  };

  assert.deepEqual(f.push(d, mkFu(body.slice(0, half), true, false), false), {});
  const out = f.push(d, mkFu(body.slice(half), false, true), true);
  assert.equal(out.nals.length, 1);
  const rebuilt = out.nals[0];
  assert.equal(rebuilt.length, 2 + body.length);
  assert.equal(rebuilt[0], origHdr[0], '还原的 NAL 头第 1 字节');
  assert.equal(rebuilt[1], origHdr[1], '还原的 NAL 头第 2 字节');
  assert.deepEqual(Array.from(rebuilt.subarray(2)), Array.from(body));
  assert.equal(out.keyframe, true);
});

test('H265 DONL 模式：AP/FU 的 DONL 字段被解析并跳过', () => {
  const d = new H265Depacketizer({ donl: true });
  const f = makeFeeder();

  // AP 带 DONL：PayloadHdr(2) + DONL(2) + len + nal
  const nal = Uint8Array.from([0x42, 0x01, 0xdd]);
  const ap = new Uint8Array(2 + 2 + 2 + nal.length);
  ap[0] = 96; ap[1] = 0x01;
  ap[2] = 0; ap[3] = 9; // DONL
  ap[4] = 0; ap[5] = nal.length;
  ap.set(nal, 6);
  let out = f.push(d, ap, false);

  // FU 带 DONL（S=1）：PayloadHdr(2) + FUhdr(1) + DONL(2) + data
  const fuS = new Uint8Array(5 + 2);
  fuS[0] = 98; fuS[1] = 0x01;
  fuS[2] = 0x80 | 19;
  fuS[3] = 0; fuS[4] = 4; // DONL
  fuS[5] = 0x11; fuS[6] = 0x22;
  f.push(d, fuS, false);

  const fuE = Uint8Array.from([98, 0x01, 0x40 | 19, 0x33]);
  out = f.push(d, fuE, true);  assert.equal(out.nals.length, 2, 'AP 的 NAL 与 FU 还原的 NAL 应同帧输出');
  assert.deepEqual(Array.from(out.nals[0]), Array.from(nal));
  const fuRebuilt = out.nals[1];
  assert.equal(fuRebuilt[0], 0x26);
  assert.equal(fuRebuilt[1], 0x01);
  assert.deepEqual(Array.from(fuRebuilt.subarray(2)), [0x11, 0x22, 0x33]);
});
