/**
 * mkv-seek.test.js —— seek / Cues 解析与定位边界
 *
 * 覆盖：CuePoint 缺 CueClusterPosition / 缺 CueTime 被跳过、locate 二分
 * 取 ≤ target 的最近簇、seek 实际落点 peek、无簇段 seekable=false →
 * SEEK_UNSUPPORTED、无索引时 locate 返回 -1。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize } from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

function vp9Track(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
  });
}

function cluster(timecode, frame = U8([1, 2, 3, 4])) {
  return new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, timecode);
    w.raw(new EbmlWriter().leaf(ID.SimpleBlock,
      makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [frame] })).done());
  }).done();
}

/**
 * Segment[ Info, Tracks, Cues, c0, c1 ]：Cues 置于簇之前 → open 阶段即解析
 * （尾置 Cues 按惰性契约 open 不解析，见 lazy-open.test.js「尾置 Cues 不得在 open 阶段被扫出」）。
 *
 * 难点：CueClusterPosition 的值 = info+tracks+Cues 长度，而 Cues 长度又取决于该值的编码宽度
 * → 自依赖。解法：CueClusterPosition/CueTime 一律以 minLen=8 固定宽度写入，使「占位 0」与
 * 「真实偏移」两遍构造出的 Cues 字节数完全一致，于是簇偏移稳定；末尾再断言两遍等长兜底。
 */
function buildWithCues({ makeCuesBodies = () => [], c0 = cluster(0), c1 = cluster(1000) } = {}) {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 2000, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, vp9Track).done();

  const buildCues = (offsets) => new EbmlWriter().master(ID.Cues, (cw) => {
    for (const b of makeCuesBodies(offsets)) cw.raw(b);
  }).done();

  // 第一遍：占位偏移（0），仅用于量取 Cues 自身长度
  const probeCues = buildCues({ cluster0Offset: 0, cluster1Offset: 0 });
  const cluster0Offset = info.length + tracks.length + probeCues.length;
  const cluster1Offset = cluster0Offset + c0.length;
  // 第二遍：真实偏移
  const cues = buildCues({ cluster0Offset, cluster1Offset });

  // 两遍等长是「簇偏移可稳定计算」的前提：不等长说明某处值未固定宽度写入
  if (cues.length !== probeCues.length) {
    throw new Error(
      `两遍 Cues 长度不一致：占位=${probeCues.length} 真实=${cues.length}（差值 ${cues.length - probeCues.length}）`
      + ' —— CuePoint 内的 CueTime/CueClusterPosition 必须以 minLen 固定宽度写入'
    );
  }

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cues.length + c0.length + c1.length));
  root.raw(info); root.raw(tracks); root.raw(cues); root.raw(c0); root.raw(c1);
  return { bytes: root.done(), cluster0Offset, cluster1Offset };
}

// minLen=8：CueTime / CueClusterPosition 固定 8 字节宽度，
// 使两遍构造（占位 0 → 真实偏移）的 Cues 总长完全一致，簇偏移才可稳定计算。
const cuePoint = (time, clusterPos) => new EbmlWriter().master(ID.CuePoint, (p) => {
  p.u(ID.CueTime, time, 8);
  p.master(ID.CueTrackPositions, (tp) => { tp.u(ID.CueTrack, 1); tp.u(ID.CueClusterPosition, clusterPos, 8); });
}).done();

test('Cues：缺 CueClusterPosition 的 CuePoint 被跳过（不污染定位）', async () => {
  const { bytes, cluster0Offset } = buildWithCues({
    makeCuesBodies: ({ cluster0Offset: o0 }) => [
      cuePoint(0, o0),
      // 缺 CueClusterPosition → 跳过
      new EbmlWriter().master(ID.CuePoint, (p) => { p.u(ID.CueTime, 1000, 8); }).done(),
    ],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 1, '缺位置的 CuePoint 应被丢弃');
  assert.equal(d.cues[0].timeNs, 0);
  assert.equal(d.cues[0].clusterOffsetInSegment, cluster0Offset);
});

test('Cues：缺 CueTime 的 CuePoint 被跳过', async () => {
  const { bytes } = buildWithCues({
    makeCuesBodies: ({ cluster1Offset: o1 }) => [
      new EbmlWriter().master(ID.CuePoint, (p) => {
        p.master(ID.CueTrackPositions, (tp) => { tp.u(ID.CueTrack, 1); tp.u(ID.CueClusterPosition, o1, 8); });
      }).done(),
    ],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 0, '缺时间的 CuePoint 应被丢弃');
});

test('locate：二分取 ≤ target 的最近簇；越界时间取末簇', async () => {
  const { bytes, cluster0Offset, cluster1Offset } = buildWithCues({
    makeCuesBodies: ({ cluster0Offset: o0, cluster1Offset: o1 }) => [cuePoint(0, o0), cuePoint(1000, o1)],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  // 中间时间 → 应命中 0ms 簇
  assert.equal(await d.locate(500_000), d.segmentDataStart + cluster0Offset);
  // 恰好命中 1000ms → 命中末簇
  assert.equal(await d.locate(1_000_000), d.segmentDataStart + cluster1Offset);
  // 远超所有 CueTime → 取末簇（非 -1）
  assert.equal(await d.locate(9_000_000), d.segmentDataStart + cluster1Offset);
});

test('seek：实际落点由落点簇首个样本时间戳决定', async () => {
  const { bytes } = buildWithCues({
    makeCuesBodies: ({ cluster0Offset: o0, cluster1Offset: o1 }) => [cuePoint(0, o0), cuePoint(1000, o1)],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  // 精确命中第二个 CuePoint（1000ms）→ 落点即该簇首个样本 1_000_000µs
  const r = await d.seek(1_000_000);
  assert.equal(r.actualTimestampUs, 1_000_000, '落点应为落点簇首个样本时间戳');
  // 窗口重置后可从新位置拉取
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 1_000_000);
});

test('seek：目标超过末簇时间 → 无 ≥target 样本，回退时长钳制', async () => {
  const { bytes } = buildWithCues({
    makeCuesBodies: ({ cluster0Offset: o0, cluster1Offset: o1 }) => [cuePoint(0, o0), cuePoint(1000, o1)],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  // 末簇样本仅 1000ms；target=1600ms 之后已无样本 →
  // 按 #peekActualTimestamp 契约「落点之后无样本（EOF 方向）回退用时长钳制」
  const r = await d.seek(1_600_000);
  assert.equal(r.actualTimestampUs, d.durationUs, '落点之后无样本应回退时长钳制');
  assert.equal(r.actualTimestampUs, 2_000_000, 'Duration=2000(tick) @scale=1e6 → 2_000_000µs');
});

test('无簇段：seekable=false → seek 抛 SEEK_UNSUPPORTED；locate 返回 -1', async () => {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 1, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, vp9Track).done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length));
  root.raw(info); root.raw(tracks);
  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(d.mediaInfo.seekable, false, '无簇段不可寻址');
  assert.equal(d.cues.length, 0);
  assert.equal(d.firstClusterOffset, -1);
  await assert.rejects(() => d.seek(0), (e) => e.code === 'SEEK_UNSUPPORTED');
});

test('无 Cues/无簇索引时 locate 返回 -1（seek 将抛无法定位）', async () => {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 1, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, vp9Track).done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length));
  root.raw(info); root.raw(tracks);
  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(await d.locate(123), -1);
});
