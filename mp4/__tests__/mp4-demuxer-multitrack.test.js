/**
 * mp4/__tests__/mp4-demuxer-multitrack.test.js — 渐进 MP4 双轨（视频+音频）正向路径
 * ---------------------------------------------------------------------------
 * 覆盖此前未测分支：
 *  1. 双轨 open：音频 mp4a/esds → codec 'mp4a.40.2'、sampleRate、numberOfChannels；
 *  2. 各轨独立游标：交错 readSample(trackA/trackB) 互不干扰、各自独立 EOS；
 *  3. 非交错 chunk 布局：视频 chunk 区在前、音频 chunk 区在后，stsc 每轨独立映射；
 *  4. 无 stss 音频轨 → expandSampleTable「全关键帧」约定在真实文件上生效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource, ticksToUs } from '../../core/src/index.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import {
  buildFtyp,
  buildMdat,
  buildMoov,
} from '../src/box-builder.js';
import { makeAvcCFixture, makeAscFixture } from './fixtures.js';

const TICK_US = 1000;

/** 双轨 fixture：视频 6 样本（3 chunk × 2）、音频 8 样本（2 chunk × 4），mda 区先视频后音频 */
function buildTwoTrackFixture() {
  const avcC = makeAvcCFixture();
  const asc = makeAscFixture();

  const videoSizes = [100, 60, 60, 80, 90, 60];
  const audioSizes = new Array(8).fill(180);

  const videoPayloads = videoSizes.map((size, i) => {
    const d = new Uint8Array(size);
    for (let j = 0; j < size; j++) d[j] = (i * 31 + j) & 0xff;
    return d;
  });
  const audioPayloads = audioSizes.map((size, i) => {
    const d = new Uint8Array(size);
    for (let j = 0; j < size; j++) d[j] = (i * 13 + j) & 0xff;
    return d;
  });

  const spec = {
    timescale: 1000,
    duration: 240, // 视频轨 6×40
    tracks: [
      {
        track: {
          id: 1,
          type: 'video',
          codecPrivate: avcC,
          sampleEntryType: 'avc1',
          timescale: 1000,
          duration: 240,
          language: 'und',
          width: 320,
          height: 240,
        },
        sizes: videoSizes,
        keyframeIndices: [0, 3],
        chunkOffsets: [0, 0, 0],
        samplesPerChunk: 2,
        sttsRuns: [{ count: 6, delta: 40 }],
      },
      {
        track: {
          id: 2,
          type: 'audio',
          codecPrivate: asc,
          sampleEntryType: 'mp4a',
          timescale: 44100,
          duration: 8 * 1024,
          language: 'und',
          channelCount: 2,
          sampleRate: 44100,
        },
        sizes: audioSizes,
        // 无 keyframeIndices → 不写 stss → 全关键帧
        chunkOffsets: [0, 0],
        samplesPerChunk: 4,
        sttsRuns: [{ count: 8, delta: 1024 }],
      },
    ],
  };

  const ftyp = buildFtyp({ majorBrand: 'isom', compatible: ['isom', 'iso2', 'avc1', 'mp41'] });
  buildMoov(spec); // 两遍构造：先定型 moov 字节长度
  let base = ftyp.byteLength + buildMoov(spec).byteLength;

  const chunkOffsets = [];
  let cursor = 0;
  // 视频 3 chunk（每 chunk 2 样本）
  for (let c = 0; c < 3; c++) {
    chunkOffsets.push(base + 8 + cursor);
    cursor += videoSizes[c * 2] + videoSizes[c * 2 + 1];
  }
  const videoChunkOffsets = chunkOffsets.slice();
  // 音频 2 chunk（每 chunk 4 样本），紧跟视频区之后 → 非交错布局
  for (let c = 0; c < 2; c++) {
    chunkOffsets.push(base + 8 + cursor);
    cursor += audioSizes[c * 4 - 0] * 4;
  }
  const audioChunkOffsets = chunkOffsets.slice(3);

  spec.tracks[0].chunkOffsets = videoChunkOffsets;
  spec.tracks[1].chunkOffsets = audioChunkOffsets;

  const moov = buildMoov(spec);
  const mdat = buildMdat([...videoPayloads, ...audioPayloads]);
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  bytes.set(ftyp, 0);
  bytes.set(moov, ftyp.byteLength);
  bytes.set(mdat, ftyp.byteLength + moov.byteLength);

  // 期望样本表
  const expectedVideo = [];
  for (let i = 0; i < 6; i++) {
    const c = Math.floor(i / 2);
    expectedVideo.push({
      index: i,
      dts: i * 40,
      duration: 40,
      size: videoSizes[i],
      keyframe: i === 0 || i === 3,
      offset: videoChunkOffsets[c] + (i % 2 === 1 ? videoSizes[i - 1] : 0),
      data: videoPayloads[i],
    });
  }
  const expectedAudio = [];
  for (let i = 0; i < 8; i++) {
    const c = Math.floor(i / 4);
    expectedAudio.push({
      index: i,
      dts: i * 1024, // ticks @44100
      duration: 1024,
      size: 180,
      keyframe: true, // 无 stss → 全关键帧
      offset: audioChunkOffsets[c] + (i % 4) * 180,
      data: audioPayloads[i],
    });
  }

  return { bytes, expectedVideo, expectedAudio, avcC, asc, videoChunkOffsets, audioChunkOffsets };
}

test('双轨 open：视频 avc1 + 音频 mp4a 契约字段各就各位', async () => {
  const { bytes, asc, videoChunkOffsets, audioChunkOffsets } = buildTwoTrackFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  const info = await d.open();

  assert.equal(info.container, 'mp4');
  assert.equal(info.durationUs, 240 * TICK_US);
  assert.equal(info.tracks.length, 2);

  const video = info.tracks.find((t) => t.type === 'video');
  const audio = info.tracks.find((t) => t.type === 'audio');
  assert.equal(video.id, 1);
  assert.equal(video.codec, 'avc1.42001E');
  assert.equal(video.width, 320);
  assert.equal(video.height, 240);

  assert.equal(audio.id, 2);
  assert.equal(audio.codec, 'mp4a.40.2', 'ASC 0x12 0x10 → AAC-LC');
  assert.deepEqual([...audio.description], [...asc], '音频 description = AudioSpecificConfig');
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.numberOfChannels, 2);
  assert.equal(audio.durationUs, ticksToUs(8192, 44100));
  assert.equal(audio.bitstreamFormat, undefined, '音频不设 bitstreamFormat');

  // 非交错布局：视频 chunk 全部在音频 chunk 之前
  assert.ok(
    Math.max(...videoChunkOffsets) < Math.min(...audioChunkOffsets),
    '视频 chunk 区应整体先于音频 chunk 区',
  );
});

test('音频轨遍历：全关键帧、44100 时间基 µs 换算、payload 精确', async () => {
  const { bytes, expectedAudio } = buildTwoTrackFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  const samples = [];
  for (;;) {
    const s = await d.readSample(2);
    if (s === null) break;
    samples.push(s);
  }
  assert.equal(samples.length, 8);

  for (let i = 0; i < 8; i++) {
    const s = samples[i];
    const e = expectedAudio[i];
    assert.equal(s.trackId, 2);
    assert.equal(s.index, i);
    assert.equal(s.dts, ticksToUs(e.dts, 44100), `audio dts #${i}`);
    assert.equal(s.timestamp, ticksToUs(e.dts, 44100), '无 ctts → pts == dts');
    assert.equal(s.duration, ticksToUs(1024, 44100));
    assert.equal(s.size, e.size);
    assert.equal(s.keyframe, true, `无 stss 音频轨样本 #${i} 应为关键帧`);
    assert.equal(s.offset, e.offset);
    assert.equal(s.dataState, 'loaded');
    assert.deepEqual([...s.data], [...e.data], `audio payload #${i}`);
  }
  // 首样本 µs 值手算锚点：round(1024e6/44100) = 23220
  assert.equal(samples[0].dts, 0);
  assert.equal(samples[1].dts, 23220);
});

test('双轨交错消费：游标互不干扰、各自独立 EOS', async () => {
  const { bytes, expectedVideo, expectedAudio } = buildTwoTrackFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  // 一比一交错拉取
  const vi = [];
  const ai = [];
  for (let n = 0; n < 8; n++) {
    const v = await d.readSample(1);
    if (v) vi.push(v);
    const a = await d.readSample(2);
    if (a) ai.push(a);
  }
  assert.equal(vi.length, 6, '视频先 EOS');
  assert.equal(ai.length, 8);
  assert.deepEqual([...vi[5].data], [...expectedVideo[5].data]);
  assert.deepEqual([...ai[7].data], [...expectedAudio[7].data]);

  // 视频 EOS 后音频仍可继续消费（游标独立）
  const a8 = await d.readSample(2);
  assert.equal(a8, null, '音频此时也已耗尽');

  // 视频 EOS 幂等：继续 readSample(1) 仍为 null
  assert.equal(await d.readSample(1), null);
});

test('视频轨遍历：chunk 内双样本偏移连续、keyframe [0,3]', async () => {
  const { bytes, expectedVideo, videoChunkOffsets } = buildTwoTrackFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();

  const samples = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    samples.push(s);
  }
  assert.equal(samples.length, 6);
  for (let i = 0; i < 6; i++) {
    const s = samples[i];
    const e = expectedVideo[i];
    assert.equal(s.timestamp, e.dts * TICK_US);
    assert.equal(s.keyframe, e.keyframe, `video keyframe #${i}`);
    assert.equal(s.offset, e.offset, `chunk 内偏移 #${i}`);
    assert.deepEqual([...s.data], [...e.data], `video payload #${i}`);
  }
  // chunk 级断言：样本 0/1 同 chunk（chunk0），2/3 同 chunk，4/5 同 chunk
  assert.equal(samples[0].offset, videoChunkOffsets[0]);
  assert.equal(samples[1].offset, videoChunkOffsets[0] + expectedVideo[0].size);
  assert.equal(samples[2].offset, videoChunkOffsets[1]);
  assert.equal(samples[4].offset, videoChunkOffsets[2]);
});
