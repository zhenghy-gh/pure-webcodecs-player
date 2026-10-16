/**
 * demuxer/box-parser 残余分支补测（127 波）：
 * probe 非 ftyp 路径、无 moov、顶层 largesize/size=0、加密 entry、hvc1 轨、
 * 分片 seek 续读、双轨渐进 seek（_locateResumeIndex）、
 * tkhd v1、mehd、parseBoxByType 分派、collectChildren 零子 box 重抛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource, ByteStream } from '../../core/src/index.js';
import { Mp4Demuxer, expandSampleTable } from '../src/demuxer.js';
import {
  box,
  fullBox,
  buildFtyp,
  buildMoov,
  buildMdat,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildDinf,
  buildStsd,
  buildMvex,
  buildTrex,
} from '../src/box-builder.js';
import { parseTkhd, parseMvex, parseBoxByType, parseSampleEntry } from '../src/box-parser.js';
import { makeAvcCFixture, makeAscFixture, buildFragmentedFixture } from './fixtures.js';

/* --------------------------------- fixture --------------------------------- */

/** 仅 8 字节头的 ftyp（无内容） */
const FTYP8 = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);

/** 顶层 largesize free box：size=1 + u64(24)，共 24 字节 */
function largesizeFreeBox() {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1);
  b.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
  dv.setBigUint64(8, 24n);
  return b;
}

/**
 * 极简单轨渐进 MP4（ftyp 仅 8 字节头 → parseFtypSafe 兜底 null）。
 * prefix 可塞额外顶层 box（如 largesize free）；withMoov=false 时只有 ftyp+mdat。
 */
function buildSimpleMp4({ track, sizes, delta = 40, keyframeIndices = [0], edits = null, cttsOffsets = null, tkhdDuration = null, movieTimescale = 1000, movieDuration = sizes.length * delta, prefix = null, withMoov = true }) {
  const payloads = sizes.map((size, i) => {
    const d = new Uint8Array(size);
    for (let j = 0; j < size; j++) d[j] = (i * 17 + j) & 0xff;
    return d;
  });
  const total = sizes.length * delta;
  const meta = {
    timescale: movieTimescale,
    duration: movieDuration,
    tracks: [
      {
        track: { id: 1, language: 'und', timescale: 1000, duration: total, ...track },
        sizes,
        keyframeIndices,
        chunkOffsets: [0],
        samplesPerChunk: sizes.length,
        sttsRuns: [{ count: sizes.length, delta }],
        ...(cttsOffsets ? { cttsOffsets } : {}),
        ...(tkhdDuration !== null ? { tkhdDuration } : {}),
        ...(edits ? { edits } : {}),
      },
    ],
  };
  const moov0 = buildMoov(meta);
  const mdat = buildMdat(payloads);
  const base = FTYP8.byteLength + (prefix?.byteLength ?? 0) + (withMoov ? moov0.byteLength : 0);
  meta.tracks[0].chunkOffsets = [base + 8];
  const moov = withMoov ? buildMoov(meta) : null;

  const bytes = new Uint8Array(base + 8 + sizes.reduce((a, b) => a + b, 0));
  let off = 0;
  if (prefix) {
    bytes.set(prefix, off);
    off += prefix.byteLength;
  }
  bytes.set(FTYP8, off);
  off += FTYP8.byteLength;
  if (moov) {
    bytes.set(moov, off);
    off += moov.byteLength;
  }
  bytes.set(mdat, off);
  return { bytes, payloads, mdatOffset: off };
}

/** fMP4 初始化段：moov(stsd-only + mvex/trex)，与 fixtures.buildFragmentedFixture 同构 */
function buildFmp4Moov(trackId, avcC) {
  return box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 1000, duration: 0, nextTrackId: trackId + 1 }));
    w.writeRaw(
      box('trak', (tw) => {
        tw.writeRaw(buildTkhd({ trackId, duration: 0, isVideo: true, width: 320, height: 240 }));
        tw.writeRaw(
          box('mdia', (mw) => {
            mw.writeRaw(buildMdhd({ timescale: 1000, duration: 0 }));
            mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'fmp4 gaps' }));
            mw.writeRaw(
              box('minf', (iw) => {
                iw.writeRaw(buildVmhd());
                iw.writeRaw(buildDinf());
                iw.writeRaw(
                  box('stbl', (sw) =>
                    sw.writeRaw(
                      buildStsd({
                        id: trackId,
                        type: 'video',
                        codecPrivate: avcC,
                        sampleEntryType: 'avc1',
                        timescale: 1000,
                        duration: 0,
                        language: 'und',
                        width: 320,
                        height: 240,
                      }),
                    ),
                  ),
                );
              }),
            );
          }),
        );
      }),
    );
    w.writeRaw(buildMvex([trackId], { [trackId]: { defaultSampleDuration: 40 } }));
  });
}

/** 最小可用 hvcC：24 字节（profileIdc=1 / tier L / level 93） */
function makeHvcCBytes() {
  const b = new Uint8Array(24);
  b[0] = 1; // configurationVersion
  b[1] = 0x01; // profile_space=0 / tier=L / profile_idc=1
  b[12] = 93; // level_idc
  return b;
}

/* --------------------------------- demuxer --------------------------------- */

test('probe：wide 置信度压到 0.5，其余顶层 box（mdat）0.82', () => {
  const mk = (type) => {
    const b = new Uint8Array(16);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    return b;
  };
  const wide = Mp4Demuxer.probe(mk('wide'));
  assert.equal(wide.confidence, 0.5);
  assert.equal(wide.container, 'mp4');
  const mdat = Mp4Demuxer.probe(mk('mdat'));
  assert.equal(mdat.confidence, 0.82);
  assert.equal(mdat.container, 'mp4');
});

test('open：无 moov → PARSE_ERROR，转 destroyed 并发一次 error', async () => {
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [40, 40],
    withMoov: false,
  });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const errors = [];
  d.on('error', (e) => errors.push(e));
  await assert.rejects(d.open(), (e) => e.code === 'PARSE_ERROR' && /moov box not found/.test(e.message));
  assert.equal(d.state, 'destroyed');
  assert.equal(errors.length, 1);
});

test('open：顶层 largesize box（size=1 + u64）正常扫描，ftyp 无内容 → brands 缺省', async () => {
  const { bytes, payloads } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [40, 40],
    prefix: largesizeFreeBox(),
  });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.container, 'mp4');
  assert.equal(info.brands, undefined); // ftyp 只有 8 字节头 → parseFtypSafe catch → null
  assert.equal(info.tracks.length, 1);
  const s0 = await d.readSample(1);
  assert.deepEqual(s0.data, payloads[0]);
  const s1 = await d.readSample(1);
  assert.deepEqual(s1.data, payloads[1]);
  const eos = await d.readSample(1);
  assert.equal(eos, null);
});

test('open：mdat size=0 延伸到文件尾，扫描与读样本不受影响', async () => {
  const { bytes, mdatOffset } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [40, 40],
  });
  new DataView(bytes.buffer).setUint32(mdatOffset, 0); // size=0 → 到 EOF
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.durationUs, 80000); // 2×40 ticks @1000
  const s = await d.readSample(1);
  assert.equal(s.size, 40);
});

test('open：截断的 largesize 头（<16 字节）→ PARSE_ERROR', async () => {
  // ftyp8 + 12 字节尾部：size=1 + 'free' + u64 只有半截
  const tail = new Uint8Array([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 0]);
  const bytes = new Uint8Array(FTYP8.byteLength + tail.byteLength);
  bytes.set(FTYP8, 0);
  bytes.set(tail, FTYP8.byteLength);
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await assert.rejects(d.open(), (e) => e.code === 'PARSE_ERROR' && /largesize truncated/.test(e.message));
});

test('open：enca 加密 sample entry → NOT_SUPPORTED', async () => {
  const { bytes } = buildSimpleMp4({
    track: {
      type: 'audio',
      codecPrivate: makeAscFixture(),
      sampleEntryType: 'enca',
      channelCount: 2,
      sampleRate: 44100,
    },
    sizes: [40],
    delta: 1024,
  });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await assert.rejects(
    d.open(),
    (e) => e.code === 'NOT_SUPPORTED' && /encrypted sample entry \(enca\)/.test(e.message),
  );
});

test('hvc1 轨：description/codec 取自 hvcC', async () => {
  const hvcC = makeHvcCBytes();
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: hvcC, sampleEntryType: 'hvc1', width: 1920, height: 1080 },
    sizes: [40],
  });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  const track = info.tracks[0];
  assert.deepEqual(track.description, hvcC);
  assert.ok(track.codec.startsWith('hvc1.1.'), `codec=${track.codec}`);
});

test('渐进 MP4 elst：裁剪媒体起点并映射到 movie timeline', async () => {
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240, timescale: 2000 },
    sizes: [1, 1, 1],
    delta: 80,
    movieTimescale: 1000,
    movieDuration: 120,
    keyframeIndices: [0, 1, 2],
    edits: [
      { segmentDuration: 20, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 80, mediaTime: 80, mediaRateInteger: 1, mediaRateFraction: 0 },
    ],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await demuxer.open();
  assert.equal(info.durationUs, 100_000, 'movie duration follows total elst segment duration');
  assert.equal(info.tracks[0].durationUs, 120_000, 'track duration remains media duration');
  assert.equal(info.tracks[0].presentationDurationUs, 100_000);
  const samples = [];
  for (;;) { const sample = await demuxer.readSample(1); if (!sample) break; samples.push(sample); }
  assert.deepEqual(samples.map((sample) => sample.index), [1, 2], 'samples before media_time are omitted');
  assert.deepEqual(samples.map((sample) => sample.timestamp), [20_000, 60_000]);
  assert.deepEqual(samples.map((sample) => sample.dts), [20_000, 60_000]);
  assert.deepEqual(samples.map((sample) => sample.duration), [40_000, 40_000]);
  const gapSeek = await demuxer.seek(10_000);
  assert.equal(gapSeek.actualTimestampUs, 10_000, 'seek inside leading empty edit preserves requested movie position');
  const firstMedia = await demuxer.readSample(1);
  assert.equal(firstMedia.index, 1);
  assert.equal(firstMedia.timestamp, 20_000);
  await demuxer.seek(70_000);
  const afterSeek = await demuxer.readSample(1);
  assert.equal(afterSeek.index, 2);
  assert.equal(afterSeek.timestamp, 60_000);
});

test('渐进 MP4 seek：CTTS 导致 PTS 非单调时仍按 DTS 二分选择 RAP', async () => {
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240, timescale: 1000 },
    sizes: [1, 1, 1, 1, 1], delta: 40, keyframeIndices: [0, 2, 4],
    cttsOffsets: [
      { count: 2, offset: 0 }, { count: 1, offset: 120 },
      { count: 1, offset: 0 }, { count: 1, offset: -80 },
    ],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  await demuxer.open();
  const seek = await demuxer.seek(100_000);
  assert.equal(seek.actualTimestampUs, 80_000);
  const sample = await demuxer.readSample(1);
  assert.equal(sample.index, 2, 'seek keeps decode-time RAP ordering even when PTS are reordered');
  assert.equal(sample.timestamp, 200_000);
  assert.equal(sample.dts, 80_000);
});

test('渐进 MP4 elst：多个媒体编辑及后置空编辑显式回退', async () => {
  const unsupportedEdits = [
    [
      { segmentDuration: 40, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 40, mediaTime: 80, mediaRateInteger: 1, mediaRateFraction: 0 },
    ],
    [
      { segmentDuration: 40, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 20, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
    ],
  ];
  for (const edits of unsupportedEdits) {
    const { bytes } = buildSimpleMp4({
      track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
      sizes: [1, 1, 1], delta: 40, keyframeIndices: [0, 1, 2], edits,
    });
    const info = await new Mp4Demuxer(new MemoryDataSource(bytes)).open();
    assert.equal(info.tracks[0].editListApplied, false);
    assert.ok(info.tracks[0].editListUnsupportedReason);
  }
});

test('渐进 MP4 seek：可变 CTS 的未编辑及回退轨均按 DTS 定位关键帧', async () => {
  for (const edits of [null, [{ segmentDuration: 200, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 }]]) {
    const { bytes } = buildSimpleMp4({
      track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240, timescale: 1000 },
      sizes: [1, 1, 1, 1, 1], delta: 40, keyframeIndices: [0, 2, 4],
      cttsOffsets: [
        { count: 2, offset: 0 }, { count: 1, offset: 120 },
        { count: 1, offset: 0 }, { count: 1, offset: -80 },
      ],
      ...(edits ? { edits } : {}),
    });
    const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
    const info = await demuxer.open();
    if (edits) assert.equal(info.tracks[0].editListApplied, false);
    const seek = await demuxer.seek(100_000);
    assert.equal(seek.actualTimestampUs, 80_000);
    const sample = await demuxer.readSample(1);
    assert.equal(sample.index, 2);
    assert.equal(sample.timestamp, 200_000);
    assert.equal(sample.dts, 80_000);
  }
});

test('渐进 MP4 elst 回退：duration 覆盖原始 timeline 的最终 PTS 结束', async () => {
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240, timescale: 1000 },
    sizes: [1, 1, 1], delta: 40, keyframeIndices: [0, 1, 2],
    movieDuration: 80,
    tkhdDuration: 80,
    edits: [{ segmentDuration: 80, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 }],
    cttsOffsets: [{ count: 2, offset: 0 }, { count: 1, offset: 1 }],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await demuxer.open();
  assert.equal(info.tracks[0].editListApplied, false);
  const samples = [];
  for (;;) { const sample = await demuxer.readSample(1); if (!sample) break; samples.push(sample); }
  assert.equal(samples.at(-1).timestamp, 81_000);
  assert.equal(samples.at(-1).timestamp + samples.at(-1).duration, 121_000);
  assert.equal(info.durationUs, 121_000);
});

test('渐进 MP4 elst：零时长媒体编辑延伸至媒体结尾', async () => {
  const { bytes } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240, timescale: 2000 },
    sizes: [1, 1, 1], delta: 80, keyframeIndices: [0, 1, 2], movieTimescale: 1000, movieDuration: 0,
    edits: [{ segmentDuration: 0, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 }],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await demuxer.open();
  assert.equal(info.durationUs, 120_000);
  assert.equal(info.tracks[0].presentationDurationUs, 120_000);
  assert.equal(info.tracks[0].editListApplied, true);
  const samples = [];
  for (;;) { const sample = await demuxer.readSample(1); if (!sample) break; samples.push(sample); }
  assert.deepEqual(samples.map((sample) => sample.index), [0, 1, 2]);
  assert.deepEqual(samples.map((sample) => sample.timestamp), [0, 40_000, 80_000]);
});

test('渐进 MP4 elst：拒绝非关键帧起点，非样本边界终点显式回退', async () => {
  const { bytes: badStart } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [1, 1, 1], keyframeIndices: [0],
    edits: [{ segmentDuration: 80, mediaTime: 40, mediaRateInteger: 1, mediaRateFraction: 0 }],
  });
  await assert.rejects(new Mp4Demuxer(new MemoryDataSource(badStart)).open(),
    (error) => error.code === 'NOT_SUPPORTED' && /sync sample/.test(error.message));
  const { bytes: partialEnd } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [1, 1, 1], keyframeIndices: [0, 1, 2],
    edits: [{ segmentDuration: 60, mediaTime: 40, mediaRateInteger: 1, mediaRateFraction: 0 }],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(partialEnd));
  const info = await demuxer.open();
  assert.equal(info.tracks[0].editListApplied, false);
  assert.match(info.tracks[0].editListUnsupportedReason, /终点/);
});

test('渐进 MP4 elst：拒绝非单位速率并显式回退可变 composition offset', async () => {
  const { bytes: badRate } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [1, 1, 1], keyframeIndices: [0, 1, 2],
    edits: [{ segmentDuration: 80, mediaTime: 40, mediaRateInteger: 2, mediaRateFraction: 0 }],
  });
  await assert.rejects(new Mp4Demuxer(new MemoryDataSource(badRate)).open(),
    (error) => error.code === 'NOT_SUPPORTED' && /media rate/.test(error.message));
  const { bytes: variableCts } = buildSimpleMp4({
    track: { type: 'video', codecPrivate: makeAvcCFixture(), sampleEntryType: 'avc1', width: 320, height: 240 },
    sizes: [1, 1, 1], keyframeIndices: [0, 1, 2],
    edits: [{ segmentDuration: 80, mediaTime: 41, mediaRateInteger: 1, mediaRateFraction: 0 }],
    cttsOffsets: [{ count: 1, offset: 0 }, { count: 2, offset: 1 }],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(variableCts));
  const info = await demuxer.open();
  assert.equal(info.tracks[0].editListApplied, false);
  assert.match(info.tracks[0].editListUnsupportedReason, /variable composition offsets/);
});

test('分片 MP4：暂不支持 elst，拒绝静默丢弃 timeline edits', async () => {
  const { bytes } = buildFragmentedFixture({
    edits: [
      { segmentDuration: 20, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 120, mediaTime: 120, mediaRateInteger: 1, mediaRateFraction: 0 },
    ],
  });
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  await assert.rejects(demuxer.open(), (error) =>
    error.code === 'NOT_SUPPORTED' && /fragmented MP4 edit lists are not supported/.test(error.message));
});

test('分片迭代：moof 后无 mdat → PARSE_ERROR', async () => {
  const moof8 = box('moof', () => {}); // 空内容 moof（解析前就应拒绝）
  const ftyp = buildFtyp({ majorBrand: 'msfh', compatible: ['msfh'] });
  const moov = buildFmp4Moov(1, makeAvcCFixture());
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength + moof8.byteLength);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  out.set(moof8, ftyp.byteLength + moov.byteLength);

  const d = new Mp4Demuxer(new MemoryDataSource(out));
  const info = await d.open();
  assert.equal(info.fragmented, true);
  await assert.rejects(d.readSample(1), (e) => e.code === 'PARSE_ERROR' && /no following mdat/.test(e.message));
});

test('分片 seek：关键帧二分命中后从 resumeIndex 续读', async () => {
  const { bytes } = buildFragmentedFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  for (let i = 0; i < 4; i++) await d.readSample(1); // 两个 moof 全部入表
  const r = await d.seek(120000); // ts=1000 → 120 ticks；关键帧 dts 0/120 → 落 120
  assert.equal(r.actualTimestampUs, 120000);
  const s = await d.readSample(1);
  assert.equal(s.index, 3);
  assert.equal(s.dts, 120000);
});

test('双轨渐进 seek：目标轨关键帧对齐，其余轨按 _locateResumeIndex 定位', async () => {
  const avcC = makeAvcCFixture();
  const asc = makeAscFixture();
  const videoSizes = [40, 40, 40, 40];
  const audioSizes = [40, 40, 40, 40];
  const spec = {
    timescale: 1000,
    duration: 160,
    tracks: [
      {
        track: {
          id: 1,
          type: 'video',
          codecPrivate: avcC,
          sampleEntryType: 'avc1',
          timescale: 1000,
          duration: 160,
          language: 'und',
          width: 320,
          height: 240,
        },
        sizes: videoSizes,
        keyframeIndices: [0, 3],
        chunkOffsets: [0, 0],
        samplesPerChunk: 2,
        sttsRuns: [{ count: 4, delta: 40 }],
        cttsOffsets: [{ count: 4, offset: -80 }],
      },
      {
        track: {
          id: 2,
          type: 'audio',
          codecPrivate: asc,
          sampleEntryType: 'mp4a',
          timescale: 44100,
          duration: 4 * 1024,
          language: 'und',
          channelCount: 2,
          sampleRate: 44100,
        },
        sizes: audioSizes,
        chunkOffsets: [0],
        samplesPerChunk: 4,
        sttsRuns: [{ count: 4, delta: 1024 }],
      },
    ],
  };
  const ftyp = buildFtyp({ majorBrand: 'isom', compatible: ['isom', 'iso2'] });
  buildMoov(spec); // 两遍构造定型 moov 长度
  const base = ftyp.byteLength + buildMoov(spec).byteLength;
  spec.tracks[0].chunkOffsets = [base + 8, base + 8 + 80];
  spec.tracks[1].chunkOffsets = [base + 8 + 160];
  const moov = buildMoov(spec);
  const videoPayloads = videoSizes.map((size, i) => {
    const d = new Uint8Array(size);
    for (let j = 0; j < size; j++) d[j] = (i * 31 + j) & 0xff;
    return d;
  });
  const audioPayloads = audioSizes.map((size, i) => {
    const d = new Uint8Array(size);
    for (let j = 0; j < size; j++) d[j] = (i * 11 + j) & 0xff;
    return d;
  });
  const mdat = buildMdat([...videoPayloads, ...audioPayloads]);
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  bytes.set(ftyp, 0);
  bytes.set(moov, ftyp.byteLength);
  bytes.set(mdat, ftyp.byteLength + moov.byteLength);

  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  // 目标 80ms → 按视频 DTS 选择 sync sample 0，其余轨也从 DTS 落点 0 续读。
  const r = await d.seek(80000);
  assert.equal(r.actualTimestampUs, 0);
  const v = await d.readSample(1);
  assert.equal(v.index, 0);
  const a = await d.readSample(2);
  assert.equal(a.index, 0);
  assert.equal(a.dts, 0);
});

test('expandSampleTable：stsc 首条目 firstChunk 晚于全部 chunk → 兜底 0 → 表不一致抛错', () => {
  const stbl = {
    stsz: { sizes: [10, 10] },
    stts: { runs: [{ count: 2, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 1, samplesPerChunk: 2 }] }, // firstChunk=1 > 唯一 chunk 下标 0
    stco: { offsets: [100] },
  };
  assert.throws(
    () => expandSampleTable(stbl),
    (e) => e.code === 'PARSE_ERROR' && /sample table inconsistent/.test(e.message),
  );
});

/* -------------------------------- box-parser -------------------------------- */

test('parseTkhd version=1：u64 时间戳/时长字段布局', () => {
  const tkhd = fullBox('tkhd', 1, 1, (w) => {
    w.writeU64(100n).writeU64(200n); // creation/modification
    w.writeU32(7); // trackId
    w.writeU32(0); // reserved
    w.writeU64(99000n); // duration（v1 为 u64）
    w.writeU32(0).writeU32(0); // reserved[2]
    w.writeU16(0).writeU16(0).writeU16(0x0100).writeU16(0); // layer/altGroup/volume/reserved
    // unity matrix（36 字节）
    w.writeU32(0x00010000).writeU32(0).writeU32(0);
    w.writeU32(0).writeU32(0x00010000).writeU32(0);
    w.writeU32(0).writeU32(0).writeU32(0x40000000);
    w.writeU32(320 << 16).writeU32(240 << 16); // width/height 16.16
  });
  const t = parseTkhd(new ByteStream(tkhd, 8));
  assert.equal(t.enabled, true);
  assert.equal(t.trackId, 7);
  assert.equal(t.duration, 99000);
  assert.equal(t.width, 320);
  assert.equal(t.height, 240);
});

test('parseMvex：mehd version=1 fragmentDuration（u64）', () => {
  const mvex = box('mvex', (w) => {
    w.writeRaw(buildTrex({ trackId: 1, defaultSampleDuration: 40 }));
    w.writeRaw(fullBox('mehd', 1, 0, (w2) => w2.writeU64(5000n)));
  });
  const out = parseMvex(new ByteStream(mvex, 8));
  assert.equal(out.mehd.fragmentDuration, 5000);
  assert.equal(out.trexByTrack[1].defaultSampleDuration, 40);
});

test('parseBoxByType：视觉 entry 分派与未知类型 null', () => {
  const body = new Uint8Array(78); // VisualSampleEntry 固定字段长度
  const visual = parseBoxByType(new ByteStream(body, 0), 'mp4v');
  assert.equal(visual.type, 'mp4v');
  assert.equal(visual.width, 0);
  assert.equal(visual.height, 0);
  assert.equal(parseBoxByType(new ByteStream(body, 0), 'zzzz'), null);
});

test('parseSampleEntry：子 box 全部解析失败 → 原错误重抛（不静默吞）', () => {
  // 78 字节固定字段 + 尾部垃圾伪 box（非法 size）
  const body = new Uint8Array(78 + 8);
  new DataView(body.buffer).setUint32(78, 0xffffff00);
  body.set([0x62, 0x6f, 0x67, 0x75], 82); // 'bogu'
  assert.throws(
    () => parseSampleEntry('mp4v', new ByteStream(body, 0)),
    (e) => e.code === 'PARSE_ERROR' && /invalid box size/.test(e.message),
  );
});
