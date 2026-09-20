/**
 * demuxer-gaps.test.js —— MkvDemuxer 残余分支补测（wave 148）
 *
 * 覆盖：probe DocType 三态补全、构造源校验、open() 状态机（destroyed/重入）、
 * attach() 全分支、Cues 解析失败兜底、未知长度 Segment/Tags 边界探测、
 * readSample abort 竞速与迟到缓存、samplesInternal 状态守卫。
 *
 * 登记（不硬造）：#peekHeader 头部扩展循环 221-225 不可达——head 恒为
 * min(16, 剩余) 的足额返回，短读已被 #readExact 的 199-200 守卫前置拒绝，
 * 循环体（含 223 break 防御）在现行读写契约下无进入路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize, probe as mkvProbe,
} from '../src/index.js';
import { makeBlock, ebmlHeader, makeMinimalWebm } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

function vp9Track(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
  });
}

function infoEl(durationMs = 2000) {
  return new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, durationMs, 4);
  }).done();
}

function tracksEl() {
  return new EbmlWriter().master(ID.Tracks, vp9Track).done();
}

function clusterEl(timecode, frame = U8([1, 2, 3, 4])) {
  return new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, timecode);
    w.raw(new EbmlWriter().leaf(ID.SimpleBlock,
      makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [frame] })).done());
  }).done();
}

/** 未知长度 master（size 位全 1 的 0xFF 标记）+ 自定义子元素字节 */
function unknownMaster(id, childrenBytes) {
  const out = new EbmlWriter();
  out.raw(encodeId(id));
  out.raw(U8([0xff]));
  for (const b of childrenBytes) out.raw(b);
  return out.done();
}

function buildMkv(children, { docType = 'webm' } = {}) {
  const body = (() => {
    const w = new EbmlWriter();
    for (const c of children) w.raw(c);
    return w.done();
  })();
  const out = new EbmlWriter();
  out.raw(ebmlHeader(docType));
  out.raw(encodeId(ID.Segment));
  out.raw(encodeSize(body.length));
  out.raw(body);
  return out.done();
}

// ── probe：DocType 缺失 / 非 Matroska 族 ─────────────────

test('probe：无 DocType（截断头部）→ 0.85 保守命中；非 webm/matroska → null', () => {
  const noDocType = new EbmlWriter().master(ID.EBML, (w) => w.u(ID.EBMLVersion, 1)).done();
  const r = mkvProbe(noDocType);
  assert.ok(r, 'EBML 但缺 DocType 应保守命中');
  assert.equal(r.confidence, 0.85);
  assert.equal(r.container, 'mkv');

  const wvtt = new EbmlWriter().master(ID.EBML, (w) => w.s(ID.DocType, 'webvtt')).done();
  assert.equal(mkvProbe(wvtt), null, 'DocType 非 webm/matroska 应明确未命中');

  // EBML 魔数后跟非法 size vint（0x01 声明 8 字节但只剩 1）→ 底层抛错被 probe catch 吞为 null
  assert.equal(mkvProbe(U8([0x1a, 0x45, 0xdf, 0xa3, 0x01])), null, 'probe 永不抛契约');
});

// ── 构造源校验 ───────────────────────────────────────────

test('constructor：无 read 的源 → SOURCE_ERROR', () => {
  assert.throws(() => new MkvDemuxer(null), (e) => e.code === 'SOURCE_ERROR');
  assert.throws(() => new MkvDemuxer({ size: 100 }), (e) => e.code === 'SOURCE_ERROR');
});

// ── open() 状态机 ────────────────────────────────────────

test('open：destroyed 后抛 STATE_ERROR；opening 重入抛 STATE_ERROR', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  await d.destroy();
  await assert.rejects(d.open(), (e) => e.code === 'STATE_ERROR');

  const d2 = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  const first = d2.open(); // open() 同步置 opening 后才挂起
  await assert.rejects(d2.open(), (e) => e.code === 'STATE_ERROR');
  await first;
  await d2.destroy();
});

// ── attach() 全分支 ─────────────────────────────────────

test('attach：非法源 SOURCE_ERROR；idle 换源后可 open；非 idle 抛 STATE_ERROR', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  assert.throws(() => d.attach({}), (e) => e.code === 'SOURCE_ERROR');

  const ret = d.attach(new BufferSource(makeMinimalWebm().bytes));
  assert.equal(ret, d, 'attach 应返回 this 便于链式');
  const mi = await d.open();
  assert.ok(mi.tracks.length >= 1, '换源后 open 应走新数据源');

  assert.throws(
    () => d.attach(new BufferSource(makeMinimalWebm().bytes)),
    (e) => e.code === 'STATE_ERROR',
  );
  await d.destroy();
});

// ── Cues 解析失败不致命 ─────────────────────────────────

test('Cues 内容为垃圾（非法 vint）→ open 吞错照常成功', async () => {
  // 0x01 声明 8 字节 VINT 但内容只有 2 字节 → readId 抛 EbmlError → parseCuesAt 抛出 → 395-396 兜底
  const garbageCues = new EbmlWriter().leaf(ID.Cues, U8([0x01, 0x00])).done();
  const bytes = buildMkv([infoEl(), tracksEl(), garbageCues, clusterEl(0)]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open(); // Cues 解析失败被吞：seek 时走线性索引兜底
  assert.ok(mi.tracks.length >= 1);
  await d.destroy();
});

// ── #readExact 短读守卫 ─────────────────────────────────

test('数据源短读（返回字节少于请求且 size 充足）→ SOURCE_ERROR', async () => {
  const full = makeMinimalWebm().bytes;
  const shortSource = {
    size: full.length,
    read: async (o, l) => full.subarray(o, o + Math.max(1, l >> 1)), // 恒只给一半
    close: () => {},
  };
  const d = new MkvDemuxer(shortSource);
  await assert.rejects(d.open(), (e) => e.code === 'SOURCE_ERROR');
});

// ── 未知长度元素边界探测 ────────────────────────────────

test('未知长度 Tags（默认分支）→ Void/CRC32 白名单探测后正常收束', async () => {
  const tags = unknownMaster(ID.Tags, [new EbmlWriter().leaf(ID.Void, U8([1, 2, 3])).done()]);
  const bytes = buildMkv([infoEl(), tracksEl(), tags, clusterEl(0)]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  const mi = await d.open();
  assert.ok(mi.tracks.length >= 1, '探测 Tags 后应继续解析 Tracks 与 Cluster');
  await d.destroy();
});

test('未知长度嵌套 Segment（线性建索引路径）→ SCHEMA 白名单探测', async () => {
  const innerInfo = new EbmlWriter().master(ID.Info, (w) => w.u(ID.TimecodeScale, 1_000_000)).done();
  const innerSeg = unknownMaster(ID.Segment, [innerInfo]);
  // 无 Cues → seek 触发 #ensureSeekIndex 线性扫描，扫描遇未知长度非簇元素
  const bytes = buildMkv([infoEl(), tracksEl(), clusterEl(0), innerSeg, clusterEl(1500)]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const r = await d.seek(0); // 线性扫描建簇索引，吞掉未知长度 Segment
  assert.equal(r.actualTimestampUs, 0);
  await d.destroy();
});

// ── readSample 中断竞速与迟到缓存 ───────────────────────

test('readSample：signal abort 即拒 ABORTED；迟到样本经 pendingResults 缓存续读', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();

  const ctrl = new AbortController();
  const p = d.readSample(1, { signal: ctrl.signal });
  ctrl.abort(); // 同步中止：竞速立即 reject，底层 next() 继续飞行
  await assert.rejects(p, (e) => e.code === 'ABORTED');

  // 底层 next() 迟到落地 → 写入 pendingResults 缓存（731-732）
  await new Promise((r) => setTimeout(r, 20));

  // 续读：命中缓存，迟到样本不丢（725-727）
  const s = await d.readSample(1);
  assert.ok(s, '迟到落地的样本应经缓存吐出');
  assert.equal(s.timestamp, 0, '应为首个样本（未被中断吞掉）');
  assert.ok(s.data instanceof Uint8Array);
  await d.destroy();
});

// ── samplesInternal 状态守卫 ────────────────────────────

test('samplesInternal：非 ready 态 → STATE_ERROR', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await assert.rejects(d.samplesInternal().next(), (e) => e.code === 'STATE_ERROR');
});
