/**
 * mp4/__tests__/mp4-demuxer-seek-cursor.test.js — seek 边界、样本表游程与退化文件
 * ---------------------------------------------------------------------------
 * 覆盖此前未测分支：
 *  1. expandSampleTable 的 stsc 多游程反向查找、stts 多游程 dts 累积、
 *     stts 游程短于样本数的容错补齐、样本表不一致抛错（demuxer.js 内部分支）；
 *  2. 退化文件：单样本文件、零时长文件的正向路径；
 *  3. seek 边界：精确命中关键帧、越过最后关键帧、seek(0)；
 *  4. seek 后 readSample 的当前实现行为记录（游标未重置，疑似缺陷，见文件内注释）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource } from '../../core/src/index.js';
import { Mp4Demuxer, expandSampleTable } from '../src/demuxer.js';
import {
  buildFtyp,
  buildMdat,
  buildMoov,
} from '../src/box-builder.js';
import { buildProgressiveVideoFixture } from './fixtures.js';

const TICK_US = 1000;

/* ============================ expandSampleTable 游程 ============================ */

test('expandSampleTable：stsc 多游程反向查找（每 chunk 样本数递变）', () => {
  // chunk0:1 样本、chunk1-2:2 样本、chunk3+:3 样本 → 5 chunk 共 1+2+2+3=8 样本
  const sizes = [10, 20, 20, 30, 30, 30, 40, 40];
  const chunkStarts = [1000, 1100, 1140, 1220];
  const table = expandSampleTable({
    stsz: { defaultSize: 0, sizes, sampleCount: 8 },
    stts: { runs: [{ count: 8, delta: 33 }] },
    stsc: {
      entries: [
        { firstChunk: 0, samplesPerChunk: 1 },
        { firstChunk: 1, samplesPerChunk: 2 },
        { firstChunk: 3, samplesPerChunk: 3 },
      ],
    },
    stco: { offsets: chunkStarts },
  });

  const s = table.samples;
  // chunk0 → 样本 0
  assert.equal(s[0].offset, 1000);
  // chunk1 → 样本 1/2 连续
  assert.equal(s[1].offset, 1100);
  assert.equal(s[2].offset, 1120);
  // chunk2 → 样本 3/4
  assert.equal(s[3].offset, 1140);
  assert.equal(s[4].offset, 1170);
  // chunk3 → 样本 5/6/7
  assert.equal(s[5].offset, 1220);
  assert.equal(s[6].offset, 1250);
  assert.equal(s[7].offset, 1290);
  // 反向查找语义：chunk2 命中 firstChunk=1 的游程（而非更早的）
  assert.equal(s[4].size, 30);
  assert.equal(s[7].size, 40);
});

test('expandSampleTable：stts 多游程 dts 累积 + 游程短于样本数容错补齐', () => {
  const table = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [4, 4, 4, 4], sampleCount: 4 },
    // 游程只覆盖前 3 个样本，第 4 个沿用最后 delta=120 容错补齐
    stts: { runs: [{ count: 2, delta: 50 }, { count: 1, delta: 120 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 4 }] },
    stco: { offsets: [900] },
  });
  const dts = table.samples.map((s) => s.dts);
  assert.deepEqual(dts, [0, 50, 100, 220], 'dts 逐游程累积，尾样本补齐');
  assert.equal(table.samples[3].delta, 120, '补齐样本 delta = 最后游程 delta');
  assert.equal(table.samples[3].offset, 912);
});

test('expandSampleTable：stts 游程总量超出样本数时按样本数截断', () => {
  const table = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [4, 4], sampleCount: 2 },
    stts: { runs: [{ count: 5, delta: 25 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 2 }] },
    stco: { offsets: [700] },
  });
  assert.equal(table.samples.length, 2);
  assert.deepEqual(table.samples.map((s) => s.dts), [0, 25]);
});

test('expandSampleTable：样本表不一致（chunk 容量不足）抛 PARSE_ERROR', () => {
  assert.throws(
    () =>
      expandSampleTable({
        stsz: { defaultSize: 0, sizes: [4, 4, 4], sampleCount: 3 },
        stts: { runs: [{ count: 3, delta: 10 }] },
        stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 2 }] },
        stco: { offsets: [100] }, // 1 chunk × 2 样本 < 3 样本
      }),
    (e) => e.code === 'PARSE_ERROR' && /inconsistent/.test(e.message),
  );
});

/* ============================ 退化文件 ============================ */

/** 单样本文件：ftyp + moov(1 轨 1 样本) + mdat */
function buildSingleSampleFixture({ duration = 40 } = {}) {
  const sizes = [64];
  const payloads = [new Uint8Array(64).fill(0xab)];
  const spec = {
    timescale: 1000,
    duration,
    tracks: [
      {
        track: {
          id: 1,
          type: 'video',
          codecPrivate: new Uint8Array([1, 66, 0, 30, 255, 225, 0, 9, 103, 66, 0, 30, 172, 216, 160, 9, 1]),
          sampleEntryType: 'avc1',
          timescale: 1000,
          duration,
          language: 'und',
          width: 32,
          height: 16,
        },
        sizes,
        keyframeIndices: [0],
        chunkOffsets: [0],
        samplesPerChunk: 1,
        sttsRuns: [{ count: 1, delta: 40 }],
      },
    ],
  };
  const ftyp = buildFtyp({ majorBrand: 'isom' });
  buildMoov(spec);
  const moovLen = buildMoov(spec).byteLength;
  spec.tracks[0].chunkOffsets = [ftyp.byteLength + moovLen + 8];
  const moov = buildMoov(spec);
  const mdat = buildMdat(payloads);
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  bytes.set(ftyp, 0);
  bytes.set(moov, ftyp.byteLength);
  bytes.set(mdat, ftyp.byteLength + moov.byteLength);
  return { bytes, payload: payloads[0] };
}

test('单样本文件：open → 恰好 1 个关键帧样本 → EOS', async () => {
  const { bytes, payload } = buildSingleSampleFixture({ duration: 40 });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.durationUs, 40 * TICK_US);
  assert.equal(info.tracks.length, 1);

  const s = await d.readSample(1);
  assert.equal(s.index, 0);
  assert.equal(s.keyframe, true, 'stss 单条目 → 关键帧');
  assert.equal(s.timestamp, 0);
  assert.equal(s.duration, 40 * TICK_US);
  assert.deepEqual([...s.data], [...payload]);

  assert.equal(await d.readSample(1), null, '第二个样本即 EOS');
  assert.equal(await d.readSample(1), null, 'EOS 幂等');
});

test('零时长文件：mvhd/mdhd duration=0 → durationUs 为 null，样本仍可读', async () => {
  const { bytes, payload } = buildSingleSampleFixture({ duration: 0 });
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.durationUs, null, 'durationUs > 0 判定 → 0 视为未知');
  assert.equal(info.tracks[0].durationUs, 0);

  const s = await d.readSample(1);
  assert.ok(s, '零时长不影响样本表展开');
  assert.deepEqual([...s.data], [...payload]);
});

/* ============================ seek 边界 ============================ */

test('seek 边界：精确关键帧 dts、越过末尾、seek(0)', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  // 关键帧 dts ∈ {0, 160} ticks；精确命中
  assert.deepEqual(await d.seek(160 * TICK_US), { actualTimestampUs: 160 * TICK_US });
  // 越过最后一个关键帧/媒体时长 → 落在最后关键帧
  assert.deepEqual(await d.seek(5_000_000), { actualTimestampUs: 160 * TICK_US });
  // 0 恰为首个关键帧
  assert.deepEqual(await d.seek(0), { actualTimestampUs: 0 });
});

/* ============================ seek 后游标行为（现状记录） ============================ */

test('seek 游标重定位：渐进模式从目标关键帧续读至 EOS', async () => {
  // core/src/demuxer.js seek() 契约：「子类 _doSeek 负责重定位内部游标」。
  // 渐进模式 seek(210ms)：关键帧 [0(dts0), 4(dts160)] 二分命中 index 4。
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  await d.seek(210 * TICK_US);
  const indices = [];
  for (;;) {
    const s = await d.readSample(1);
    if (!s) break;
    indices.push(s.index);
    if (s.index === 4) {
      assert.equal(s.dts, 160 * TICK_US, '落点应为 dts=160ms 的关键帧');
      assert.equal(s.keyframe, true);
    }
  }
  assert.deepEqual(indices, [4, 5, 6, 7], '应从关键帧 4 续读到 EOS，不重复不跳过');
  await d.destroy();
});

test('seek 游标重定位：分片模式完整消费后 seek，重放表内续读（不提前 EOS）', async () => {
  // 分片 fixture：6 样本（frag0 dts 0/40/80、frag1 dts 120/160/200），
  // 关键帧 index 0(dts0)/3(dts120)。完整消费后游标在文件尾，
  // seek(150ms) 应重放表内 index 3..5（非 EOS）。
  const { buildFragmentedFixture } = await import('./fixtures.js');
  const { bytes: fb } = buildFragmentedFixture();
  const d2 = new Mp4Demuxer(new MemoryDataSource(fb));
  await d2.open();
  for await (const _s of d2.samples(1)) void _s;
  await d2.seek(150 * TICK_US);
  const indices = [];
  for (;;) {
    const s = await d2.readSample(1);
    if (!s) break;
    indices.push(s.index);
    if (s.index === 3) {
      assert.equal(s.dts, 120 * TICK_US, '落点应为 dts=120ms 的关键帧');
      assert.equal(s.keyframe, true);
    }
  }
  assert.deepEqual(indices, [3, 4, 5], '重放段应产出关键帧 3..5，index 不重复');
  await d2.destroy();
});

test('seek 游标重定位：扫描中途 seek 回早期关键帧（重放段 + 接续扫描段）', async () => {
  // 只消费 2 个样本：生成器挂在 yield(index=1) 处，表内已解析 0..1，
  // frag0 的第 3 个样本（dts 80）尚未解析且游标已越过 frag0。
  // seek(50ms) 命中关键帧 0 → resumeIndex=0 → 重放 0..1，再扫 frag1（index 2..4）。
  // ⚠️ 语义限制（分片模式既定）：中断时所在 moof 内未解析的样本（dts 80）
  // 被跳过——游标只前进，找回它需回拨重扫+查重，会引入表膨胀与 index 重复。
  // 断言核心：重放段与扫描段 index 单调衔接、不重复、不提前 EOS。
  const { buildFragmentedFixture } = await import('./fixtures.js');
  const { bytes: fb } = buildFragmentedFixture();
  const d3 = new Mp4Demuxer(new MemoryDataSource(fb));
  await d3.open();
  assert.equal((await d3.readSample(1)).index, 0);
  assert.equal((await d3.readSample(1)).index, 1);
  await d3.seek(50 * TICK_US);
  const indices = [];
  const dtsList = [];
  for (;;) {
    const s = await d3.readSample(1);
    if (!s) break;
    indices.push(s.index);
    dtsList.push(s.dts);
  }
  assert.deepEqual(indices, [0, 1, 2, 3, 4], '重放段(0..1)应衔接扫描段(2..4)');
  assert.deepEqual(dtsList, [0, 40, 120, 160, 200].map((t) => t * TICK_US));
  await d3.destroy();
});

test('seek 游标重定位：seek(0) 与越过末关键帧不回归', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  const r0 = await d.seek(0);
  assert.equal(r0.actualTimestampUs, 0);
  assert.equal((await d.readSample(1)).index, 0, 'seek(0) 后从样本 0 续读');

  // 越过最后关键帧（160ms）：二分仍命中 4
  const rEnd = await d.seek(10_000 * TICK_US);
  assert.equal(rEnd.actualTimestampUs, 160 * TICK_US);
  const s = await d.readSample(1);
  assert.equal(s.index, 4);
  await d.destroy();
});
