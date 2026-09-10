/**
 * mkv-timestamp.test.js —— Block/Cluster 时间戳计算与 Keyframe 判定边界
 *
 * 经 demuxer pull 通道验证（parseBlockHeader / #emitBlockFrames 为私有，
 * 须走真实解码路径）：负相对时间码、BlockDuration 均摊、DiscardPadding
 * 有符号解码、视频关键帧判定（SimpleBlock 关键帧位 / BlockGroup ReferenceBlock）、
 * 音频轨关键帧恒 true、tScale(TimecodeScale) 缩放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize } from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

/** 内联拼装最小 Segment：Info(Timescale) + Tracks + 单 Cluster(可含多子元素) */
function buildMini({ tracksBuild, clusterTimecode = 0, clusterChildren, timecodeScale = 1_000_000 }) {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1);
    w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, timecodeScale);
    w.f(ID.Duration, 10, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, tracksBuild).done();
  const cluster = new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, clusterTimecode);
    for (const b of clusterChildren) w.raw(b);
  }).done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cluster.length));
  root.raw(info); root.raw(tracks); root.raw(cluster);
  return root.done();
}

const vp9Track = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
  t.master(ID.Video, (v) => { v.u(ID.PixelWidth, 64); v.u(ID.PixelHeight, 64); });
});
const opusTrack = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 2); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_OPUS');
  t.b(ID.CodecPrivate, Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0, 1, 0, 0, 0xbb, 0x80, 0, 0]));
});

// ── 负相对时间码（簇内回看）──────────────────────────────
test('时间戳：集群时间码 + 负相对时间码 → 正确 µs', async () => {
  const block = new EbmlWriter().leaf(
    ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: -500, keyframe: true, frames: [U8([1, 2, 3, 4])] }),
  ).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterTimecode: 1000, clusterChildren: [block] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  // 1000ms - 500ms = 500000µs
  assert.equal(s.timestamp, 500_000);
});

test('时间戳：TimecodeScale 缩放生效（2e6 → µs = ticks/2）', async () => {
  // 默认 scale=1e6 下 relTimecode 单位为毫秒；scale=2e6 时 tick=2ms
  const block = new EbmlWriter().leaf(
    ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 10, keyframe: true, frames: [U8([1])] }),
  ).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterTimecode: 0, clusterChildren: [block], timecodeScale: 2_000_000 });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  // 10 ticks * (2e6/1000) = 20000µs
  assert.equal(s.timestamp, 20_000);
});

// ── SimpleBlock 关键帧位（视频）──────────────────────────
test('Keyframe：视频 SimpleBlock 关键帧位正确解码', async () => {
  const kf = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [U8([1])] })).done();
  const non = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: false, frames: [U8([2])] })).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterChildren: [kf, non] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const a = await d.readSample(1);
  const b = await d.readSample(1);
  assert.equal(a.keyframe, true);
  assert.equal(b.keyframe, false, '视频非关键帧位应解析为 false');
});

test('Keyframe：音频轨关键帧恒 true（契约 §1.1）', async () => {
  const block = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 2, relTimecode: 0, keyframe: false, frames: [U8([9, 9])] })).done();
  const bytes = buildMini({ tracksBuild: opusTrack, clusterChildren: [block] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(2);
  assert.equal(s.keyframe, true, '音频轨关键帧必须恒 true');
});

// ── BlockGroup：ReferenceBlock / BlockDuration / DiscardPadding ──
test('BlockGroup：有 ReferenceBlock → 视频非关键帧；无 → 关键帧', async () => {
  const withRef = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([1, 1])] }));
    g.i(ID.ReferenceBlock, -1);
  }).done();
  const noRef = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 5, frames: [U8([2, 2])] }));
  }).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterChildren: [withRef, noRef] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const a = await d.readSample(1);
  const b = await d.readSample(1);
  assert.equal(a.keyframe, false);
  assert.equal(b.keyframe, true, '无 ReferenceBlock 的 BlockGroup 应判为关键帧');
});

test('BlockDuration：多帧均摊（余数补给末帧），durationUs 之和 == 总时长', async () => {
  // 3 帧 Xiph lacing + BlockDuration=100(tick) @ scale=1e6 → 100000µs
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({
      trackNumber: 1, relTimecode: 0, lacing: 'xiph',
      // 注意：U8(n) 实为 Uint8Array.from(n)，传数字会得到空数组；定长填充必须 new Uint8Array(n)
      frames: [new Uint8Array(10).fill(1), new Uint8Array(20).fill(2), new Uint8Array(30).fill(3)],
    }));
    g.u(ID.BlockDuration, 100);
  }).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterChildren: [bg] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const frames = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    frames.push(s);
  }
  assert.equal(frames.length, 3);
  const total = frames.reduce((a, s) => a + s.duration, 0);
  assert.equal(total, 100_000, '三帧 duration 之和应等于 BlockDuration 总时长');
  // 末帧多拿余数：100000/3 ≈ 33333.33 → [33333,33333,33334]
  assert.deepEqual(frames.map((f) => f.duration), [33333, 33333, 33334]);
});

test('DiscardPadding：有符号解码（正/负 → µs）', async () => {
  const pos = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([1])] }));
    g.i(ID.DiscardPadding, 2000); // +2000ns → +2µs
  }).done();
  const neg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([2])] }));
    g.i(ID.DiscardPadding, -1000); // -1000ns → -1µs
  }).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterChildren: [pos, neg] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const a = await d.readSample(1);
  const b = await d.readSample(1);
  assert.equal(a.discardPaddingUs, 2);
  assert.equal(b.discardPaddingUs, -1);
});

// ── 过滤：seek 窗口 fromUs/stopUs 边界排除样本 ─────────────
test('时间戳：fromUs/stopUs 窗口外样本被丢弃', async () => {
  const b0 = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [U8([1])] })).done();
  const b1 = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 1000, keyframe: false, frames: [U8([2])] })).done();
  const bytes = buildMini({ tracksBuild: vp9Track, clusterTimecode: 0, clusterChildren: [b0, b1] });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  // 直接经 samplesInternal 注入窗口：0<=ts<500000µs → 只应取 b0(0)
  let count = 0;
  for await (const s of d.samplesInternal({ trackIds: [1], fromUs: 0, stopUs: 500_000 })) {
    assert.equal(s.timestampUs, 0);
    count++;
  }
  assert.equal(count, 1);
});
