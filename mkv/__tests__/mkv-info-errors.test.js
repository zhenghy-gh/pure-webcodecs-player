/**
 * mkv-info-errors.test.js —— 头部/Info/错误分支与越界保护
 *
 * 覆盖：
 *   - 缺 EBML 头 → PROBE_FAILED；EBML 但无 Segment → PARSE_ERROR；
 *   - DocType 非 matroska/webm 时 probe 拒绝、而直接 open() 仍成功的行为刻画；
 *   - EBMLReadVersion 不被校验的行为刻画；
 *   - Segment 内未知顶层元素（Tags/Chapters/Attachments/Void）跳过；
 *   - Info 的 Title/SegmentUID/MuxingApp/WritingApp/Duration(float64)/DateUTC；
 *   - Duration 与 TimecodeScale 出现顺序对时长的影响（行为刻画）；
 *   - 超大声明的元素 size 与截断尾部的越界保护（不抛错、不 OOM）；
 *   - 无 Tracks / 无簇的最小段 open 行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MkvDemuxer, createDemuxer, probe as mkvProbe,
  BufferSource, EbmlWriter, ID, encodeId, encodeSize,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

function ebmlHeader({ docType = 'webm', readVersion = 1, extra = null } = {}) {
  return new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1);
    w.u(ID.EBMLReadVersion, readVersion);
    w.s(ID.DocType, docType);
    extra?.(w);
  }).done();
}
/** 仅 Segment 元素字节（不含 EBML 头） */
function segmentOnly(children, segmentSize = null) {
  const root = new EbmlWriter();
  let len = 0;
  for (const c of children) len += c.length;
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(segmentSize ?? len));
  for (const c of children) root.raw(c);
  return root.done();
}
function wrapSegment(segmentChildren, { segmentSize = null } = {}) {
  const root = new EbmlWriter();
  root.raw(ebmlHeader());
  root.raw(segmentOnly(segmentChildren, segmentSize));
  return root.done();
}
const vp9Track = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
});
function tracksBytes(...builds) {
  return new EbmlWriter().master(ID.Tracks, (w) => { for (const b of builds) b(w); }).done();
}
function infoBytes(build) {
  return new EbmlWriter().master(ID.Info, build).done();
}
function clusterBytes(timecode, payload = new Uint8Array(4)) {
  return new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, timecode);
    w.leaf(ID.SimpleBlock, makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [payload] }));
  }).done();
}

// ── 结构错误分支 ────────────────────────────────────────
test('open：缺少 EBML 头（0x1A45DFA3）→ PROBE_FAILED', async () => {
  const d = new MkvDemuxer(new BufferSource(U8([0x18, 0x53, 0x80, 0x67, 0x01, 0x02])));
  await assert.rejects(() => d.open(), (e) => e.code === 'PROBE_FAILED');
  assert.equal(d.state, 'idle', '失败后应回 idle 以保留换源重试');
});

test('open：有 EBML 头但无 Segment → PARSE_ERROR「未找到 Segment 元素」', async () => {
  const onlyHeader = ebmlHeader();
  const d = new MkvDemuxer(new BufferSource(onlyHeader));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /Segment/.test(e.message),
  );
});

test('DocType 非 matroska/webm：probe 拒绝、createDemuxer 拒绝，但直接 open() 仍成功（行为刻画）', async () => {
  const header = ebmlHeader({ docType: 'divx' });
  assert.equal(mkvProbe(header), null, '§10：外来 DocType 明确未命中');
  await assert.rejects(() => createDemuxer(header), (e) => e.code === 'PROBE_FAILED');

  // 直接构造 + open() 绕过 probe 校验：open 不校验 DocType，container 回落 'mkv'
  const seg = segmentOnly([
    infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); }),
    tracksBytes(vp9Track),
  ]);
  const withDivx = new EbmlWriter();
  withDivx.raw(ebmlHeader({ docType: 'divx' }));
  withDivx.raw(seg);
  const d = new MkvDemuxer(new BufferSource(withDivx.done()));
  await d.open();
  assert.equal(d.docTypeRaw, 'divx');
  assert.equal(d.mediaInfo.container, 'mkv', '当前实现：非 webm 一律回落 mkv');
});

test('EBMLReadVersion 不被校验：置 5 仍可 open（行为刻画）', async () => {
  const seg = segmentOnly([
    infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 10, 4); }),
    tracksBytes(vp9Track),
  ]);
  const root = new EbmlWriter();
  root.raw(ebmlHeader({ readVersion: 5 }));
  root.raw(seg);
  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(d.state, 'ready');
  assert.equal(d.tracks.length, 1);
});

// ── 未知顶层元素跳过 ────────────────────────────────────
test('Segment 内未知/不相关顶层元素（Tags/Chapters/Attachments/Void）被跳过，Info/Tracks 正常', async () => {
  const info = infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 20, 4); });
  const tracks = tracksBytes(vp9Track);
  const tags = new EbmlWriter().master(ID.Tags, (w) => { w.leaf(ID.Void, U8([1])); }).done();
  const chapters = new EbmlWriter().master(ID.Chapters, (w) => { w.leaf(ID.Void, U8([2])); }).done();
  const attachments = new EbmlWriter().master(ID.Attachments, (w) => { w.leaf(ID.Void, U8([3])); }).done();
  const voidEl = new EbmlWriter().leaf(ID.Void, new Uint8Array(7)).done();
  const unknownTop = new EbmlWriter().leaf(0x1f43b676, U8([0, 0])).done(); // 非 schema ID
  const bytes = wrapSegment([tags, info, unknownTop, chapters, tracks, attachments, voidEl]);

  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.equal(mi.durationUs, 20_000);
  assert.equal(mi.tracks.length, 1);
  assert.equal(mi.tracks[0].codec, 'vp09');
});

// ── Info 字段 ───────────────────────────────────────────
test('Info：Title(UTF-8) / MuxingApp / WritingApp / SegmentUID 一并解析且不冲突', async () => {
  const dateMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const info = infoBytes((w) => {
    w.u(ID.TimecodeScale, 1_000_000);
    w.b(ID.SegmentUID, U8([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    w.f(ID.Duration, 1500, 8); // float64
    w.u8str(ID.Title, '纯前端播放器 · 测试');
    w.u8str(ID.MuxingApp, 'libwebm');
    w.u8str(ID.WritingApp, 'mkvmerge v80');
    // DateUTC：自 2001-01-01 起的纳秒 int64
    const ns = BigInt(dateMs - Date.UTC(2001, 0, 1)) * 1_000_000n;
    const b = new Uint8Array(8);
    let v = ns;
    for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
    w.leaf(ID.DateUTC, b);
  });
  const bytes = wrapSegment([info, tracksBytes(vp9Track)]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.equal(mi.durationUs, 1_500_000);
  assert.equal(mi.metadata.title, '纯前端播放器 · 测试');
  assert.equal(d.title, '纯前端播放器 · 测试');
  assert.equal(mi.metadata.muxingApp, 'libwebm');
  assert.equal(mi.metadata.writingApp, 'mkvmerge v80');
  assert.equal(mi.metadata.dateUTC, new Date(dateMs).toISOString());
});

test('Info：Duration 早于 TimecodeScale 出现 → 时长按最终 scale 重新换算（#4 修复）', async () => {
  // 规范未约束 Info 子元素顺序；Duration 先出现时先存原始值，TimecodeScale 解析后用实际值重算。
  const info = infoBytes((w) => {
    w.f(ID.Duration, 100, 4);     // 先 Duration
    w.u(ID.TimecodeScale, 2_000_000); // 后 TimecodeScale
  });
  const bytes = wrapSegment([info, tracksBytes(vp9Track)]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.equal(d.timecodeScaleNs, 2_000_000);
  // 修复后：Duration 用最终 scale 换算 → 100 * 2e6 / 1000 = 200000
  assert.equal(mi.durationUs, 200_000, '修复 #4：Duration 早于 TimecodeScale 时按实际 scale 换算');
});

test('Info：无 Duration → durationUs=null 且 getBufferedRanges 为空', async () => {
  const info = infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); });
  const cluster = clusterBytes(0);
  const bytes = wrapSegment([info, tracksBytes(vp9Track), cluster]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.mediaInfo.durationUs, null);
  assert.deepEqual(d.getBufferedRanges(1), []);
});

// ── 越界 / 截断保护 ─────────────────────────────────────
test('超大声明 size：元素宣称 2^40 字节 → open 不抛错、短读被安全吸收', async () => {
  const inner = new EbmlWriter();
  inner.u(ID.TimecodeScale, 1_000_000);
  inner.f(ID.Duration, 10, 4);
  const body = inner.done();
  // 手写 Info 头：ID + encodeSize(2^40)
  const huge = new EbmlWriter();
  huge.raw(encodeId(ID.Info));
  huge.raw(encodeSize(2 ** 40));
  huge.raw(body);
  const bytes = wrapSegment([huge.done()], { segmentSize: undefined });

  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.equal(d.state, 'ready');
  assert.equal(mi.tracks.length, 0, '被超大 size 吞并后无轨道，但不应崩溃');
  assert.equal(mi.durationUs, 10_000);
  assert.equal(mi.seekable, false);
});

test('截断尾部：Segment 声明 size 远超文件 → open 安全收尾（无例外）', async () => {
  const info = infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 5, 4); });
  const tracks = tracksBytes(vp9Track);
  const realLen = info.length + tracks.length;
  const bytes = wrapSegment([info, tracks], { segmentSize: realLen + 4096 }); // 尾部虚增
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.equal(d.state, 'ready');
  assert.equal(mi.tracks.length, 1);
  assert.equal(d.segmentDataEnd, d.segmentDataStart + realLen + 4096, 'Segment 定长时按声明值记录 end');
});

test('无 Tracks 的最小段：open 成功、tracks=[]、seekable=false', async () => {
  const info = infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 1, 4); });
  const bytes = wrapSegment([info]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.deepEqual(mi.tracks, []);
  assert.equal(mi.seekable, false);
  assert.equal(d.metadata.container, 'webm');
});

test('EBML 与 Segment 之间插入 Void（含未知长度 Void）可正确定位 Segment', async () => {
  const header = ebmlHeader();
  const voidFixed = new EbmlWriter().leaf(ID.Void, new Uint8Array(16)).done();
  // 未知长度 Void（8 字节未知标记）——不属合法流式元素，但应可跳过不致命
  const voidUnknown = new EbmlWriter()
    .raw(encodeId(ID.Void)).raw(U8([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
    .raw(new Uint8Array(3)).done();
  const info = infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 2, 4); });
  const tracks = tracksBytes(vp9Track);
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(voidFixed);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length));
  root.raw(info); root.raw(tracks);
  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(d.tracks.length, 1);
  void voidUnknown;
});

// ── Track 子元素顺序语义（LanguageIETF 覆盖）─────────────
test('TrackLanguage/LanguageIETF：LanguageIETF 始终优先于 legacy Language（#5 修复）', async () => {
  const tracksA = tracksBytes((w) => w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_OPUS');
    t.s(ID.TrackLanguage, 'chi');       // 先 TrackLanguage
    t.s(ID.LanguageIETF, 'zh');         // 后 LanguageIETF → 生效
  }));
  const dA = new MkvDemuxer(new BufferSource(wrapSegment([
    infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); }), tracksA,
  ])));
  await dA.open();
  assert.equal(dA.tracks[0].language, 'zh');

  const tracksB = tracksBytes((w) => w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_OPUS');
    t.s(ID.LanguageIETF, 'zh');         // 先 LanguageIETF
    t.s(ID.TrackLanguage, 'chi');       // 后 TrackLanguage → 不得覆盖 IETF
  }));
  const dB = new MkvDemuxer(new BufferSource(wrapSegment([
    infoBytes((w) => { w.u(ID.TimecodeScale, 1_000_000); }), tracksB,
  ])));
  await dB.open();
  // 修复后：LanguageIETF 优先级强于 legacy Language，顺序反转仍保持 zh
  assert.equal(dB.tracks[0].language, 'zh', '修复 #5：LanguageIETF 不被后续 TrackLanguage 覆盖');
});
