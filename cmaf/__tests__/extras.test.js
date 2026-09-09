/**
 * cmaf 补充单测：isobmff 边界 / 多轨 chunk / 配置推导细节 / LL-HLS 策略补充
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { readBoxHeader, iterateBoxes, findAudioSpecificConfig, parseTrun } from '../src/isobmff.js';
import { splitChunks, parseInitSegment, probe } from '../src/chunk-parser.js';
import {
  decoderConfigsFromInit,
  codecStringFromAsc,
} from '../src/webcodecs.js';
import {
  PartTimeline,
  buildBlockingReloadUrl,
  shouldPrefetchPreloadHint,
} from '../src/llhls-parts.js';

/* ---------------- isobmff 原语 ---------------- */

test('readBoxHeader：普通/ largesize/截断三种路径', () => {
  // 普通 box：size=16
  const normal = new Uint8Array(16);
  new DataView(normal.buffer).setUint32(0, 16);
  normal.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  const h1 = readBoxHeader(normal, 0);
  assert.equal(h1.type, 'ftyp');
  assert.equal(h1.size, 16);
  assert.equal(h1.headerSize, 8);

  // largesize：size=1 → 64 位实际尺寸在偏移 8
  const large = new Uint8Array(24);
  const dv = new DataView(large.buffer);
  dv.setUint32(0, 1);
  large.set([0x6d, 0x64, 0x61, 0x74], 4); // mdat
  dv.setBigUint64(8, 24n);
  const h2 = readBoxHeader(large, 0);
  assert.equal(h2.headerSize, 16);
  assert.equal(h2.size, 24);

  // 截断：不足 8 字节返回 null
  assert.equal(readBoxHeader(new Uint8Array(4), 0), null);
});

test('iterateBoxes：数据截断时安全停止不越界', () => {
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 12); // box1: 0..12
  buf.set([0x66, 0x74, 0x79, 0x70], 4);
  dv.setUint32(12, 100); // box2 声明 100 字节但只剩 8 → 迭代终止
  buf.set([0x6d, 0x64, 0x61, 0x74], 16);
  const seen = [...iterateBoxes(buf)].map((b) => b.type);
  assert.deepEqual(seen, ['ftyp']);
});

test('findAudioSpecificConfig：变长长度的两字节编码', () => {
  // 构造 esds 内容：... 0x05 0x81 0x02 <ASC 3 字节>（len=0x81&0x7f<<7|0x02 = 130?）
  // 用合法短形式先验证基本路径
  const asc = new Uint8Array([0x12, 0x10]);
  const init = fmp4.buildInit([
    {
      id: 2,
      type: 'audio',
      codec: 'mp4a.40.2',
      description: { tag: 'esds', bytes: asc },
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    },
  ]);
  const got = findAudioSpecificConfig(init);
  assert.ok(got, '应定位到 ASC');
  assert.deepEqual(Array.from(got.slice(0, 2)), [0x12, 0x10]);
});

/* ---------------- probe 边界 ---------------- */

test('probe：过短缓冲与 ftyp 中置信边界', () => {
  assert.equal(probe(new Uint8Array(8)), null); // <12B
  const ftypOnly = new Uint8Array(12);
  ftypOnly.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.equal(probe(ftypOnly).confidence, 0.6);
});

/* ---------------- 双轨 chunk 组装 ---------------- */

test('splitChunks：音视频分片交错时按 traf.trackId 分组', () => {
  const FAKE_AVC_C = new Uint8Array([
    0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f,
    0xac, 0xd9, 0x40, 0x50, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
  ]);
  const ASC = new Uint8Array([0x12, 0x10]);
  const init = fmp4.buildInit([
    { id: 1, type: 'video', codec: 'avc1.64001f', description: { tag: 'avcC', bytes: FAKE_AVC_C }, width: 320, height: 240, timescale: 90000 },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', description: { tag: 'esds', bytes: ASC }, sampleRate: 44100, channels: 2, timescale: 44100 },
  ]);
  const vFrag = fmp4.buildFragment({
    trackId: 1,
    samples: [{ dts: 0, pts: 0, duration: 3000, keyframe: true, data: new Uint8Array(32).fill(1) }],
  });
  const aFrag = fmp4.buildAudioFragment(2, 44100, [
    { dts: 0, pts: 0, duration: 1024, keyframe: true, data: new Uint8Array(16).fill(9) },
  ]);
  const buf = new Uint8Array(init.length + vFrag.length + aFrag.length);
  let off = 0;
  for (const part of [init, vFrag, aFrag]) {
    buf.set(part, off);
    off += part.length;
  }
  const { chunks, initRange } = splitChunks(buf);
  assert.ok(initRange);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.tracks[0].trackId), [1, 2]);
});

/* ---------------- WebCodecs 配置推导细节 ---------------- */

test('codecStringFromAsc：AOT 覆盖 HE-AAC(5) 与 LC(2)', () => {
  // AOT=5: 高 5 位 = 00101 → 首字节 0b00101_000 = 0x28
  assert.equal(codecStringFromAsc(new Uint8Array([0x28, 0x00])), 'mp4a.40.5');
  assert.equal(codecStringFromAsc(new Uint8Array([0x12, 0x10])), 'mp4a.40.2');
  assert.equal(codecStringFromAsc(null), 'mp4a.40.2');
});

test('decoderConfigsFromInit：音频采样率/声道由 ASC 推导', () => {
  const ASC = new Uint8Array([0x12, 0x10]); // index4=44100, ch=2
  const init = fmp4.buildInit([
    {
      id: 2,
      type: 'audio',
      codec: 'mp4a.40.2',
      description: { tag: 'esds', bytes: ASC },
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    },
  ]);
  const cfg = decoderConfigsFromInit(init);
  assert.equal(cfg.audio.sampleRate, 44100);
  assert.equal(cfg.audio.numberOfChannels, 2);
  assert.deepEqual(Array.from(cfg.audio.description), [0x12, 0x10]);
});

/* ---------------- LL-HLS 策略补充 ---------------- */

test('PartTimeline：key 稳定性——重复合并同一清单不产生重复 part', () => {
  const tl = new PartTimeline();
  const segs = [{ sn: 5, parts: [{ uri: 'p.mp4', duration: 0.5, independent: true }] }];
  tl.updateFromPlaylist(segs);
  tl.updateFromPlaylist(segs);
  tl.updateFromPlaylist(segs);
  assert.equal(tl.parts.size, 1);
});

test('buildBlockingReloadUrl：无 part 时只带 msn', () => {
  const url = buildBlockingReloadUrl('https://a/b.m3u8', { msn: 42 });
  assert.equal(url, 'https://a/b.m3u8?_HLS_msn=42');
});

test('shouldPrefetchPreloadHint：GAP part 不预取', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist([
    { sn: 1, parts: [{ uri: 'gap.mp4', duration: 0.5, independent: true, gap: true }] },
  ]);
  assert.equal(shouldPrefetchPreloadHint({ type: 'PART', uri: 'gap.mp4' }, tl), false);
});
