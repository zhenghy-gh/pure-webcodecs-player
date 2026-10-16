/**
 * mkv-lacing.test.js —— lacing.js 四种连帧打包模式的直接单测
 *
 * 既有测试只经 demuxer 间接走通 xiph/fixed/ebml 的正常路径，本用例补齐：
 *   - LACING_NONE 视图语义；
 *   - Xiph：255 锁存链、截断、长度越界；
 *   - Fixed：等分与非等分报错；
 *   - EBML：标准偏置有符号 VINT 差值、外部字节向量、首帧未知长度、负帧长与越界；
 *   - signedVintValue / encodeSignedVint 的 EBML 偏置映射边界；
 *   - encodeXiphHeader / encodeEbmlLacingHeader 与其解码的自洽往返。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeLacing, signedVintValue, encodeSignedVint,
  encodeXiphHeader, encodeEbmlLacingHeader,
  LACING_NONE, LACING_XIPH, LACING_FIXED, LACING_EBML,
  readSize, MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);
const bytes = (...parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const join = (frames) => bytes(...frames);

// ── LACING_NONE ─────────────────────────────────────────
test('decodeLacing none：单帧返回整段视图（零拷贝，共享底层 buffer）', () => {
  const data = U8([1, 2, 3, 4]);
  const { frames, headerBytes } = decodeLacing(LACING_NONE, data);
  assert.equal(frames.length, 1);
  assert.equal(headerBytes, 0);
  assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
  assert.equal(frames[0].buffer, data.buffer, 'subarray 应共享底层 buffer');
});

test('decodeLacing 常量：契约数值 0/1/2/3', () => {
  assert.equal(LACING_NONE, 0);
  assert.equal(LACING_XIPH, 1);
  assert.equal(LACING_FIXED, 2);
  assert.equal(LACING_EBML, 3);
});

// ── Xiph ────────────────────────────────────────────────
test('Xiph：三帧编码头往返，末帧由余量推得', () => {
  const f = [U8([1, 1]), U8([2, 2, 2]), U8([3, 3, 3, 3])];
  const header = encodeXiphHeader(f.slice(0, -1).map((x) => x.length)); // [2,3]
  const data = bytes(header, ...f);
  const { frames, headerBytes } = decodeLacing(LACING_XIPH, data);
  assert.equal(headerBytes, header.length);
  assert.deepEqual(frames.map((x) => x.length), [2, 3, 4]);
  assert.deepEqual([...frames[2]], [3, 3, 3, 3]);
});

test('Xiph：255 锁存链（≥255 的长度拆为 255*n + 余数）往返', () => {
  const big = new Uint8Array(300).fill(0x7a);
  const last = new Uint8Array(5).fill(0x7b);
  const header = encodeXiphHeader([big.length]); // 帧数1 + 锁存 255,45
  assert.deepEqual([...header], [1, 255, 45]); // 首字节=帧数-1
  const { frames } = decodeLacing(LACING_XIPH, bytes(header, big, last));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 300);
  assert.equal(frames[1].length, 5);
});

test('Xiph：锁存链截断 → 抛错（不产出 NaN 长度垃圾帧）', () => {
  // 帧数=2 → 需读 1 个尺寸；sizes[0] 后消费 200 字节，但数据仅 3 字节
  const data = U8([1, 200, 0]);
  assert.throws(() => decodeLacing(LACING_XIPH, data), /截断|越界/);
});

test('Xiph：末帧长度越界（负值）→ 抛错', () => {
  // 锁存声明 sizes[0]=50，实际只有 10 字节
  const data = U8([1, 50, 0, 0, 0]);
  assert.throws(() => decodeLacing(LACING_XIPH, data), /越界/);
});

// ── Fixed ───────────────────────────────────────────────
test('Fixed：等分三帧', () => {
  const data = U8([2, 1, 1, 2, 2, 3, 3]); // 帧数-1=2 → 3 帧
  const { frames, headerBytes } = decodeLacing(LACING_FIXED, data);
  assert.equal(headerBytes, 1);
  assert.deepEqual(frames.map((f) => [...f]), [[1, 1], [2, 2], [3, 3]]);
});

test('Fixed：无法等分 → 抛错并带 body/frameCount 诊断', () => {
  const data = U8([2, 1, 2, 3, 4]); // body=4 无法被 3 整除
  assert.throws(() => decodeLacing(LACING_FIXED, data), /无法等分/);
});

// ── EBML lacing（有符号 VINT 差值）───────────────────────
test('EBML：规范偏置编码的外部负差值 0xBD 解为 -2（5,3,1）', () => {
  // 该向量独立于本模块 encoder：数据位 0x3D=61，偏置 63，故差值为 -2。
  const data = U8([2, 0x85, 0xBD, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const { frames, headerBytes } = decodeLacing(LACING_EBML, data);
  assert.equal(headerBytes, 3);
  assert.deepEqual(frames.map((frame) => frame.length), [5, 3, 1]);
  assert.deepEqual(frames.map((frame) => [...frame]), [[1, 2, 3, 4, 5], [6, 7, 8], [9]]);
});
test('EBML：二字节负差值按偏置解码，signed 全 1 位型仍为最大正值', () => {
  // 二字节 raw=0x1FFD=8189，偏置 8191，故 delta=-2。
  const twoByte = U8([2, 0x85, 0x5f, 0xfd, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(decodeLacing(LACING_EBML, twoByte).frames.map((frame) => frame.length), [5, 3, 1]);
  // 1-byte all-ones payload 是 signed +64（虽然 unsigned Size 解码器称其 unknown）。
  const allOnes = U8([2, 0x81, 0xff, ...new Uint8Array(67)]);
  assert.deepEqual(decodeLacing(LACING_EBML, allOnes).frames.map((frame) => frame.length), [1, 65, 1]);
});
test('EBML：八字节有符号 VINT 的标记位不计入数据位', () => {
  // 八字节 VINT 标记字节为 0x01；后七字节全 FFFD 表示 -2。
  const data = U8([2, 0x85, 0x01, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfd, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(decodeLacing(LACING_EBML, data).frames.map((frame) => frame.length), [5, 3, 1]);
  assert.deepEqual([...encodeSignedVint(-2)], [0xbd]);
  assert.deepEqual([...encodeSignedVint(-(2 ** 52))], [0x01, 0x6f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
});
test('EBML：帧长递增（正差值）往返', () => {
  const f = [U8([1]), U8([2, 2]), U8([3, 3, 3])];
  const header = encodeEbmlLacingHeader(f.slice(0, -1).map((x) => x.length)); // [1,2]
  const { frames } = decodeLacing(LACING_EBML, bytes(header, ...f));
  assert.deepEqual(frames.map((f2) => f2.length), [1, 2, 3]);
});

test('EBML：帧长递减（负差值，标准偏置编码）往返', () => {
  const f = [U8([1, 1, 1, 1, 1]), U8([2, 2, 2]), U8([3])];
  const header = encodeEbmlLacingHeader(f.slice(0, -1).map((x) => x.length)); // [5,3] → 差值 -2
  const { frames } = decodeLacing(LACING_EBML, bytes(header, ...f));
  assert.deepEqual(frames.map((f2) => f2.length), [5, 3, 1]);
});

test('EBML：首帧尺寸为未知长度 VINT → 抛错', () => {
  // data[0]=1（2 帧），首帧尺寸字节 0xFF = 1 字节未知长度
  const data = U8([1, 0xff, 0, 0, 0]);
  assert.throws(() => decodeLacing(LACING_EBML, data), /首帧尺寸非法/);
});

test('EBML：差值使帧长转负 → 抛错（负帧长保护）', () => {
  // 3 帧：首帧 VINT(2)；中间帧差值 -5 → 帧长 2-5 = -3
  const header = bytes(U8([2]), encodeSize(2), encodeSignedVint(-5));
  const data = bytes(header, U8([9, 9]), U8([9, 9, 9]));
  assert.throws(() => decodeLacing(LACING_EBML, data), /负帧长/);
});

test('EBML：帧尺寸之和超出可用数据 → 抛错', () => {
  // 首帧声明 200，实际只有 3 字节 body
  const data = bytes(U8([0]), encodeSize(200), U8([1, 2, 3]));
  assert.throws(() => decodeLacing(LACING_EBML, data), /越界/);
});

test('decodeLacing：未知 lacing 类型（4）→ 抛错', () => {
  assert.throws(() => decodeLacing(4, U8([1, 2, 3])), /未知 lacing 类型/);
});

// ── 有符号 VINT 位宽边界 ────────────────────────────────
test('signedVintValue：1/2/3 字节 EBML 偏置编码边界', () => {
  // Signed EBML VINT：signed = raw - bias；bias(1B)=63，bias(2B)=8191。
  assert.equal(signedVintValue(0, 1), -63);
  assert.equal(signedVintValue(61, 1), -2);
  assert.equal(signedVintValue(63, 1), 0);
  assert.equal(signedVintValue(127, 1), 64); // 全 1 位型是合法最大正值
  assert.equal(signedVintValue(0, 2), -8191);
  assert.equal(signedVintValue(8190, 2), -1);
  assert.equal(signedVintValue(8191, 2), 0);
  assert.equal(signedVintValue(16383, 2), 8192);
  assert.equal(signedVintValue(0, 3), -(2 ** 20 - 1));
  assert.equal(signedVintValue(2 ** 20 - 1, 3), 0);
  assert.equal(signedVintValue(2 ** 21 - 1, 3), 2 ** 20);
  assert.equal(signedVintValue((1n << 55n) - 3n, 8), -2);
  assert.equal(signedVintValue((1n << 55n) - 1n, 8), 0);
  assert.throws(() => signedVintValue(128, 1), /超出 1 字节范围/);
  assert.throws(() => signedVintValue(-1, 1), /原始值/);
  assert.throws(() => signedVintValue(-1n, 8), /原始值/);
});

test('encodeSignedVint：偏置范围内编码并与独立 decoder 往返', () => {
  for (const [v, wantLen] of [
    [-63, 1], [-2, 1], [-1, 1], [0, 1], [1, 1], [64, 1],
    [-8191, 2], [-8192, 3], [8192, 2],
    [-(2 ** 20 - 1), 3], [2 ** 20, 3],
  ]) {
    const enc = encodeSignedVint(v);
    assert.equal(enc.length, wantLen, `值 ${v} 期望 ${wantLen} 字节`);
    const raw = readSize(enc, 0);
    const rawValue = raw.unknown ? (2 ** (7 * raw.length) - 1) : raw.value;
    assert.equal(signedVintValue(rawValue, raw.length), v, `值 ${v} 往返失败`);
  }
});

test('encodeSignedVint(-1)：负一载荷编码为 0x3E（含标记字节 0xBE）', () => {
  const enc = encodeSignedVint(-1);
  assert.deepEqual([...enc], [0xbe]);
  assert.equal(readSize(enc, 0).unknown, false);
  assert.equal(signedVintValue(readSize(enc, 0).value, 1), -1);
});

// ── 与 demuxer 集成：Block 内多帧 lacing 的样本形状 ──────
test('集成：外部标准偏置编码的 EBML Block 保留全部 laced frames', async () => {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 10, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, (w) => {
    w.master(ID.TrackEntry, (t) => {
      t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
    });
  }).done();
  // Block: track VINT 0x81, relTimecode 7, EBML-lacing flags 0x06, then
  // literal lace vector [2,0x85,0xBD] and nine frame bytes; -2 is raw 61 - bias 63.
  const block = U8([0x81, 0x00, 0x07, 0x06, 2, 0x85, 0xBD, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0b, 0x0b, 0x0b, 0x0c]);
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => g.leaf(ID.Block, block)).done();
  const cluster = new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, 100); w.raw(bg);
  }).done();
  const root = new EbmlWriter();
  root.raw(header); root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cluster.length));
  root.raw(info); root.raw(tracks); root.raw(cluster);

  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  const out = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    out.push(s);
  }
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.size), [5, 3, 1]);
  assert.deepEqual(out.map((s) => [...s.data]), [[0xa, 0xa, 0xa, 0xa, 0xa], [0xb, 0xb, 0xb], [0xc]]);
  assert.deepEqual(out.map((s) => s.timestamp), [107_000, 107_000, 107_000]);
});
