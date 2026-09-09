/**
 * 第一轮评审 §18.3 回归：mkv open 惰性停止（消除未知尺寸簇/无 Cues 文件双遍历）。
 *
 * 布局：Segment[ Info, Tracks, Cluster×3, Cues(尾置) ] —— 旧实现在 open 阶段为找
 * 尾置 Cues 会扫完整段（未知尺寸簇逐个边界探测），随后首次 seek 的 #ensureSeekIndex
 * 又扫一遍（双遍历）。修复后 open 在首簇处终止、不触尾区；尾置 Cues 推迟到首次
 * seek 由 #ensureSeekIndex 一次性发现。本用例用读范围间谍实证：
 *   1) open 不读入簇区（maxRead < cluster1 起点）；
 *   2) 顺序拉流（无 seek）仍完整解出全部分片；
 *   3) seek 惰性发现尾置 Cues（open 后 cues 空 → seek 后 cues=3）且定位正确。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MkvDemuxer, EbmlWriter, ID, encodeId, encodeSize,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

/** 读范围间谍数据源：记录最大读到偏移与读次数 */
class TrackingSource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = bytes.length;
    this.maxRead = -1;
    this.readCount = 0;
  }
  async read(offset, length) {
    this.readCount += 1;
    const end = Math.min(offset + length, this.bytes.length);
    this.maxRead = Math.max(this.maxRead, end);
    return this.bytes.subarray(offset, end).slice();
  }
}

const MIN_VIDEO_TRACK = (w) => {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1);
    t.u(ID.TrackUID, 1);
    t.u(ID.TrackType, 1);
    t.s(ID.CodecID, 'V_VP9');
  });
};

const clusterBytes = (timecode) =>
  new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, timecode);
    w.raw(
      new EbmlWriter().leaf(ID.SimpleBlock,
        makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [new Uint8Array(4)] })).done()
    );
  }).done();

function buildFixture() {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1);
    w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); // 1 tick = 1ms
    w.f(ID.Duration, 120, 4);          // 120ms
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, MIN_VIDEO_TRACK).done();
  const c0 = clusterBytes(0);
  const c1 = clusterBytes(40);
  const c2 = clusterBytes(80);
  // 簇相对 Segment 数据起点（= info+tracks 之后）的偏移
  const off0 = info.length + tracks.length;
  const off1 = off0 + c0.length;
  const off2 = off1 + c1.length;
  const cues = new EbmlWriter().master(ID.Cues, (cw) => {
    for (const [t, off] of [[0, off0], [40, off1], [80, off2]]) {
      cw.master(ID.CuePoint, (pt) => {
        pt.u(ID.CueTime, t);
        pt.master(ID.CueTrackPositions, (tp) => {
          tp.u(ID.CueTrack, 1);
          tp.u(ID.CueClusterPosition, off);
        });
      });
    }
  }).done();

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + c0.length + c1.length + c2.length + cues.length));
  root.raw(info);
  root.raw(tracks);
  root.raw(c0);
  root.raw(c1);
  root.raw(c2);
  root.raw(cues);
  return { bytes: root.done(), off0, off1, off2 };
}

test('open 惰性停止：不扫簇区；拉流完整；seek 惰性发现尾置 Cues', async () => {
  const { bytes, off0, off1, off2 } = buildFixture();

  // ---- 1) open 不读入簇体（读范围止于簇0头，远未到簇1起点）----
  const src = new TrackingSource(bytes);
  const d = new MkvDemuxer(src);
  await d.open();
  assert.ok(d.firstClusterOffset >= 0, '应发现首簇');
  assert.equal(d.cues.length, 0, '尾置 Cues 不得在 open 阶段被扫出（惰性）');
  // 注意：maxRead 为绝对文件偏移；off1 为段内相对偏移，需加 segmentDataStart 换算
  assert.ok(
    src.maxRead < d.segmentDataStart + off1,
    `open 不应扫入簇体（maxRead=${src.maxRead} 应 < segmentDataStart+off1=${d.segmentDataStart + off1}）`
  );

  // ---- 2) 顺序拉流（无 seek）：3 簇全解出，播放路径不受影响 ----
  const pullSrc = new TrackingSource(bytes);
  const dp = new MkvDemuxer(pullSrc);
  await dp.open();
  const samples = [];
  for (;;) {
    const s = await dp.readSample(1);
    if (!s) break;
    samples.push(s);
  }
  assert.equal(samples.length, 3, '顺序拉流应解出全部分片');
  assert.ok(
    pullSrc.maxRead >= dp.segmentDataStart + off2,
    `拉流应遍历到末簇区（maxRead=${pullSrc.maxRead} 应 ≥ segStart+off2=${dp.segmentDataStart + off2}）`
  );

  // ---- 3) seek：惰性发现尾置 Cues（open 后 cues 空 → seek 后 cues=3）----
  const seekSrc = new TrackingSource(bytes);
  const ds = new MkvDemuxer(seekSrc);
  await ds.open();
  assert.equal(ds.cues.length, 0, 'open 后尾置 Cues 仍未解析');
  const r = await ds.seek(150_000); // 150ms > 末簇 80ms
  assert.ok(Number.isFinite(r.actualTimestampUs), 'seek 应返回实际落点');
  assert.ok(r.actualTimestampUs >= 80_000, `落点应 ≥ 末簇 80ms，实际 ${r.actualTimestampUs}`);
  assert.equal(ds.cues.length, 3, 'seek 应一次性发现并解析尾置 Cues');
  assert.equal(await ds.locate(0), ds.segmentDataStart + off0, 'locate(0) 应命中首簇偏移');
});
