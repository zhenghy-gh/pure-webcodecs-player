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
import { iterateBoxes } from '../src/box-parser.js';
import {
  buildFtyp,
  buildMdat,
  buildMoov,
  buildMvhd,
  buildMvex,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildSmhd,
  buildDinf,
  buildStsd,
  buildMoofMdat,
  buildMfhd,
  buildTfdt,
  fullBox,
  box,
} from '../src/box-builder.js';
import { makeAvcCFixture, makeAscFixture } from './fixtures.js';

const TICK_US = 1000;

function buildFragmentedMultiTrackFixture() {
  const avcC = makeAvcCFixture();
  const asc = makeAscFixture();
  const ftyp = buildFtyp({ majorBrand: 'msfh', compatible: ['msfh', 'isom', 'iso2'] });
  const trackBoxes = [
    { id: 1, type: 'video', entry: { id: 1, type: 'video', sampleEntryType: 'avc1', codecPrivate: avcC, width: 320, height: 240, timescale: 1000, duration: 0, language: 'und' }, timescale: 1000 },
    { id: 2, type: 'audio', entry: { id: 2, type: 'audio', sampleEntryType: 'mp4a', codecPrivate: asc, channelCount: 2, sampleRate: 44100, timescale: 44100, duration: 0, language: 'und' }, timescale: 44100 },
  ];
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 1000, duration: 0, nextTrackId: 3 }));
    for (const t of trackBoxes) {
      w.writeRaw(box('trak', (tw) => {
        tw.writeRaw(buildTkhd({ trackId: t.id, duration: 0, isVideo: t.type === 'video', isAudio: t.type === 'audio', width: t.entry.width, height: t.entry.height }));
        tw.writeRaw(box('mdia', (mw) => {
          mw.writeRaw(buildMdhd({ timescale: t.timescale, duration: 0 }));
          mw.writeRaw(buildHdlr({ handlerType: t.type === 'video' ? 'vide' : 'soun', name: 'fragmented test' }));
          mw.writeRaw(box('minf', (iw) => {
            iw.writeRaw(t.type === 'video' ? buildVmhd() : buildSmhd());
            iw.writeRaw(buildDinf());
            iw.writeRaw(box('stbl', (sw) => sw.writeRaw(buildStsd(t.entry))));
          }));
        }));
      }));
    }
    w.writeRaw(buildMvex([1, 2], { 1: { defaultSampleDuration: 40 }, 2: { defaultSampleDuration: 1024 } }));
  });
  const videoData = [0x11, 0x12, 0x13].map((v) => Uint8Array.from([v, v + 1]));
  const audioData = [0x21, 0x22, 0x23].map((v) => Uint8Array.from([v, v + 1, v + 2]));
  const fragments = [];
  for (let i = 0; i < 3; i++) {
    fragments.push(buildMoofMdat({ sequenceNumber: i * 2, trackId: 1, baseMediaDecodeTime: i * 40, samples: [{ dts: i * 40, pts: i * 40, duration: 40, size: videoData[i].length, keyframe: i === 0, data: videoData[i] }] }).data);
    fragments.push(buildMoofMdat({ sequenceNumber: i * 2 + 1, trackId: 2, baseMediaDecodeTime: i * 1024, samples: [{ dts: i * 1024, pts: i * 1024, duration: 1024, size: audioData[i].length, keyframe: true, data: audioData[i] }] }).data);
  }
  const bytes = new Uint8Array(ftyp.length + moov.length + fragments.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const part of [ftyp, moov, ...fragments]) { bytes.set(part, offset); offset += part.length; }
  return { bytes, videoData, audioData };
}

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

function buildImplicitBaseMultiTrackFixture() {
  const { bytes: base } = buildFragmentedMultiTrackFixture();
  const firstMoof = (() => {
    let found;
    iterateBoxes(base, 0, base.byteLength, (header) => { if (!found && header.type === 'moof') found = header; });
    return found;
  })();
  const init = base.slice(0, firstMoof.start);
  const videoData = new Uint8Array([0xa1, 0xa2]);
  const audioData = new Uint8Array([0xb1, 0xb2, 0xb3]);
  const makeMoof = (videoOffset) => box('moof', (w) => {
    w.writeRaw(buildMfhd(1));
    w.writeRaw(box('traf', (tw) => {
      tw.writeRaw(fullBox('tfhd', 0, 0x020000, (fw) => fw.writeU32(1)));
      tw.writeRaw(buildTfdt(0));
      tw.writeRaw(fullBox('trun', 0, 0x000301, (rw) => {
        rw.writeU32(1); rw.writeI32(videoOffset); rw.writeU32(40); rw.writeU32(videoData.length);
      }));
    }));
    w.writeRaw(box('traf', (tw) => {
      // Implicit base for this traf is the end of the preceding traf's data.
      tw.writeRaw(fullBox('tfhd', 0, 0, (fw) => fw.writeU32(2)));
      tw.writeRaw(buildTfdt(0));
      tw.writeRaw(fullBox('trun', 0, 0x000300, (rw) => {
        rw.writeU32(1); rw.writeU32(1024); rw.writeU32(audioData.length);
      }));
    }));
  });
  const provisional = makeMoof(0);
  const moof = makeMoof(provisional.byteLength + 8);
  const mdat = buildMdat([videoData, audioData]);
  const bytes = new Uint8Array(init.byteLength + moof.byteLength + mdat.byteLength);
  bytes.set(init, 0); bytes.set(moof, init.byteLength); bytes.set(mdat, init.byteLength + moof.byteLength);
  return { bytes, videoData, audioData };
}

test('分片双轨交错读取：共享扫描保留未请求轨道与各 fragment 样本', async () => {
  const { bytes, videoData, audioData } = buildFragmentedMultiTrackFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  const v0 = await d.readSample(1);
  const a0 = await d.readSample(2);
  const audioRest = [];
  for (;;) { const sample = await d.readSample(2); if (!sample) break; audioRest.push(sample); }
  assert.deepEqual([...v0.data], [...videoData[0]]);
  assert.deepEqual([...a0.data], [...audioData[0]]);
  assert.equal(v0.index, 0);
  assert.equal(a0.index, 0);
  assert.deepEqual(audioRest.map((sample) => sample.index), [1, 2]);
  const videoRest = [];
  for (;;) { const sample = await d.readSample(1); if (!sample) break; videoRest.push(sample); }
  assert.deepEqual(videoRest.map((sample) => sample.index), [1, 2]);
  assert.deepEqual(videoRest.map((sample) => [...sample.data]), videoData.slice(1).map((data) => [...data]));
  await d.destroy();

  const concurrent = new Mp4Demuxer(new MemoryDataSource(bytes));
  await concurrent.open();
  const [firstVideo, firstAudio] = await Promise.all([concurrent.readSample(1), concurrent.readSample(2)]);
  assert.equal(firstVideo.index, 0);
  assert.equal(firstAudio.index, 0);
  const drain = async (trackId) => {
    const indices = [];
    for (;;) { const sample = await concurrent.readSample(trackId); if (!sample) break; indices.push(sample.index); }
    return indices;
  };
  const [videoIndices, audioIndices] = await Promise.all([drain(1), drain(2)]);
  assert.deepEqual(videoIndices, [1, 2]);
  assert.deepEqual(audioIndices, [1, 2]);
  await concurrent.destroy();
});

test('same-moof audio traf inherits media-data end from preceding video traf', async () => {
  const { bytes, videoData, audioData } = buildImplicitBaseMultiTrackFixture();
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  await demuxer.open();
  const video = await demuxer.readSample(1);
  const audio = await demuxer.readSample(2);
  assert.deepEqual([...video.data], [...videoData]);
  assert.deepEqual([...audio.data], [...audioData]);
  assert.equal(audio.offset, video.offset + video.size);
  await demuxer.destroy();
});

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
