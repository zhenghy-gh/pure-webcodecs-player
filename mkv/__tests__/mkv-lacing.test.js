/**
 * mkv-lacing.test.js —— lacing.js 四种连帧打包模式的直接单测
 *
 * 既有测试只经 demuxer 间接走通 xiph/fixed/ebml 的正常路径，本用例补齐：
 *   - LACING_NONE 视图语义；
 *   - Xiph：255 锁存链、截断、长度越界；
 *   - Fixed：等分与非等分报错；
 *   - EBML：有符号 VINT 差值往返（帧长递增/递减）、首帧未知长度、
 *     负帧长、长度越界；
 *   - signedVintValue / encodeSignedVint 的位宽边界二补码语义；
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
test('EBML：帧长递增（正差值）往返', () => {
  const f = [U8([1]), U8([2, 2]), U8([3, 3, 3])];
  const header = encodeEbmlLacingHeader(f.slice(0, -1).map((x) => x.length)); // [1,2]
  const { frames } = decodeLacing(LACING_EBML, bytes(header, ...f));
  assert.deepEqual(frames.map((f2) => f2.length), [1, 2, 3]);
});

test('EBML：帧长递减（负差值，二补码）往返', () => {
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
test('signedVintValue：1/2/3 字节位宽的二补码分界', () => {
  // 1 字节：7 数据位 → half=64，范围 -64..63
  assert.equal(signedVintValue(0, 1), 0);
  assert.equal(signedVintValue(63, 1), 63);
  assert.equal(signedVintValue(64, 1), -64);
  assert.equal(signedVintValue(127, 1), -1); // 全 1 位型（readSize 报 unknown→decode 按 -1）
  // 2 字节：14 数据位 → half=8192
  assert.equal(signedVintValue(8191, 2), 8191);
  assert.equal(signedVintValue(8192, 2), -8192);
  assert.equal(signedVintValue(16383, 2), -1);
  // 3 字节：21 数据位 → half=2^20
  assert.equal(signedVintValue(2 ** 20 - 1, 3), 2 ** 20 - 1);
  assert.equal(signedVintValue(2 ** 20, 3), -(2 ** 20));
});

test('encodeSignedVint：各位宽 min/max/0 往返（含 -1 → 全 1 位型）', () => {
  for (const [v, wantLen] of [
    [0, 1], [63, 1], [-64, 1], [-63, 1],
    [64, 2], [-65, 2], [8191, 2], [-8192, 2],
    [8192, 3], [-(2 ** 20), 3],
  ]) {
    const enc = encodeSignedVint(v);
    assert.equal(enc.length, wantLen, `值 ${v} 期望 ${wantLen} 字节`);
    const dec = readSize(enc, 0);
    const back = dec.unknown ? -1 : signedVintValue(dec.value, dec.length);
    assert.equal(back, v, `值 ${v} 往返失败`);
  }
});

test('encodeSignedVint(-1)：编码为全 1 位型，readSize 判为 unknown', () => {
  const enc = encodeSignedVint(-1);
  assert.deepEqual([...enc], [0xff]);
  assert.equal(readSize(enc, 0).unknown, true);
});

// ── 与 demuxer 集成：Block 内多帧 lacing 的样本形状 ──────
test('集成：BlockGroup 内 EBML lacing 递减帧，样本时间戳相同、数据各自正确', async () => {
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
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({
      trackNumber: 1, relTimecode: 7, lacing: 'ebml',
      frames: [new Uint8Array(4).fill(0xa), new Uint8Array(2).fill(0xb), new Uint8Array(1).fill(0xc)],
    }));
  }).done();
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
  assert.deepEqual(out.map((s) => s.size), [4, 2, 1]);
  assert.deepEqual(out.map((s) => s.data[0]), [0xa, 0xb, 0xc]);
  assert.deepEqual(out.map((s) => s.timestamp), [107_000, 107_000, 107_000]);
});
