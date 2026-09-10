/**
 * 采样表专项：stts/stsc/stsz/stco/co64/stss/ctts 的解析与映射边界，
 * 以及样本表不一致、stss 越界的容错。单元级走 expandSampleTable，
 * 端到端走 MovDemuxer（自建最小 mov fixture）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSampleTable } from '../../mp4/src/demuxer.js';
import { parseError } from '../../core/src/errors.js';
import { MovDemuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import {
  box,
  buildFtyp,
  buildMdat,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildDinf,
  buildStsd,
  buildStts,
  buildStsc,
  buildStsz,
  buildStco,
  buildStss,
  buildCtts,
} from '../../mp4/src/box-builder.js';

/* ------------------------------ 单元级 ------------------------------ */

test('expandSampleTable：缺表（无 stco）抛 PARSE_ERROR', () => {
  assert.throws(
    () =>
      expandSampleTable({
        stsz: { defaultSize: 0, sizes: [10, 10], sampleCount: 2 },
        stts: { runs: [{ count: 2, delta: 1 }] },
        stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
      }),
    (e) => e.code === 'PARSE_ERROR' && /incomplete stbl/.test(e.message),
  );
});

test('expandSampleTable：无 stss 时全部样本视为关键帧', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [8, 8, 8, 8], sampleCount: 4 },
    stts: { runs: [{ count: 4, delta: 10 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [100, 200, 300, 400], isCo64: false },
  });
  assert.equal(samples.every((s) => s.keyframe === true), true);
  assert.deepEqual(samples.map((s) => s.dts), [0, 10, 20, 30]);
});

test('expandSampleTable：stts 游程短于样本数时沿用最后 delta 补齐', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1, 1, 1], sampleCount: 5 },
    stts: { runs: [{ count: 2, delta: 5 }] }, // 只覆盖前 2 个
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [10, 20, 30, 40, 50], isCo64: false },
  });
  assert.deepEqual(samples.map((s) => s.dts), [0, 5, 10, 15, 20]);
  assert.deepEqual(samples.map((s) => s.delta), [5, 5, 5, 5, 5]);
});

test('expandSampleTable：stsz defaultSize 模式（sizes=null）', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 24, sizes: null, sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 3, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [1000], isCo64: false },
  });
  assert.deepEqual(samples.map((s) => s.size), [24, 24, 24]);
  // 同一 chunk 内样本连续排布
  assert.deepEqual(samples.map((s) => s.offset), [1000, 1024, 1048]);
});

test('expandSampleTable：stsc 多样本一 chunk 且 firstChunk 单调继承', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [4, 4, 6, 6, 2], sampleCount: 5 },
    stts: { runs: [{ count: 5, delta: 1 }] },
    // chunk0: 2 样本；chunk1 起均为 2 样本（继承）→ 5 样本需 3 chunk
    stsc: {
      entries: [
        { firstChunk: 0, samplesPerChunk: 2, sampleDescriptionIndex: 1 },
        { firstChunk: 2, samplesPerChunk: 2, sampleDescriptionIndex: 1 },
      ],
    },
    stco: { offsets: [100, 200, 300], isCo64: false },
  });
  assert.deepEqual(samples.map((s) => s.offset), [100, 104, 200, 206, 300]);
});

test('expandSampleTable：stss 越界索引安全忽略', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1], sampleCount: 2 },
    stts: { runs: [{ count: 2, delta: 1 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [10, 20], isCo64: false },
    stss: { indices: [0, 99, -1] }, // 1-based 已减 1：0 合法，99 越界，-1 非法
  });
  assert.deepEqual(samples.map((s) => s.keyframe), [true, false]);
});

test('expandSampleTable：样本数超出 chunk 容量 → PARSE_ERROR', () => {
  assert.throws(
    () =>
      expandSampleTable({
        stsz: { defaultSize: 0, sizes: [1, 1, 1], sampleCount: 3 },
        stts: { runs: [{ count: 3, delta: 1 }] },
        stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
        stco: { offsets: [10, 20], isCo64: false }, // 容量只有 2
      }),
    (e) => e.code === 'PARSE_ERROR' && /inconsistent/.test(e.message),
  );
});

test('expandSampleTable：ctts v0 偏移写入 cts', () => {
  const { samples } = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [1, 1, 1], sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 40 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 1, sampleDescriptionIndex: 1 }] },
    stco: { offsets: [10, 20, 30], isCo64: false },
    ctts: { version: 0, runs: [{ count: 1, offset: 0 }, { count: 2, offset: 80 }] },
  });
  assert.deepEqual(samples.map((s) => s.dts + s.cts), [0, 120, 160]);
});

/* ------------------------------ 端到端（MovDemuxer） ------------------------------ */

/** co64：把 stco 内容改写为 u64 偏移并换类型名 */
function buildCo64(offsets) {
  const body = new Uint8Array(8 + offsets.length * 8);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0); // version/flags
  dv.setUint32(4, offsets.length);
  offsets.forEach((o, i) => dv.setBigUint64(8 + i * 8, BigInt(o)));
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set([0x63, 0x6f, 0x36, 0x34], 4); // 'co64'
  out.set(body, 8);
  return out;
}

/** stsz 定长模式：原缺陷（defaultSize≠0 时 sample_count 恒写 0）已在第八十八波修复，改用 buildStsz 直造 */
function buildConstSizeStsz(size, count) {
  return buildStsz(new Array(count).fill(size), size);
}

/**
 * 最小 mov：视频单轨 4 样本、2 chunk（每 chunk 2 样本）、关键帧 #0/#2。
 * sizes 均为 SIZE，可用 stsz defaultSize 模式。
 */
function buildMinimalMov({ useCo64 = false, useDefaultSize = false, withCtts = false } = {}) {
  const SIZE = 40;
  const MOVIE_TS = 600;
  const videoTrackMeta = {
    id: 1,
    type: 'video',
    codecPrivate: null,
    sampleEntryType: 'avc1',
    timescale: MOVIE_TS,
    duration: 160,
    language: 'und',
    width: 64,
    height: 48,
  };
  // stsd 需要 avc1 entry；buildStsd 依据 track.type=video + codecPrivate
  const stsd = buildStsd({ ...videoTrackMeta, codecPrivate: null });

  const chunkPayload = (seed) => {
    const data = new Uint8Array(SIZE * 2);
    for (let i = 0; i < data.length; i++) data[i] = (seed + i) & 0xff;
    return data;
  };

  function buildMoov(chunkOffsets) {
    return box('moov', (w) => {
      w.writeRaw(buildMvhd({ timescale: MOVIE_TS, duration: 160, nextTrackId: 2 }));
      w.writeRaw(
        box('trak', (tw) => {
          tw.writeRaw(buildTkhd({ trackId: 1, duration: 160, isVideo: true, width: 64, height: 48 }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: MOVIE_TS, duration: 160 }));
              mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'v' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(buildVmhd());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(stsd);
                      sw.writeRaw(buildStts([{ count: 4, delta: 40 }]));
                      if (withCtts) sw.writeRaw(buildCtts([{ count: 1, offset: 0 }, { count: 3, offset: 40 }]));
                      sw.writeRaw(buildStss([0, 2]));
                      sw.writeRaw(buildStsc([{ firstChunk: 0, samplesPerChunk: 2 }]));
                      sw.writeRaw(useDefaultSize ? buildConstSizeStsz(SIZE, 4) : buildStsz([SIZE, SIZE, SIZE, SIZE]));
                      sw.writeRaw(useCo64 ? buildCo64(chunkOffsets) : buildStco(chunkOffsets));
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
  const probeMoov = buildMoov([0, 0]);
  const base = ftyp.byteLength + probeMoov.byteLength;
  const chunkOffsets = [base + 8, base + 8 + SIZE * 2];
  const moov = buildMoov(chunkOffsets);
  if (moov.byteLength !== probeMoov.byteLength) throw new Error('fixture moov size drift');
  const mdat = buildMdat([chunkPayload(1), chunkPayload(77)]);

  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  let off = 0;
  for (const part of [ftyp, moov, mdat]) {
    bytes.set(part, off);
    off += part.byteLength;
  }

  const payloads = [chunkPayload(1).subarray(0, SIZE), chunkPayload(1).subarray(SIZE),
    chunkPayload(77).subarray(0, SIZE), chunkPayload(77).subarray(SIZE)];
  return { bytes, chunkOffsets, payloads, movieTimescale: MOVIE_TS };
}

test('端到端：co64 64 位 chunk 偏移正确映射样本', async () => {
  const { bytes, chunkOffsets, payloads } = buildMinimalMov({ useCo64: true });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.map((s) => s.offset), [
    chunkOffsets[0], chunkOffsets[0] + 40, chunkOffsets[1], chunkOffsets[1] + 40,
  ]);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual([...samples[i].data], [...payloads[i]], `样本 #${i} 数据`);
  }
});

test('端到端：stsz defaultSize 模式 + stsc 两样本一 chunk', async () => {
  const { bytes, payloads } = buildMinimalMov({ useDefaultSize: true });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.map((s) => s.size), [40, 40, 40, 40]);
  assert.deepEqual(samples.map((s) => s.keyframe), [true, false, true, false]);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual([...samples[i].data], [...payloads[i]]);
  }
});

test('端到端：ctts B 帧偏移反映到 pts（timestamp ≠ dts）', async () => {
  const { bytes } = buildMinimalMov({ withCtts: true });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  // ctts: 样本0 offset=0，样本1..3 offset=40 ticks；pts 按 dts+cts 整体 ticks 换算 µs
  assert.equal(samples[0].timestamp, samples[0].dts);
  assert.equal(samples[1].timestamp, Math.round(((40 + 40) * 1e6) / 600));
  assert.equal(samples[3].timestamp, Math.round(((120 + 40) * 1e6) / 600));
});

test('端到端：seek 二分对齐最近关键帧（含目标早于首关键帧）', async () => {
  const { bytes } = buildMinimalMov({});
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();
  const toUs = (ticks) => Math.round((ticks * 1e6) / 600);
  // 关键帧 dts：0 与 80 ticks。目标 100 ticks → 落 80
  assert.deepEqual(await d.seek(toUs(100)), { actualTimestampUs: toUs(80) });
  // 目标早于首关键帧 → 首关键帧 0
  assert.deepEqual(await d.seek(toUs(10)), { actualTimestampUs: toUs(0) });
  // 目标超出末尾 → 最后一帧关键帧 80
  assert.deepEqual(await d.seek(toUs(500)), { actualTimestampUs: toUs(80) });
});
