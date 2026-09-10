/**
 * mov 采样表 / 轨道 / 时间基 深度覆盖（第八批缺陷狩猎）。
 *
 * 目标分支（demuxer.js 继承 mp4 的解析能力）：
 *  - stsc：多 run、边界过渡、samplesPerChunk=0/1/large；
 *  - stts：多 run 变 delta、大 delta、run 总数与 stsz 一致性；
 *  - stss：首样本非关键帧、全部/部分关键帧；
 *  - stsz：零尺寸样本、defaultSize 模式；
 *  - ctts：v0 无符号、v1 有符号（负偏移 → 乱序呈现）；
 *  - elst：空编辑 + 非空正偏移（mediaTimeSec 暴露，但呈现时间线未平移——见报告）；
 *  - 多轨（video+audio+subtitle）按 handler 选择；
 *  - timescale 奇数/大值、每轨 duration；
 *  - 畸形 brand：probe 对未知/非 QT 品牌的正确取舍；
 *  - 逐字节增量喂入（StreamingDataSource）→ 顶层/原子照常解析。
 *
 * 单元级走 expandSampleTable（mp4/src/demuxer.js），端到端走 MovDemuxer。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSampleTable } from '../../mp4/src/demuxer.js';
import { parseError, notSupported } from '../../core/src/errors.js';
import { MovDemuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { ticksToUs } from '../../core/src/index.js';
import {
  box,
  fullBox,
  buildFtyp,
  buildMdat,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildSmhd,
  buildDinf,
  buildStsd,
  buildStts,
  buildStsc,
  buildStsz,
  buildStco,
  buildStss,
  buildCtts,
} from '../../mp4/src/box-builder.js';
import { makeAvcCFixture } from '../../mp4/__tests__/fixtures.js';

/* --------------------------------- 构造助手 --------------------------------- */

/** samplesPerChunkOf 复刻 expandSampleTable 的口径，保证 fixture 自洽 */
function samplesPerChunkOf(entries, chunkIndex) {
  for (let e = entries.length - 1; e >= 0; e--) {
    if (entries[e].firstChunk <= chunkIndex) return entries[e].samplesPerChunk;
  }
  return 0;
}

/** 依 sizes + stscEntries 把样本打包成 chunk 载荷（与展开逻辑互逆） */
function layoutChunks(sizes, stscEntries) {
  const chunks = [];
  let si = 0;
  let c = 0;
  while (si < sizes.length) {
    const spc = samplesPerChunkOf(stscEntries, c);
    const n = Math.min(Math.max(spc, 0), sizes.length - si);
    const total = sizes.slice(si, si + n).reduce((a, b) => a + b, 0);
    const payload = new Uint8Array(total);
    let p = 0;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < sizes[si + k]; j++) payload[p++] = (si * 7 + k * 3 + j) & 0xff;
    }
    chunks.push(payload);
    si += n;
    c++;
  }
  return chunks;
}

/** ctts version 0（无符号偏移）手拼 */
function buildCttsV0(runs) {
  return fullBox('ctts', 0, 0, (w) => {
    w.writeU32(runs.length);
    for (const r of runs) w.writeU32(r.count).writeU32(r.offset);
  });
}

/** raw 风格 stsd（未识别 sample entry → {raw:true}），用于 subtitle 等 */
function buildRawStsd(sampleType) {
  return fullBox('stsd', 0, 0, (w) => {
    w.writeU32(1);
    w.writeRaw(
      box(sampleType, (ew) => {
        for (let i = 0; i < 6; i++) ew.writeU8(0);
        ew.writeU16(1); // data_reference_index
        ew.writeRaw(new Uint8Array(8)); // 占位 body
      }),
    );
  });
}

/** 构造单视频轨 mov（深度分支用）；返回 bytes 与逐样本期望数据 */
function buildMovDeep({
  movieTimescale = 600,
  duration = 160,
  sizes,
  sttsRuns,
  stscEntries,
  stss = null,
  ctts = null, // {version, runs}
  width = 64,
  height = 48,
}) {
  const avcC = makeAvcCFixture();
  const stsd = buildStsd({
    id: 1,
    type: 'video',
    sampleEntryType: 'avc1',
    timescale: movieTimescale,
    duration,
    language: 'und',
    width,
    height,
    codecPrivate: avcC,
  });

  const chunks = layoutChunks(sizes, stscEntries);

  function buildMoov(chunkOffsets) {
    return box('moov', (w) => {
      w.writeRaw(buildMvhd({ timescale: movieTimescale, duration, nextTrackId: 2 }));
      w.writeRaw(
        box('trak', (tw) => {
          tw.writeRaw(buildTkhd({ trackId: 1, duration, isVideo: true, width, height }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: movieTimescale, duration }));
              mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'v' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(buildVmhd());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(stsd);
                      sw.writeRaw(buildStts(sttsRuns));
                      if (ctts) {
                        sw.writeRaw(ctts.version === 0 ? buildCttsV0(ctts.runs) : buildCtts(ctts.runs));
                      }
                      if (stss && stss.length) sw.writeRaw(buildStss(stss));
                      sw.writeRaw(buildStsc(stscEntries));
                      sw.writeRaw(buildStsz(sizes));
                      sw.writeRaw(buildStco(chunkOffsets));
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );
    });
  }

  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  const probeMoov = buildMoov(chunks.map(() => 0));
  const mdat = buildMdat(chunks);
  const base = ftyp.byteLength + probeMoov.byteLength;
  let cursor = 0;
  const chunkOffsets = chunks.map((ch) => {
    const off = base + 8 + cursor;
    cursor += ch.byteLength;
    return off;
  });
  const moov = buildMoov(chunkOffsets);
  if (moov.byteLength !== probeMoov.byteLength) throw new Error('moov size drift');
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  let off = 0;
  for (const p of [ftyp, moov, mdat]) {
    bytes.set(p, off);
    off += p.byteLength;
  }

  // 逐样本期望数据：按 chunk 切片
  const perSample = [];
  let si = 0;
  let ci = 0;
  const spcFn = (c) => samplesPerChunkOf(stscEntries, c);
  for (let c = 0; c < chunks.length; c++) {
    const spc = spcFn(c);
    const n = Math.min(spc, sizes.length - si);
    let p = 0;
    for (let k = 0; k < n; k++) {
      perSample.push(chunks[c].subarray(p, p + sizes[si + k]));
      p += sizes[si + k];
    }
    si += n;
    ci++;
  }
  void ci;

  return { bytes, perSample, chunkOffsets, movieTimescale };
}

/* ------------------------- 单元：stsc 多 run / 边界 ------------------------- */

test('expandSampleTable：stsc 三 run 边界过渡（1→2→3 样本/chunk）', () => {
  // chunk0:1, chunk1:2, chunk2 起:3 → 样本 1+2+3*?=8 => chunk0,1,2(3)=6, chunk3(3)不全
  const sizes = [10, 10, 10, 10, 10, 10, 10, 10];
  const stsc = {
    entries: [
      { firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 },
      { firstChunk: 1, samplesPerChunk: 2, sampleDescriptionIndex: 1 },
      { firstChunk: 2, samplesPerChunk: 3, sampleDescriptionIndex: 1 },
    ],
  };
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes, sampleCount: sizes.length },
    stts: { runs: [{ count: sizes.length, delta: 1 }] },
    stsc,
    stco: { offsets: [100, 200, 300, 400], isCo64: false },
  });
  // chunk0 1 样本 → offset 100；chunk1 2 样本 → 200,210；chunk2 3 → 300,310,320；chunk3 仅剩 2 样本 → 400,410
  assert.deepEqual(samples.map((s) => s.offset), [100, 200, 210, 300, 310, 320, 400, 410]);
});

test('expandSampleTable：stsc samplesPerChunk=1 与 large（100）均正确', () => {
  for (const spc of [1, 100]) {
    const n = spc;
    const sizes = new Array(n).fill(5);
    const { samples } = expandSampleTable({
      stsz: { defaultSize: 0, sizes, sampleCount: n },
      stts: { runs: [{ count: n, delta: 1 }] },
      stsc: { entries: [{ firstChunk: 0, samplesPerChunk: spc, sampleDescriptionIndex: 1 }] },
      stco: { offsets: [500], isCo64: false },
    });
    assert.equal(samples.length, n);
    const offs = samples.map((s) => s.offset);
    assert.deepEqual(offs, Array.from({ length: n }, (_, i) => 500 + i * 5));
  }
});

test('expandSampleTable：stsc samplesPerChunk=0 → PARSE_ERROR(inconsistent)', () => {
  assert.throws(
    () =>
      expandSampleTable({
        stsz: { defaultSize: 0, sizes: [1, 1], sampleCount: 2 },
        stts: { runs: [{ count: 2, delta: 1 }] },
        stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 0, sampleDescriptionIndex: 1 }] },
        stco: { offsets: [10, 20], isCo64: false },
      }),
    (e) => e.code === 'PARSE_ERROR' && /inconsistent/.test(e.message),
  );
});

/* ------------------------- 单元：stts 多 run / 大 delta ------------------------- */

test('expandSampleTable：stts 多 run 变 delta（10/20/5）', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [8, 8, 8, 8, 8], sampleCount: 5 },
    stts: { runs: [{ count: 2, delta: 10 }, { count: 2, delta: 20 }, { count: 1, delta: 5 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2, 3, 4], isCo64: false },
  });
  // dts[i] = Σ delta[0..i-1]（样本自身 delta 只影响下一个样本的 dts）：
  // delta=[10,10,20,20,5] → dts=[0,10,20,40,60]
  assert.deepEqual(samples.map((s) => s.delta), [10, 10, 20, 20, 5]);
  assert.deepEqual(samples.map((s) => s.dts), [0, 10, 20, 40, 60]);
});

test('expandSampleTable：stts 大 delta（1<<24）不溢出且累加正确', () => {
  const big = 1 << 24;
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [4, 4], sampleCount: 2 },
    stts: { runs: [{ count: 1, delta: big }, { count: 1, delta: big }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, big], isCo64: false },
  });
  assert.deepEqual(samples.map((s) => s.dts), [0, big]);
});

test('expandSampleTable：stts run 总数 < stsz 数量 → 沿用末 delta 补齐（不丢样本）', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1, 1], sampleCount: 4 },
    stts: { runs: [{ count: 1, delta: 7 }, { count: 1, delta: 3 }] }, // 仅覆盖 2
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2, 3], isCo64: false },
  });
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.map((s) => s.dts), [0, 7, 10, 13]);
});

/* ------------------------- 单元：stss 首样本非关键帧 ------------------------- */

test('expandSampleTable：stss 不含首样本（1-based 从 2 开始）→ #0 非关键帧', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1, 1], sampleCount: 4 },
    stts: { runs: [{ count: 4, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2, 3], isCo64: false },
    stss: { indices: [1, 2, 3] }, // 1-based：样本 #1/#2/#3 为关键帧，#0 不是
  });
  assert.deepEqual(samples.map((s) => s.keyframe), [false, true, true, true]);
});

test('expandSampleTable：stss 全部样本 → 全关键帧', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1], sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2], isCo64: false },
    stss: { indices: [0, 1, 2] },
  });
  assert.equal(samples.every((s) => s.keyframe), true);
});

/* ------------------------- 单元：stsz 零尺寸 ------------------------- */

test('expandSampleTable：stsz 含零尺寸样本 → 连续 offset、size=0 且数据长度 0', () => {
  const sizes = [8, 0, 8, 0];
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes, sampleCount: sizes.length },
    stts: { runs: [{ count: sizes.length, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [100, 108, 108, 116], isCo64: false },
  });
  assert.deepEqual(samples.map((s) => s.size), [8, 0, 8, 0]);
  // 零尺寸样本与下一非零样本共享同一 offset（相邻排布）
  assert.equal(samples[1].offset, 108);
  assert.equal(samples[2].offset, 108);
});

/* ------------------------- 单元：ctts v0 / v1 符号 ------------------------- */

test('expandSampleTable：ctts version=0（无符号偏移）正确写入 cts', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1], sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 40 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2], isCo64: false },
    ctts: { version: 0, runs: [{ count: 1, offset: 0 }, { count: 2, offset: 80 }] },
  });
  assert.deepEqual(samples.map((s) => s.cts), [0, 80, 80]);
});

test('expandSampleTable：ctts version=1 负偏移 → 乱序呈现（pts<dts）', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1], sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 40 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [0, 1, 2], isCo64: false },
    ctts: { version: 1, runs: [{ count: 1, offset: 0 }, { count: 1, offset: -40 }, { count: 1, offset: 40 }] },
  });
  // dts: 0,40,80；cts: 0,-40,40 → pts: 0,0,120（样本1 早于样本0 呈现→B 帧）
  assert.deepEqual(samples.map((s) => s.dts + s.cts), [0, 0, 120]);
});

/* ------------------------- 端到端：stsc 多 chunk 映射 + 数据校验 ------------------------- */

test('端到端：stsc 三 run 边界 → 样本 offset 映射正确且数据可读取', async () => {
  const sizes = [10, 12, 14, 16, 18, 20, 22, 24];
  const { bytes, perSample, movieTimescale } = buildMovDeep({
    sizes,
    sttsRuns: [{ count: sizes.length, delta: 40 }],
    stscEntries: [
      { firstChunk: 0, samplesPerChunk: 1 },
      { firstChunk: 1, samplesPerChunk: 2 },
      { firstChunk: 2, samplesPerChunk: 3 },
    ],
    stss: [0, 1, 2, 3, 4, 5, 6, 7],
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    assert.deepEqual([...samples[i].data], [...perSample[i]], `样本 #${i} 数据`);
    assert.equal(samples[i].size, sizes[i]);
  }
  // pts 按 ticks→µs
  assert.equal(samples[0].timestamp, ticksToUs(0, movieTimescale));
  assert.equal(samples[3].timestamp, ticksToUs(120, movieTimescale));
});

/* ------------------------- 端到端：stsz 零尺寸（lazy 关闭，size=0 不越界） ------------------------- */

test('端到端：stsz 含零尺寸样本 → 迭代不崩溃且 size 透出 0', async () => {
  const sizes = [16, 0, 16];
  const { bytes } = buildMovDeep({
    sizes,
    sttsRuns: [{ count: sizes.length, delta: 1000 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 1, 2],
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes), { lazySamples: false });
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map((s) => s.size), [16, 0, 16]);
  assert.equal(samples[1].data.byteLength, 0, '零尺寸样本数据长度 0');
});

/* ------------------------- 端到端：ctts v1 负偏移 → pts 乱序 ------------------------- */

test('端到端：ctts v1 负偏移使 pts<dts（B 帧呈现早于解码）', async () => {
  const sizes = [40, 40, 40];
  const ts = 600;
  const { bytes } = buildMovDeep({
    movieTimescale: ts,
    sizes,
    sttsRuns: [{ count: 3, delta: 40 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 1, 2],
    ctts: { version: 1, runs: [{ count: 1, offset: 0 }, { count: 1, offset: -40 }, { count: 1, offset: 40 }] },
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples[0].timestamp, ticksToUs(0, ts));
  assert.equal(samples[1].timestamp, ticksToUs(0, ts), '样本1 pts 与样本0 同刻');
  assert.equal(samples[2].timestamp, ticksToUs(120, ts));
});

/* ------------------------- 端到端：多轨（video+audio+subtitle）按 handler 选择 ------------------------- */

function buildMultiTrackMov() {
  const avcC = makeAvcCFixture();
  const MOVIE_TS = 600;
  const AUDIO_TS = 44100;

  const video = {
    id: 1,
    handler: 'vide',
    sampleEntryType: 'avc1',
    timescale: MOVIE_TS,
    duration: 240,
    width: 64,
    height: 48,
    codecPrivate: avcC,
    sizes: [40, 40, 40, 40],
    sttsRuns: [{ count: 4, delta: 40 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 2],
  };
  const audio = {
    id: 2,
    handler: 'soun',
    sampleEntryType: 'mp4a',
    timescale: AUDIO_TS,
    duration: 17640,
    codecPrivate: new Uint8Array([0x12, 0x10]),
    sizes: [10, 10, 10, 10],
    sttsRuns: [{ count: 4, delta: 4410 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: null,
  };
  const subtitle = {
    id: 3,
    handler: 'subt',
    sampleEntryType: 'subt',
    timescale: 1000,
    duration: 4000,
    sizes: [5, 5, 5, 5],
    sttsRuns: [{ count: 4, delta: 1000 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: null,
  };

  const tracks = [video, audio, subtitle];

  // 计算每轨 mdat 区域
  function buildMoov(chunkOffsetByTrack) {
    return box('moov', (w) => {
      w.writeRaw(buildMvhd({ timescale: MOVIE_TS, duration: 240, nextTrackId: 4 }));
      for (const t of tracks) {
        const stsd =
          t.handler === 'subt'
            ? buildRawStsd(t.sampleEntryType)
            : buildStsd({
                id: t.id,
                type: t.handler === 'vide' ? 'video' : 'audio',
                sampleEntryType: t.sampleEntryType,
                timescale: t.timescale,
                duration: t.duration,
                language: 'und',
                width: t.width,
                height: t.height,
                codecPrivate: t.codecPrivate,
              });
        w.writeRaw(
          box('trak', (tw) => {
            tw.writeRaw(buildTkhd({ trackId: t.id, duration: t.duration, isVideo: t.handler === 'vide', isAudio: t.handler === 'soun' }));
            tw.writeRaw(
              box('mdia', (mw) => {
                mw.writeRaw(buildMdhd({ timescale: t.timescale, duration: t.duration }));
                mw.writeRaw(buildHdlr({ handlerType: t.handler, name: t.handler }));
                mw.writeRaw(
                  box('minf', (iw) => {
                    iw.writeRaw(t.handler === 'vide' ? buildVmhd() : buildSmhd());
                    iw.writeRaw(buildDinf());
                    iw.writeRaw(
                      box('stbl', (sw) => {
                        sw.writeRaw(stsd);
                        sw.writeRaw(buildStts(t.sttsRuns));
                        if (t.stss) sw.writeRaw(buildStss(t.stss));
                        sw.writeRaw(buildStsc(t.stscEntries));
                        sw.writeRaw(buildStsz(t.sizes));
                        sw.writeRaw(buildStco(chunkOffsetByTrack[t.id]));
                      }),
                    );
                  }),
                );
              }),
            );
          }),
        );
      }
    });
  }

  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });

  // 占位 stage1：每轨 1 chunk/样本，offset 临时 0
  const tmpOffsets = {};
  for (const t of tracks) tmpOffsets[t.id] = t.sizes.map(() => 0);
  const probeMoov = buildMoov(tmpOffsets);

  // 依据 probe moov 大小排布 mdat
  const mdatChunks = [];
  const trackRegion = {};
  let payloadCursor = 0;
  for (const t of tracks) {
    trackRegion[t.id] = { start: payloadCursor, chunks: [] };
    for (let i = 0; i < t.sizes.length; i++) {
      const payload = new Uint8Array(t.sizes[i]);
      for (let j = 0; j < t.sizes[i]; j++) payload[j] = (t.id * 31 + i * 7 + j) & 0xff;
      mdatChunks.push(payload);
      trackRegion[t.id].chunks.push(payload);
      payloadCursor += t.sizes[i];
    }
  }
  const mdat = buildMdat(mdatChunks);
  const base = ftyp.byteLength + probeMoov.byteLength;
  const realOffsets = {};
  for (const t of tracks) {
    let c = 0;
    realOffsets[t.id] = t.sizes.map(() => 0);
    for (let i = 0; i < t.sizes.length; i++) {
      realOffsets[t.id][i] = base + 8 + trackRegion[t.id].start + c;
      c += t.sizes[i];
    }
  }
  const moov = buildMoov(realOffsets);
  if (moov.byteLength !== probeMoov.byteLength) throw new Error('multitrack moov size drift');

  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  let off = 0;
  for (const p of [ftyp, moov, mdat]) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return { bytes, tracks };
}

test('端到端：video+audio+subtitle 三轨按 handler 分派类型并各自产出样本', async () => {
  const { bytes, tracks } = buildMultiTrackMov();
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.tracks.length, 3);
  const types = info.tracks.map((t) => t.type);
  assert.deepEqual(types, ['video', 'audio', 'text']);
  // 观察点（待核对）：text 轨 type 已正确分派为 'text'，但 sampleEntryType 未回填（undefined）。
  // 是否应回填 subt/tx3g/wvtt 取决于 stsd 解析对文本条目的支持范围，已登记候选池。
  assert.equal(info.tracks[2].sampleEntryType, undefined, 'text 轨当前未回填 sampleEntryType');

  // 逐轨迭代，校验样本数与 size
  for (const t of tracks) {
    const samples = [];
    for await (const s of d.samples(t.id)) samples.push(s);
    assert.equal(samples.length, t.sizes.length, `track ${t.id} 样本数`);
    assert.deepEqual(samples.map((s) => s.size), t.sizes, `track ${t.id} size`);
  }
  await d.destroy();
});

/* ------------------------- 端到端：奇数/大 timescale 与时间基换算 ------------------------- */

test('端到端：奇数 timescale（2997）dts µs 就近取整正确', async () => {
  const ts = 2997; // 非 600 的整数倍，考验 ticksToUs 取整
  const sizes = [20, 20, 20];
  const { bytes } = buildMovDeep({
    movieTimescale: ts,
    duration: 300,
    sizes,
    sttsRuns: [{ count: 3, delta: 1001 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 1, 2],
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.tracks[0].timescale, ts, '诊断 timescale 透出');
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  // dts ticks: 0,1001,2002 → µs 就近取整
  assert.equal(samples[0].dts, ticksToUs(0, ts));
  assert.equal(samples[1].dts, ticksToUs(1001, ts));
  assert.equal(samples[2].dts, ticksToUs(2002, ts));
});

/* ------------------------- 端到端：elst 空编辑 + 非空正偏移 ------------------------- */

test('端到端：elst 空编辑 + 正 mediaTime → emptyEdit/mediaTimeSec 暴露（呈现未被平移）', async () => {
  const ts = 600;
  const sizes = [40, 40];
  const { bytes: bytes2 } = await buildMovDeepWithElst({
    movieTimescale: ts,
    duration: 80,
    sizes,
    sttsRuns: [{ count: 2, delta: 40 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 1],
    elst: { segmentDuration: 40, mediaTime: 600 }, // 非空正偏移：从媒体 1s 处起播
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes2));
  const info = await d.open();
  const v = info.tracks[0];
  assert.equal(v.emptyEdit, true, '存在空编辑');
  assert.ok(Math.abs(v.mediaTimeSec - 1) < 1e-9, 'mediaTimeSec = 1s（mediaTime=600/600）');
  // 注意：mediaTimeSec 已暴露，但样本呈现时间戳未平移（见缺陷报告）
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples[0].timestamp, ticksToUs(0, ts), '首样本 pts 仍从 0 起（编辑偏移未应用）');
});

/** 带 elst 注入的单视频轨构造（复用 layoutChunks + 偏移重算） */
async function buildMovDeepWithElst({
  movieTimescale,
  duration,
  sizes,
  sttsRuns,
  stscEntries,
  stss,
  elst,
}) {
  const { buildEdts } = await import('../../mp4/src/box-builder.js');
  const avcC = makeAvcCFixture();
  const stsd = buildStsd({
    id: 1,
    type: 'video',
    sampleEntryType: 'avc1',
    timescale: movieTimescale,
    duration,
    language: 'und',
    width: 8,
    height: 8,
    codecPrivate: avcC,
  });
  const chunks = layoutChunks(sizes, stscEntries);
  const edts = buildEdts({
    entries: [
      { segmentDuration: duration / 2, mediaTime: -1 },
      { segmentDuration: duration / 2, mediaTime: elst.mediaTime },
    ],
  });
  function buildMoov(chunkOffsets) {
    return box('moov', (w) => {
      w.writeRaw(buildMvhd({ timescale: movieTimescale, duration, nextTrackId: 2 }));
      w.writeRaw(
        box('trak', (tw) => {
          if (edts) tw.writeRaw(edts);
          tw.writeRaw(buildTkhd({ trackId: 1, duration, isVideo: true, width: 8, height: 8 }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: movieTimescale, duration }));
              mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'v' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(buildVmhd());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(stsd);
                      sw.writeRaw(buildStts(sttsRuns));
                      sw.writeRaw(buildStss(stss));
                      sw.writeRaw(buildStsc(stscEntries));
                      sw.writeRaw(buildStsz(sizes));
                      sw.writeRaw(buildStco(chunkOffsets));
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );
    });
  }
  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  const probeMoov = buildMoov(chunks.map(() => 0));
  const mdat = buildMdat(chunks);
  const base = ftyp.byteLength + probeMoov.byteLength;
  let cursor = 0;
  const chunkOffsets = chunks.map((ch) => {
    const o = base + 8 + cursor;
    cursor += ch.byteLength;
    return o;
  });
  const moov = buildMoov(chunkOffsets);
  if (moov.byteLength !== probeMoov.byteLength) throw new Error('moov drift with elst');
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  let off = 0;
  for (const p of [ftyp, moov, mdat]) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return { bytes };
}

/* ------------------------- 畸形 brand：probe 取舍 ------------------------- */

test('probe：ftyp 非 QT/非 isom 未知品牌 → MovDemuxer.probe 让位（不误判 mov）', () => {
  // 构造 ftyp majorBrand='xyz ' 的伪文件：MovDemuxer 不应认作 mov
  const ftyp = buildFtyp({ majorBrand: 'xyz ', minorVersion: 0, compatible: ['xyz '] });
  const head = ftyp.subarray(0, Math.min(64, ftyp.byteLength));
  const hit = MovDemuxer.probe(head);
  // 观察点（待核对）：未知品牌 'xyz ' 未让位为 null，仍命中 mov 且置信度 0.57（低于强命中阈值）。
  // 是否属于过度匹配、以及 probe 的阈值/让位策略，已登记候选池待核对。
  assert.ok(hit && hit.container === 'mov', '未知品牌当前仍命中 mov（低置信）');
  assert.ok(hit.confidence < 0.8, `未知品牌置信度应偏低，实际 ${hit && hit.confidence}`);
});

test('probe：ftyp 品牌 "qt6 "（仅前缀匹配）不被 looksLikeQuickTime 视为 qt，但 Mp4Demuxer 仍标 mov', async () => {
  const ftyp = buildFtyp({ majorBrand: 'qt6 ', minorVersion: 0, compatible: ['qt6 '] });
  const head = ftyp.subarray(0, Math.min(64, ftyp.byteLength));
  const { looksLikeQuickTime } = await import('../src/atom-compat.js');
  assert.equal(looksLikeQuickTime(head), false, 'qt6 不等于精确 "qt  "');
  const { Mp4Demuxer } = await import('../../mp4/src/demuxer.js');
  const mp4Hit = Mp4Demuxer.probe(head);
  assert.ok(mp4Hit && mp4Hit.container === 'mov', 'Mp4Demuxer 按 startsWith("qt") 仍归 mov');
});

/* ------------------------- 增量字节喂入（1 字节/次） ------------------------- */

class StreamingDataSource {
  constructor(totalBytes) {
    this._buf = new Uint8Array(0);
    this._size = totalBytes;
    this._closed = false;
    this._waiters = [];
  }
  get size() {
    return this._size;
  }
  push(chunk) {
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf, 0);
    merged.set(chunk, this._buf.length);
    this._buf = merged;
    const ws = this._waiters.splice(0);
    for (const w of ws) w();
  }
  async read(offset, len) {
    while (this._buf.length < offset + len && !this._closed) {
      await new Promise((resolve) => this._waiters.push(resolve));
    }
    const end = Math.min(offset + len, this._buf.length);
    return this._buf.slice(offset, end);
  }
  destroy() {}
}

test('端到端：逐字节增量喂入（1 字节/次）→ 顶层/原子照常解析出样本', async () => {
  const sizes = [32, 32, 32];
  const { bytes, perSample } = buildMovDeep({
    sizes,
    sttsRuns: [{ count: sizes.length, delta: 40 }],
    stscEntries: [{ firstChunk: 0, samplesPerChunk: 1 }],
    stss: [0, 1, 2],
  });
  const src = new StreamingDataSource(bytes.length);
  const d = new MovDemuxer(src);
  const openPromise = d.open();
  for (let i = 0; i < bytes.length; i++) {
    src.push(bytes.subarray(i, i + 1));
    await new Promise((r) => setTimeout(r, 0));
  }
  await openPromise;
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    assert.deepEqual([...samples[i].data], [...perSample[i]], `增量喂入样本 #${i}`);
  }
  await d.destroy();
});
