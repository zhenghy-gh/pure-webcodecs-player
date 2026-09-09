import test from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import {
  buildProgressiveVideoFixture,
  buildFragmentedFixture,
} from './fixtures.js';

// fixture 时间基：timescale=1000 → 1 tick = 1000µs
const TICK_US = 1000;

test('probe：命中 ProbeResult，垃圾数据 null', () => {
  const { bytes } = buildProgressiveVideoFixture();
  const hit = Mp4Demuxer.probe(bytes.subarray(0, 64));
  assert.ok(hit && typeof hit.confidence === 'number' && hit.container === 'mp4');
  assert.ok(hit.confidence >= 0.8);
  assert.equal(Mp4Demuxer.probe(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
});

test('渐进 MP4：open() → MediaInfo 契约形状', async () => {
  const { bytes, avcC } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();

  assert.equal(d.state, 'ready');
  assert.equal(info.container, 'mp4');
  assert.equal(info.live, false);
  assert.equal(info.seekable, true);
  // mvhd duration 320 ticks @1000 → 320000µs
  assert.equal(info.durationUs, 320 * TICK_US);
  assert.equal(info.brands.majorBrand, 'isom');

  assert.equal(info.tracks.length, 1);
  const track = info.tracks[0];
  assert.equal(track.type, 'video');
  assert.equal(track.codec, 'avc1.42001E');
  assert.deepEqual([...track.description], [...avcC], 'description 定名字段');
  assert.deepEqual([...track.codecPrivate], [...avcC], '过渡别名同步可读');
  assert.equal(track.bitstreamFormat, 'avc');
  assert.equal(track.width, 320);
  assert.equal(track.height, 240);
  assert.equal(track.durationUs, 320 * TICK_US);
});

test('渐进 MP4：readSample/samples 契约 Sample（µs）', async () => {
  const { bytes, videoPayloads, expectedSamples } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  // readSample 是唯一 pull 通道，samples() 只是糖层——游标在同一轨上持续
  const s0 = await d.readSample(1);
  assert.equal(s0.trackId, 1);
  assert.equal(s0.codec, 'avc1.42001E');
  assert.equal(s0.timestamp, expectedSamples[0].pts * TICK_US, 'PTS µs');
  assert.equal(s0.dts, expectedSamples[0].dts * TICK_US, 'DTS µs 可选字段');
  assert.equal(s0.duration, expectedSamples[0].duration * TICK_US);
  assert.equal(s0.keyframe, true);
  assert.equal(s0.size, videoPayloads[0].length);
  assert.deepEqual([...s0.data], [...videoPayloads[0]]);
  assert.equal(s0.dataState, 'loaded');

  // 继续消费剩余 7 个
  const samples = [s0];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    samples.push(s);
  }
  assert.equal(samples.length, 8);
  for (let i = 0; i < 8; i++) {
    const s = samples[i];
    const e = expectedSamples[i];
    assert.equal(s.timestamp, e.pts * TICK_US, `pts(ctts) #${i}`);
    assert.equal(s.dts, e.dts * TICK_US, `dts #${i}`);
    assert.equal(s.size, e.size);
    assert.equal(s.offset, e.offset);
    assert.equal(s.keyframe, e.keyframe, `keyframe #${i}`);
    assert.equal(s.duration, 40 * TICK_US);
    assert.deepEqual([...s.data], [...videoPayloads[i]], `payload #${i}`);
  }

  // EOS 后 readSample 返回 null（已在上行循环耗尽）
});

test('lazySamples：data 缺省 + dataState=lazy，readSampleData 补取', async () => {
  const { bytes, videoPayloads } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes), { lazySamples: true });
  await d.open();

  const first = await d.readSample(1);
  assert.equal(first.dataState, 'lazy');
  assert.equal(first.data, undefined);

  const data = await d.readSampleData(first);
  assert.deepEqual([...data], [...videoPayloads[0]]);
});

test('seek(timestampUs) 返回 {actualTimestampUs} 且对齐关键帧', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  // t=210000µs（210 ticks）；关键帧 dts 0 与 160 ticks
  const r = await d.seek(210 * TICK_US);
  assert.deepEqual(r, { actualTimestampUs: 160 * TICK_US });

  // 早于首个关键帧 → 回退样本 0
  const r2 = await d.seek(TICK_US);
  assert.deepEqual(r2, { actualTimestampUs: 0 });
});

/* ------------------------------ 分片模式 ------------------------------ */

test('分片 MP4：fragmented 标记与跨片样本迭代（µs 连续性）', async () => {
  const { bytes, expectedSamples } = buildFragmentedFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();

  assert.equal(info.fragmented ?? undefined, undefined); // 契约外附加诊断不强制
  assert.equal(info.live, false);
  assert.equal(info.seekable, true);
  assert.equal(info.durationUs, null, 'mvex 无 mehd 时长未知 → null');

  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 6);

  for (let i = 0; i < 6; i++) {
    const s = samples[i];
    const e = expectedSamples[i];
    assert.equal(s.timestamp, e.dts * TICK_US, `frag pts #${i}`);
    assert.equal(s.dts, e.dts * TICK_US, `frag dts #${i}`);
    assert.equal(s.size, e.size);
    assert.equal(s.keyframe, e.keyframe, `frag keyframe #${i}`);
    assert.ok(s.data, `frag data #${i} 应已加载`);
    assert.deepEqual([...s.data], [...e.data], `frag payload #${i}`);
    // offset 必须落在文件范围内且能读回一致字节
    const raw = new Uint8Array(bytes.buffer, bytes.byteOffset + s.offset, s.size);
    assert.deepEqual([...raw], [...e.data]);
  }
});

test('分片 MP4：迭代建立索引后可 seek 到关键帧', async () => {
  const { bytes } = buildFragmentedFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes), { lazySamples: true });
  await d.open();
  for await (const _s of d.samples(1)) void _s;

  // 150000µs（150 ticks）；关键帧 dts 0/120 ticks → 命中第二片首样本
  const r = await d.seek(150 * TICK_US);
  assert.deepEqual(r, { actualTimestampUs: 120 * TICK_US });
});
