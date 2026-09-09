/**
 * FLV 解析器单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvParser } from '../src/flv-parser.js';
import { parseAvcConfig, parseHevcConfig } from '../src/codec-info.js';
import { buildAvcCodecString, buildHevcCodecString } from '../../core/src/index.js';

import {
  flvHeader, tag, scriptTag, aacSequenceTag, aacRawTag, mp3RawTag,
  avcSequenceTag, avcVideoTag, hevcEnhancedSequenceTag, hevcEnhancedVideoTag,
  buildAvcC, buildHvcC, defaultH264Sps, defaultH264Pps, assembleFlv, toAvcc,
} from './fixtures/build-flv.mjs';

function fakeHevcNalu(type) {
  const b = new Uint8Array(12);
  b[0] = (type << 1) & 0x7e;
  b[1] = 0x01;
  for (let i = 2; i < 12; i++) b[i] = 0x33 ^ i;
  return b;
}

function collect(parser) {
  const log = { header: [], metadata: [], audio: [], video: [], errors: [], complete: [] };
  parser.on('header', (h) => log.header.push(h));
  parser.on('metadata', (m) => log.metadata.push(m));
  parser.on('audio', (a) => log.audio.push(a));
  parser.on('video', (v) => log.video.push(v));
  parser.on('error', (e) => log.errors.push(e));
  parser.on('complete', (c) => log.complete.push(c));
  return log;
}

test('header：魔数探测与音视频标志', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(flvHeader({ hasAudio: true, hasVideo: true }));
  assert.equal(log.header.length, 1);
  assert.deepEqual(log.header[0], { hasAudio: true, hasVideo: true });
  assert.equal(FlvParser.probe(new Uint8Array([0x46, 0x4c, 0x56, 1])), true);
  assert.equal(FlvParser.probe(new Uint8Array([0, 1, 2])), false);
});

test('非 FLV 数据触发 error', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(new Uint8Array(64).fill(7));
  assert.ok(log.errors.length > 0);
});

test('onMetaData 解析', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(flvHeader({ hasAudio: false, hasVideo: false }));
  p.push(scriptTag({
    duration: 66.5, width: 1280, height: 720,
    videocodecid: 7, audiocodecid: 10, framerate: 25,
  }));
  p.flush();
  assert.equal(log.metadata.length, 1);
  assert.equal(log.metadata[0].duration, 66.5);
  assert.equal(log.metadata[0].width, 1280);
});

test('AVC 序列头与视频帧', () => {
  const p = new FlvParser();
  const log = collect(p);
  const avcC = buildAvcC(defaultH264Sps(), defaultH264Pps());
  p.push(flvHeader({}));
  p.push(avcSequenceTag(avcC, 0));
  p.push(avcVideoTag(true, toAvcc([new Uint8Array([0x65, 1, 2, 3])]), 100));
  p.push(avcVideoTag(false, toAvcc([new Uint8Array([0x41, 9])]), 133, -5));

  assert.equal(log.video.length, 3);
  const [seq, keyframe, inter] = log.video;
  assert.equal(seq.packetType, 'config');
  assert.deepEqual([...seq.configBytes.subarray(0, 4)], [...avcC.subarray(0, 4)]);

  assert.equal(keyframe.keyframe, true);
  assert.equal(keyframe.packetType, 'coded');
  assert.equal(keyframe.ctsMs, 0);
  assert.equal(keyframe.timestamp, 100);

  assert.equal(inter.keyframe, false);
  assert.equal(inter.ctsMs, -5);

  // 从序列头解析出分辨率与 codec string
  const info = parseAvcConfig(seq.configBytes);
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
  assert.match(buildAvcCodecString(seq.configBytes), /^avc1\.[0-9A-F]{6}$/);
});

test('Enhanced-FLV HEVC（FourCC hvc1）', () => {
  const p = new FlvParser();
  const log = collect(p);
  const vps = fakeHevcNalu(32);
  const sps = fakeHevcNalu(33);
  const pps = fakeHevcNalu(34);
  const hvcC = buildHvcC(vps, sps, pps);

  p.push(flvHeader({}));
  p.push(hevcEnhancedSequenceTag(hvcC, 0));
  p.push(hevcEnhancedVideoTag(false, toAvcc([fakeHevcNalu(1)]), 40, 2));

  assert.equal(log.video.length, 2);
  const [seq, frame] = log.video;
  assert.equal(seq.enhanced, true);
  assert.equal(seq.codecFamily, 'hevc');
  const info = parseHevcConfig(seq.configBytes);
  assert.equal(info.spsList.length, 1);
  assert.equal(info.naluLengthSize, 4);
  assert.match(buildHevcCodecString(seq.configBytes), /^hvc1\.1\.[0-9A-F]+\.L93$/);

  assert.equal(frame.enhanced, true);
  assert.equal(frame.ctsMs, 2);
  assert.equal(frame.keyframe, false);
});

test('AAC 音频：配置帧 + 裸帧', () => {
  const p = new FlvParser();
  const log = collect(p);
  const asc = Uint8Array.from([0x12, 0x10]);   // AOT=2 LC, 44.1k, 双声道
  p.push(flvHeader({ hasVideo: false }));
  p.push(aacSequenceTag(asc, 0));
  p.push(aacRawTag(new Uint8Array(16).fill(9), 23));

  assert.equal(log.audio.length, 2);
  assert.equal(log.audio[0].packetType, 'config');
  assert.deepEqual([...log.audio[0].asc], [...asc]);
  assert.equal(log.audio[1].packetType, 'raw');
  assert.equal(log.audio[1].data.length, 16);
});

test('MP3 音频直通', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(flvHeader({ hasVideo: false }));
  p.push(mp3RawTag(new Uint8Array(24), 0));
  assert.equal(log.audio.length, 1);
  assert.equal(log.audio[0].soundFormat, 'mp3');
});

test('流式分片等价：整块 vs 逐字节', () => {
  const file = assembleFlv({
    metadata: { duration: 0.3 },
    video: { frames: 6 },
    audio: { count: 8 },
  });

  const run = (chunker) => {
    const p = new FlvParser();
    const log = collect(p);
    for (const chunk of chunker(file)) p.push(chunk);
    p.flush();
    return log;
  };

  const whole = run(function* (f) { yield f; });
  const byteWise = run(function* (f) {
    for (let i = 0; i < f.length; i++) yield f.subarray(i, i + 1);
  });
  const oddChunks = run(function* (f) {
    let off = 0;
    while (off < f.length) {
      const n = Math.min(13 + (off % 29), f.length - off);
      yield f.subarray(off, off + n);
      off += n;
    }
  });

  const slim = (log) => ({
    header: log.header,
    metaCount: log.metadata.length,
    video: log.video.map((v) => ({ k: v.keyframe ? 1 : 0, pt: v.packetType, cts: v.ctsMs, ts: v.timestamp })),
    audio: log.audio.map((a) => ({ pt: a.packetType, len: a.data?.length ?? a.asc?.length, ts: a.timestamp })),
    complete: log.complete.length,
  });

  assert.deepEqual(slim(byteWise), slim(whole));
  assert.deepEqual(slim(oddChunks), slim(whole));
});

test('截断的尾部 Tag 不产生半包事件', () => {
  const file = assembleFlv({ video: { frames: 4 } });
  const cut = file.subarray(0, file.length - 20);   // 掐掉最后一个 Tag 的尾巴
  const p = new FlvParser();
  const log = collect(p);
  p.push(cut);
  p.flush();
  const frames = log.video.filter((v) => v.packetType === 'coded');
  assert.ok(frames.length >= 3 && frames.length <= 4);
});
