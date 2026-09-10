/**
 * mp4/__tests__/mp4-muxer-roundtrip.test.js — muxer 产出 → demuxer 读回往返
 * ---------------------------------------------------------------------------
 * 最高价值测法：Fmp4Remuxer 产出的 init + media segments 拼成完整字节流，
 * 交给 Mp4Demuxer 以 fMP4 模式重新打开，逐样本比对原始契约 Sample。
 * 另覆盖音频轨 init segment（smhd/mp4a/esds）构造分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource } from '../../core/src/index.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { Fmp4Remuxer } from '../src/remuxer.js';
import { iterateBoxes, parseMoov } from '../src/box-parser.js';
import { buildProgressiveVideoFixture, makeAscFixture } from './fixtures.js';

function findBox(bytes, type) {
  let found = null;
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

function findIn(bytes, parentBox, type) {
  let found = null;
  iterateBoxes(bytes, parentBox.contentStart, parentBox.end, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

test('往返：progressive → remux → fMP4 demux 逐样本无损还原', async () => {
  const { bytes, videoPayloads, expectedSamples } = buildProgressiveVideoFixture();
  const src = new Mp4Demuxer(new MemoryDataSource(bytes));
  await src.open();
  const track = src.tracks[0];

  const original = [];
  for (;;) {
    const s = await src.readSample(track.id);
    if (s === null) break;
    original.push(s);
  }
  assert.equal(original.length, 8);

  // mux：按关键帧边界分两段（0-3、4-7）
  const remuxer = new Fmp4Remuxer();
  const init = remuxer.createInitSegment(track);
  const seg1 = remuxer.createMediaSegment(track, original.slice(0, 4));
  const seg2 = remuxer.createMediaSegment(track, original.slice(4));

  const stream = new Uint8Array(init.byteLength + seg1.data.byteLength + seg2.data.byteLength);
  let off = 0;
  for (const p of [init, seg1.data, seg2.data]) {
    stream.set(p, off);
    off += p.byteLength;
  }

  // demux 读回
  const rt = new Mp4Demuxer(new MemoryDataSource(stream));
  const info = await rt.open();
  assert.equal(info.container, 'mp4');
  assert.equal(info.tracks.length, 1);
  const rtTrack = info.tracks[0];
  assert.equal(rtTrack.codec, track.codec, 'codec 字符串经 stsd 往返保持');

  const readBack = [];
  for (;;) {
    const s = await rt.readSample(rtTrack.id);
    if (s === null) break;
    readBack.push(s);
  }
  assert.equal(readBack.length, 8);

  for (let i = 0; i < 8; i++) {
    const o = original[i];
    const r = readBack[i];
    const e = expectedSamples[i];
    assert.equal(r.trackId, o.trackId, `trackId #${i}`);
    assert.equal(r.index, i);
    assert.equal(r.dts, o.dts, `dts(µs) 往返 #${i}`);
    assert.equal(r.timestamp, o.timestamp, `pts(含 ctts) 往返 #${i}`);
    assert.equal(r.timestamp, e.pts * 1000, `pts 锚点 #${i}`);
    assert.equal(r.duration, o.duration, `duration 往返 #${i}`);
    assert.equal(r.size, o.size, `size 往返 #${i}`);
    assert.equal(r.keyframe, o.keyframe, `keyframe 往返 #${i}`);
    assert.equal(r.keyframe, e.keyframe, `keyframe 锚点 #${i}`);
    assert.equal(r.dataState, 'loaded');
    assert.deepEqual([...r.data], [...videoPayloads[i]], `payload 字节往返 #${i}`);
  }

  // 段级元数据：tfdt 基准 = 段首 dts；序号推进
  assert.equal(seg1.sequenceNumber, 0);
  assert.equal(seg2.sequenceNumber, 1);
  assert.equal(seg1.baseMediaDecodeTimeUs, expectedSamples[0].dts * 1000);
  assert.equal(seg2.baseMediaDecodeTimeUs, expectedSamples[4].dts * 1000);
  assert.equal(seg1.sampleCount, 4);
  assert.equal(seg2.durationUs, 4 * 40000);
});

test('往返后 seek：重构索引上对齐关键帧', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const src = new Mp4Demuxer(new MemoryDataSource(bytes));
  await src.open();
  const track = src.tracks[0];
  const original = [];
  for (;;) {
    const s = await src.readSample(track.id);
    if (s === null) break;
    original.push(s);
  }

  const remuxer = new Fmp4Remuxer();
  const init = remuxer.createInitSegment(track);
  const seg = remuxer.createMediaSegment(track, original);
  const stream = new Uint8Array(init.byteLength + seg.data.byteLength);
  stream.set(init, 0);
  stream.set(seg.data, init.byteLength);

  const rt = new Mp4Demuxer(new MemoryDataSource(stream));
  await rt.open();
  // 先建立分片索引，再 seek 到 210000µs → 命中 dts=160000 的关键帧
  for await (const _s of rt.samples(rtTrackId(rt))) void _s;
  const r = await rt.seek(210000);
  assert.deepEqual(r, { actualTimestampUs: 160000 });
});

function rtTrackId(demuxer) {
  return demuxer.tracks[0].id;
}

test('音频 init segment：smhd + mp4a(esds) 结构与 ASC 往返', async () => {
  const asc = makeAscFixture();
  const remuxer = new Fmp4Remuxer();
  const init = remuxer.createInitSegment({
    id: 2,
    type: 'audio',
    timescale: 44100,
    language: 'und',
    description: asc,
    sampleEntryType: 'mp4a',
    sampleRate: 44100,
    numberOfChannels: 2,
  });

  const types = [];
  iterateBoxes(init, 0, init.byteLength, (h) => {
    types.push(h.type);
    return true;
  });
  assert.deepEqual(types, ['ftyp', 'moov']);

  const moovBox = findBox(init, 'moov');
  const moov = parseMoov(init.subarray(moovBox.start, moovBox.end));
  assert.ok(moov.mvex, '音频 init 同样带 mvex（fMP4 标志）');
  assert.ok(moov.mvex.trexByTrack[2]);

  const trak = moov.traks[0];
  assert.equal(trak.sampleEntry.type, 'mp4a');
  assert.equal(trak.sampleEntry.channelCount, 2);
  assert.equal(trak.sampleEntry.sampleRate, 44100);
  assert.deepEqual([...trak.sampleEntry.esds.audioSpecificConfig], [...asc], 'ASC 无损写入 esds');

  // mdhd timescale 用轨原生时间基（44100），smhd 存在（minf 嵌套于 mdia）
  assert.equal(trak.mdhd.timescale, 44100);
  const trakBox = findIn(init, moovBox, 'trak');
  const mdia = findIn(init, trakBox, 'mdia');
  const minf = findIn(init, mdia, 'minf');
  assert.ok(findIn(init, minf, 'smhd'), '音频轨 minf 内应为 smhd');
});
