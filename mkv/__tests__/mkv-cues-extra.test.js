/**
 * mkv-cues-extra.test.js —— Cues 索引的「多轨/额外字段/未知元素/顺序脆弱性」边界
 *
 * 覆盖 mkv-seek.test.js 未触及的 Cues 角落：
 *   1) 多轨 Cues：单 CuePoint 含多轨 CueTrackPositions → 每轨独立入表、track/簇偏移正确
 *   2) 多轨 Cues 下 locate 仍命中正确簇
 *   3) CueTrackPositions 内混入「合法但 schema 未知」的 EBML 元素 → 被容忍、CuePoint 正常解析
 *   4) CueRelativePosition(0xF0)+CueBlockNumber(0x5378) 等额外已知字段 → 被容忍
 *   5) CuePoint 内 CueTrackPositions 先于 CueTime → 仍被正确保留（元素顺序无关）
 *   6) CueClusterPosition 以 1 字节 VINT 编码 → 仍被正确解析（变长 VINT 宽度覆盖）
 *
 * 说明：CueReference(0xC11)/CueDuration(0xC114) 并非合法 EBML 元素 ID（首字节标记位
 * 指向 4 字节 VINT 但其值不足），且本 schema 未收录；解析器无需处理，本文件改用真实合法
 * 的未知 2 字节 ID 0x42AB 验证「未知元素容忍」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize, SCHEMA } from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (a) => Uint8Array.from(a);

/** 合法的未知 2 字节 EBML ID（首字节 0x42∈[0x40,0x7F] → 标记位在第 2 位 → 2 字节） */
const UNKNOWN_CUE_FIELD = 0x42AB;

// ── 积木 ────────────────────────────────────────────────
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
 * 组装 Segment[ Info, Tracks, Cues, c0, c1 ]：Cues 置于簇前 → open 阶段即解析。
 * 与 mkv-seek.test.js 同构：CueTime/CueClusterPosition 固定 8 字节宽度，两遍构造（占位 0 →
 * 真实偏移）保证 Cues 总长稳定、簇偏移可计算。宽度可调（width）以覆盖 1 字节 VINT。
 */
function buildWithCues({ cueBodies, c0 = cluster(0), c1 = cluster(1000), width = 8 } = {}) {
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 2000, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, vp9Track).done();

  const buildCues = (o0, o1) => new EbmlWriter().master(ID.Cues, (cw) => {
    for (const b of cueBodies(o0, o1)) cw.raw(b);
  }).done();

  const probe = buildCues(0, 0);
  const cluster0Offset = info.length + tracks.length + probe.length;
  const cluster1Offset = cluster0Offset + c0.length;
  const cues = buildCues(cluster0Offset, cluster1Offset);

  if (cues.length !== probe.length) {
    throw new Error(`两遍 Cues 长度不一致：占位=${probe.length} 真实=${cues.length}（差值 ${cues.length - probe.length}）`);
  }
  // 仅 1 字节 VINT（width=0）场景要求 cluster0Offset < 128，保证两遍宽度一致
  if (width === 0) assert.ok(cluster0Offset < 128, `cluster0Offset=${cluster0Offset} 超出 1 字节 VINT 宽度，需调小布局`);

  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cues.length + c0.length + c1.length));
  root.raw(info); root.raw(tracks); root.raw(cues); root.raw(c0); root.raw(c1);
  return { bytes: root.done(), cluster0Offset, cluster1Offset, width };
}

/** 构造 CuePoint：固定宽度写入 CueTime 与若干 CueTrackPositions（每轨一簇偏移） */
function cuePoint(time, positions, { extraInCtp = [], width = 8 } = {}) {
  return new EbmlWriter().master(ID.CuePoint, (p) => {
    p.u(ID.CueTime, time, width);
    for (const { track, clusterPos } of positions) {
      p.master(ID.CueTrackPositions, (tp) => {
        tp.u(ID.CueTrack, track);
        tp.u(ID.CueClusterPosition, clusterPos, width);
        for (const ex of extraInCtp) tp.raw(ex);
      });
    }
  }).done();
}

/** 构造一个「CueTrackPositions 先于 CueTime」的 CuePoint（顺序异常） */
function cuePointCtpBeforeTime(time, clusterPos, width = 8) {
  return new EbmlWriter().master(ID.CuePoint, (p) => {
    p.master(ID.CueTrackPositions, (tp) => {
      tp.u(ID.CueTrack, 1);
      tp.u(ID.CueClusterPosition, clusterPos, width);
    });
    p.u(ID.CueTime, time, width);
  }).done();
}

// ── 用例 ────────────────────────────────────────────────

test('多轨 Cues：单 CuePoint 含两轨 CueTrackPositions → 每轨独立入表', async () => {
  const { bytes, cluster0Offset, cluster1Offset } = buildWithCues({
    cueBodies: (o0, o1) => [
      cuePoint(0, [{ track: 1, clusterPos: o0 }, { track: 2, clusterPos: o0 }]),
      cuePoint(1000, [{ track: 1, clusterPos: o1 }, { track: 2, clusterPos: o1 }]),
    ],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  // 2 个 CuePoint × 2 轨 = 4 条索引；稳定排序后顺序为 [t0:1, t0:2, t1:1, t1:2]
  assert.equal(d.cues.length, 4, '多轨应每轨各一条索引');
  assert.deepEqual(d.cues.map((c) => c.track), [1, 2, 1, 2], 'track 字段应每轨独立保留');
  assert.deepEqual(
    d.cues.map((c) => c.clusterOffsetInSegment),
    [cluster0Offset, cluster0Offset, cluster1Offset, cluster1Offset],
    '每轨索引应指向其簇偏移',
  );
  assert.deepEqual(d.cues.map((c) => c.timeNs), [0, 0, 1000 * 1e6, 1000 * 1e6]);
});

test('多轨 Cues：locate 在两轨同簇场景下定位正确', async () => {
  const { bytes, cluster0Offset, cluster1Offset } = buildWithCues({
    cueBodies: (o0, o1) => [
      cuePoint(0, [{ track: 1, clusterPos: o0 }, { track: 2, clusterPos: o0 }]),
      cuePoint(1000, [{ track: 1, clusterPos: o1 }, { track: 2, clusterPos: o1 }]),
    ],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(await d.locate(500_000), d.segmentDataStart + cluster0Offset, '中间时间应命中 0ms 簇');
  assert.equal(await d.locate(1_000_000), d.segmentDataStart + cluster1Offset, '命中 1000ms 簇');
  // 多轨下 seek 不会因重复簇偏移错位
  const r = await d.seek(1_000_000);
  assert.equal(r.actualTimestampUs, 1_000_000);
});

test('CueTrackPositions 内混入合法未知 EBML 元素 → 被容忍、CuePoint 正常解析', async () => {
  const unknown = new EbmlWriter().u(UNKNOWN_CUE_FIELD, 0x1234).done();
  const { bytes, cluster0Offset } = buildWithCues({
    cueBodies: (o0) => [cuePoint(0, [{ track: 1, clusterPos: o0 }], { extraInCtp: [unknown] })],
  });
  // 先行断言：该未知 ID 是合法 EBML（否则测试本身构造就有问题）
  const probe = new EbmlWriter().u(UNKNOWN_CUE_FIELD, 1).done();
  const rid = (await import('../src/index.js')).readId(probe, 0, probe.length);
  assert.equal(rid.id, UNKNOWN_CUE_FIELD, '0x42AB 必须是合法可解析的 EBML ID');
  assert.ok(!SCHEMA.has(UNKNOWN_CUE_FIELD), '0x42AB 不应在本 schema 内（用作未知元素）');

  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 1, '未知字段不应导致 CuePoint 被丢弃');
  assert.equal(d.cues[0].timeNs, 0);
  assert.equal(d.cues[0].clusterOffsetInSegment, cluster0Offset);
});

test('CueRelativePosition(0xF0)+CueBlockNumber(0x5378) 额外已知字段 → 被容忍', async () => {
  const { bytes, cluster0Offset } = buildWithCues({
    cueBodies: (o0) => [new EbmlWriter().master(ID.CuePoint, (p) => {
      p.u(ID.CueTime, 0, 8);
      p.master(ID.CueTrackPositions, (tp) => {
        tp.u(ID.CueTrack, 1);
        tp.u(ID.CueClusterPosition, o0, 8);
        tp.u(ID.CueRelativePosition, 512); // 段内相对偏移
        tp.u(ID.CueBlockNumber, 7); // 簇内块序号
      });
    }).done()],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 1, 'CueRelativePosition/CueBlockNumber 不应影响索引');
  assert.equal(d.cues[0].clusterOffsetInSegment, cluster0Offset);
  assert.equal(d.cues[0].timeNs, 0);
});

test('CuePoint 内 CueTrackPositions 先于 CueTime → 仍被正确保留（元素顺序无关）', async () => {
  const { bytes, cluster0Offset } = buildWithCues({
    cueBodies: (o0) => [cuePointCtpBeforeTime(0, o0)],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 1, 'CueTrackPositions 先于 CueTime 仍应生成索引');
  assert.equal(d.cues[0].timeNs, 0, 'CueTime 应正确转换为纳秒');
  assert.equal(d.cues[0].clusterOffsetInSegment, cluster0Offset, '簇偏移应正确保留');
  assert.equal(d.cues[0].track, 1, '轨道号应正确保留');
});

test('CueClusterPosition 以 1 字节 VINT 编码 → 仍被正确解析', async () => {
  const { bytes, cluster0Offset, cluster1Offset } = buildWithCues({
    width: 0, // 默认最小宽度 → 小偏移为 1 字节 VINT
    cueBodies: (o0, o1) => [cuePoint(0, [{ track: 1, clusterPos: o0 }], { width: 0 }),
      cuePoint(1000, [{ track: 1, clusterPos: o1 }], { width: 0 })],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.cues.length, 2, '1 字节 VINT 的 CueClusterPosition 应正常解析');
  assert.equal(d.cues[0].clusterOffsetInSegment, cluster0Offset);
  assert.equal(d.cues[1].clusterOffsetInSegment, cluster1Offset);
  assert.equal(await d.locate(1_000_000), d.segmentDataStart + cluster1Offset);
});
