/**
 * mkv-blockgroup-cluster.test.js —— BlockGroup 深水区与 Cluster 边界
 *
 * 既有 mkv-timestamp.test.js 覆盖了 BlockGroup 的 ReferenceBlock/BlockDuration/
 * DiscardPadding 基础路径；本用例补齐：
 *   - BlockGroup 内的 BlockAdditions 子树（BlockMore/BlockAddID/BlockAdditional）
 *     不污染块解析、无 Block 时不产出、BlockDuration=0、ReferencePriority 不降关键帧、
 *     Block 内 lacing；
 *   - Cluster 无 ClusterTimecode 的兜底、跨簇时间戳基准、8 字节未知长度
 *     Cluster/Segment 的流式边界探测、簇内 Void/CRC32/PrevSize 跳过；
 *   - 簇内非规范子元素（deprecated Position 0xA7）导致该簇剩余块被丢弃的
 *     当前行为刻画（缺陷，见交付说明）；
 *   - Cues 的 CueRelativePosition/CueBlockNumber/CueDuration 附加字段与
 *     同 CuePoint 多 CueTrackPositions 的取值规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize, encodeUnknownSize,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

const vp9Track = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
});

function ebmlHeader() {
  return new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
}
function infoBytes(durationMs = 10) {
  return new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, durationMs, 4);
  }).done();
}
function simpleBlock(trackNumber, relTimecode, keyframe, payload) {
  return new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber, relTimecode, keyframe, frames: [payload] })).done();
}
function cluster(timecode, children) {
  return new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, timecode);
    for (const c of children) w.raw(c);
  }).done();
}
/** 拼装完整文件（Segment 定长） */
function wrap(info, tracks, segmentChildren) {
  const root = new EbmlWriter();
  root.raw(ebmlHeader());
  root.raw(encodeId(ID.Segment));
  let len = info.length + tracks.length;
  for (const c of segmentChildren) len += c.length;
  root.raw(encodeSize(len));
  root.raw(info); root.raw(tracks);
  for (const c of segmentChildren) root.raw(c);
  return root.done();
}
function buildTracks(...builds) {
  return new EbmlWriter().master(ID.Tracks, (w) => { for (const b of builds) b(w); }).done();
}

// ── BlockGroup：BlockAdditions 子树 ─────────────────────
test('BlockGroup：BlockAdditions 子树不污染块解析，样本数据与关键帧判定正确', async () => {
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([0x11, 0x22])] }));
    // BlockAdditions(0x75A1) > BlockMore(0xA6) > BlockAddID(0xEE) + BlockAdditional(0xA1)
    g.master(ID.BlockAdditions, (ba) => {
      ba.master(ID.BlockMore, (bm) => {
        bm.u(ID.BlockAddID, 1);
        bm.b(0xa1, U8([0xde, 0xad]));
      });
    });
    g.i(ID.ReferenceBlock, -1); // 有参考 → 非关键帧
  }).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [cluster(0, [bg])]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  assert.ok(s);
  assert.equal(s.keyframe, false);
  assert.deepEqual([...s.data], [0x11, 0x22], 'BlockAdditional 不应被当作块数据');
  assert.equal(s.size, 2);
  assert.equal(await d.readSample(1), null);
});

test('BlockGroup：无 Block 子元素 → 不产出样本（不抛错）', async () => {
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.u(ID.BlockDuration, 5);
    g.i(ID.ReferenceBlock, -1);
  }).done();
  const ok = simpleBlock(1, 100, true, U8([1, 2, 3]));
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [cluster(0, [bg, ok])]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 100_000, '无 Block 的 BlockGroup 应被跳过，后续块正常');
  assert.equal(await d.readSample(1), null);
});

test('BlockGroup：BlockDuration=0 → 样本产出且 duration=0', async () => {
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([9])] }));
    g.u(ID.BlockDuration, 0);
  }).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [cluster(0, [bg])]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  assert.ok(s);
  assert.equal(s.duration, 0);
  assert.equal(s.keyframe, true, '无 ReferenceBlock → 关键帧');
});

test('BlockGroup：仅 ReferencePriority（无 ReferenceBlock）→ 仍判关键帧', async () => {
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({ trackNumber: 1, relTimecode: 0, frames: [U8([7])] }));
    g.u(ID.ReferencePriority, 1);
  }).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [cluster(0, [bg])]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal((await d.readSample(1)).keyframe, true);
});

test('BlockGroup：Block 内 Xiph lacing 多帧 → 同时间戳、有参考则全非关键帧', async () => {
  const bg = new EbmlWriter().master(ID.BlockGroup, (g) => {
    g.leaf(ID.Block, makeBlock({
      trackNumber: 1, relTimecode: 0, lacing: 'xiph',
      frames: [new Uint8Array(3).fill(0xa), new Uint8Array(4).fill(0xb)],
    }));
    g.i(ID.ReferenceBlock, -1);
  }).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [cluster(0, [bg])]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const out = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    out.push(s);
  }
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.data[0]), [0xa, 0xb]);
  assert.deepEqual(out.map((s) => s.timestamp), [0, 0]);
  assert.deepEqual(out.map((s) => s.keyframe), [false, false]);
});

// ── Cluster 边界 ────────────────────────────────────────
test('Cluster：无 ClusterTimecode → 时间戳基准为 0（仅相对时间码）', async () => {
  const clusterNoTc = new EbmlWriter().master(ID.Cluster, (w) => {
    w.raw(simpleBlock(1, 250, true, U8([1])));
  }).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [clusterNoTc]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal((await d.readSample(1)).timestamp, 250_000);
});

test('Cluster：跨簇时间戳基准 = ClusterTimecode + relTimecode', async () => {
  const c0 = cluster(1000, [simpleBlock(1, 0, true, U8([1])), simpleBlock(1, 500, false, U8([2]))]);
  const c1 = cluster(3000, [simpleBlock(1, -200, false, U8([3])), simpleBlock(1, 0, true, U8([4]))]);
  const bytes = wrap(infoBytes(5000), buildTracks(vp9Track), [c0, c1]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const stamps = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    stamps.push(s.timestamp);
  }
  assert.deepEqual(stamps, [1_000_000, 1_500_000, 2_800_000, 3_000_000]);
});

test('Cluster：未知长度用 8 字节形式（0x01FFFFFFFFFFFFFF）→ 边界探测正确且后续簇不受影响', async () => {
  const c0Inner = new EbmlWriter();
  c0Inner.u(ID.ClusterTimecode, 0);
  c0Inner.raw(simpleBlock(1, 0, true, U8([1])));
  const c0 = new EbmlWriter().raw(encodeId(ID.Cluster)).raw(encodeUnknownSize(8)).raw(c0Inner.done()).done();
  const c1 = cluster(2000, [simpleBlock(1, 0, true, U8([2]))]);

  const info = infoBytes(3000);
  const tracks = buildTracks(vp9Track);
  const root = new EbmlWriter();
  root.raw(ebmlHeader());
  root.raw(encodeId(ID.Segment));
  root.raw(encodeUnknownSize(8)); // Segment 也用 8 字节未知长度
  root.raw(info); root.raw(tracks); root.raw(c0); root.raw(c1);

  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  const stamps = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    stamps.push(s.timestamp);
  }
  assert.deepEqual(stamps, [0, 2_000_000]);
});

test('Cluster：簇内 Void / CRC32 / ClusterPrevSize 被跳过，两侧块均产出', async () => {
  const voidEl = new EbmlWriter().leaf(ID.Void, U8([0, 0, 0])).done();
  const crc = new EbmlWriter().leaf(ID.CRC32, U8([1, 2, 3, 4])).done();
  const prevSize = new EbmlWriter().u(ID.ClusterPrevSize, 0).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [
    cluster(0, [
      prevSize,
      simpleBlock(1, 0, true, U8([1])),
      voidEl,
      crc,
      simpleBlock(1, 10, false, U8([2])),
    ]),
  ]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const stamps = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    stamps.push(s.timestamp);
  }
  assert.deepEqual(stamps, [0, 10_000]);
});

test('Cluster：簇内非规范子元素（deprecated Position 0xA7）被跳过，其后块仍被解析（#2 修复）', async () => {
  // deprecated Position(0xA7) 不在 schema、也不在 #walkClusterBlocks 的白名单内，
  // 修复后命中 else 仅跳过该元素 payload 并继续，不再 break 整簇（#2）。
  const position = new EbmlWriter().leaf(0xa7, U8([0, 0, 0])).done();
  const bytes = wrap(infoBytes(), buildTracks(vp9Track), [
    cluster(0, [
      simpleBlock(1, 0, true, U8([1])),
      position,
      simpleBlock(1, 50, true, U8([2])),
    ]),
  ]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const stamps = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    stamps.push(s.timestamp);
  }
  assert.deepEqual(stamps, [0, 50_000], '修复 #2：0xA7 被跳过，其后 SimpleBlock 仍被解析');
});

// ── Cues：附加字段与多 CueTrackPositions ────────────────
test('Cues：CueRelativePosition/CueBlockNumber/CueDuration 附加字段不影响 CueClusterPosition 定位', async () => {
  const info = infoBytes(1000);
  const tracks = buildTracks(vp9Track);
  const cueTarget = info.length + tracks.length; // 簇在段内偏移（Cues 之前没有其他元素？Cues 在其后 → 需加 Cues 长度）
  // 先量 Cues 长度（占位），再算簇偏移
  const buildCues = (clusterPos) => new EbmlWriter().master(ID.Cues, (cw) => {
    cw.master(ID.CuePoint, (p) => {
      p.u(ID.CueTime, 0);
      p.master(ID.CueTrackPositions, (tp) => {
        tp.u(ID.CueTrack, 1);
        tp.u(ID.CueClusterPosition, clusterPos, 8);
        tp.u(ID.CueRelativePosition, 12);  // 附加
        tp.u(0x5378, 1);                   // CueBlockNumber
        tp.u(0xb2, 40);                    // CueDuration（schema 未收录 → Binary，忽略）
      });
    });
  }).done();
  const probe = buildCues(0);
  const clusterPos = info.length + tracks.length + probe.length;
  const cues = buildCues(clusterPos);
  assert.equal(cues.length, probe.length, '固定宽度下两遍 Cues 应等长');

  const clusterBytes = cluster(0, [simpleBlock(1, 0, true, U8([1]))]);
  const root = new EbmlWriter();
  root.raw(ebmlHeader());
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cues.length + clusterBytes.length));
  root.raw(info); root.raw(tracks); root.raw(cues); root.raw(clusterBytes);

  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(d.cues.length, 1);
  assert.equal(d.cues[0].clusterOffsetInSegment, clusterPos);
  assert.equal(await d.locate(0), d.segmentDataStart + clusterPos);
  void cueTarget;
});

test('Cues：同一 CuePoint 内多个 CueTrackPositions → 按 CueTrack 分别保留（#3 修复）', async () => {
  const info = infoBytes(1000);
  const tracks = buildTracks(vp9Track);
  const cues = new EbmlWriter().master(ID.Cues, (cw) => {
    cw.master(ID.CuePoint, (p) => {
      p.u(ID.CueTime, 0);
      p.master(ID.CueTrackPositions, (tp) => { tp.u(ID.CueTrack, 1); tp.u(ID.CueClusterPosition, 111); });
      p.master(ID.CueTrackPositions, (tp) => { tp.u(ID.CueTrack, 2); tp.u(ID.CueClusterPosition, 222); });
    });
  }).done();
  const clusterBytes = cluster(0, [simpleBlock(1, 0, true, U8([1]))]);
  const root = new EbmlWriter();
  root.raw(ebmlHeader());
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cues.length + clusterBytes.length));
  root.raw(info); root.raw(tracks); root.raw(cues); root.raw(clusterBytes);

  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  // 修复后：每个 CueTrackPositions 独立保留，不再被后者覆盖
  assert.equal(d.cues.length, 2);
  assert.equal(d.cues[0].clusterOffsetInSegment, 111);
  assert.equal(d.cues[0].track, 1);
  assert.equal(d.cues[1].clusterOffsetInSegment, 222);
  assert.equal(d.cues[1].track, 2);
});
