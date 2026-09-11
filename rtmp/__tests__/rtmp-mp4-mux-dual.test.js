/**
 * Fmp4Remuxer 深度补测：双轨（视频 + 音频）buildFragment。
 *
 * 现有 mp4-mux.test.js 仅覆盖单视频轨与「视频+音频 init」；rtmp-mp4-mux-extra.test.js
 * 仅覆盖纯音频轨。本文件补齐「视频轨 + 音频轨同时存在时，一次 buildFragment 产出
 * 两个 moof+mdat 且 trackId 恒为 视频=1、音频=2」这一未被覆盖的路径，并精确校验
 * tfdt baseMediaDecodeTime 取「本片段首样本绝对 dts」的语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer } from '../src/mp4-mux.js';
import { makeAvcC } from '../../samples/gateway/src/index.js';

function walkTop(bytes) {
  const out = [];
  let off = 0;
  while (off + 8 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off);
    const size = dv.getUint32(0);
    if (size < 8 || off + size > bytes.length) break;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    out.push({ type, start: off, size });
    off += size;
  }
  return out;
}
function findBox(bytes, type) {
  return walkTop(bytes).find((b) => b.type === type) ?? null;
}
function enter(bytes, ...steps) {
  let scope = bytes;
  for (const step of steps) {
    const { type, skip = 0 } = typeof step === 'string' ? { type: step } : step;
    const hit = findBox(scope, type);
    if (!hit) return null;
    scope = scope.subarray(hit.start + 8 + skip, hit.start + hit.size);
  }
  return scope;
}
/** 读 traf 内 tfhd 的 trackId（fullbox 头 8B + flags 4B + u32(trackId)@12）与 tfdt 的 baseMediaDecodeTime */
function readTrafMeta(moofScope) {
  const traf = enter(moofScope, 'moof', 'traf');
  const tfhd = findBox(traf, 'tfhd');
  const tfdt = findBox(traf, 'tfdt');
  const dvTfhd = new DataView(traf.buffer, traf.byteOffset + tfhd.start);
  const trackId = dvTfhd.getUint32(12);
  const dvTfdt = new DataView(traf.buffer, traf.byteOffset + tfdt.start);
  const baseMediaDecodeTime = dvTfdt.getUint32(12); // v0：32 位
  return { trackId, baseMediaDecodeTime };
}

const ASC_44100_2CH = Uint8Array.from([0x12, 0x10]);

function videoSample(dtsUs, keyframe = false) {
  return { kind: 'video', data: Uint8Array.from([0, 0, 0, 5, 0x65, 1, 2, 3, 4]), dtsUs, ptsUs: dtsUs, keyframe, durationUs: 0 };
}
function audioSample(dtsUs) {
  return { kind: 'audio', data: Uint8Array.from([0x21, 0x10, 0x05]), dtsUs, ptsUs: dtsUs, keyframe: true, durationUs: 0 };
}

test('双轨 initSegment：含 2 个 trak（video id=1、audio id=2），mvex/trex 齐全', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });
  const init = r.initSegment();
  assert.deepEqual(walkTop(init).map((b) => b.type), ['ftyp', 'moov']);
  const moov = enter(init, 'moov');
  const traks = walkTop(moov).filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2, '视频+音频应产出 2 个 trak');
  assert.ok(findBox(moov, 'mvex'), 'moov 应含 mvex');
  // trex 嵌套于 mvex 内，应为 2 条（每轨一条），trackId 分别是 1 与 2
  const mvex = enter(init, 'moov', 'mvex');
  const trexs = walkTop(mvex).filter((b) => b.type === 'trex');
  assert.equal(trexs.length, 2, 'mvex 内应含 2 条 trex');
  const ids = trexs
    .map((b) => new DataView(mvex.buffer, mvex.byteOffset + b.start).getUint32(12))
    .sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2], 'trex trackId 应为 1 与 2');
});

test('buildFragment 双轨：一次产出 视频 moof+mdat 与 音频 moof+mdat，trackId 1/2', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });
  r.addSample(videoSample(0, true));
  r.addSample(videoSample(33_000));
  r.addSample(audioSample(0));
  r.addSample(audioSample(21_300));

  const frag = r.buildFragment();
  assert.deepEqual(
    walkTop(frag).map((b) => b.type),
    ['moof', 'mdat', 'moof', 'mdat'],
    '双轨应各产出一个 moof+mdat',
  );

  // 直接读第一段（从头到第一个 mdat 结束）与第二段
  const boxes = walkTop(frag);
  const m1End = boxes[1].start + boxes[1].size;
  const v = readTrafMeta(frag.subarray(0, m1End));
  const a = readTrafMeta(frag.subarray(m1End));
  assert.equal(v.trackId, 1, '视频片段 trackId 恒为 1');
  assert.equal(a.trackId, 2, '音频片段 trackId 恒为 2（存在视频时不复用 1）');
});

test('tfdt baseMediaDecodeTime 取本片段首样本绝对 dts（视频 timescale=1000）', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });

  // 第一段：视频首样本 dtsUs=0 → tfdt=0；音频首样本 dtsUs=0 → tfdt=0
  r.addSample(videoSample(0, true));
  r.addSample(audioSample(0));
  const frag1 = r.buildFragment();
  const b1 = walkTop(frag1);
  const v1 = readTrafMeta(frag1.subarray(0, b1[1].start + b1[1].size));
  const a1 = readTrafMeta(frag1.subarray(b1[1].start + b1[1].size));
  assert.equal(v1.baseMediaDecodeTime, 0, '首片段视频 tfdt=0（首样本 dts=0）');
  assert.equal(a1.baseMediaDecodeTime, 0, '首片段音频 tfdt=0');

  // 第二段：视频首样本 dtsUs=66_000（≈15fps 步长）→ tfdt=ticks(66000,1000)=66
  r.addSample(videoSample(66_000, true));
  r.addSample(videoSample(99_000));
  r.addSample(audioSample(21_300)); // 音频首样本 dtsUs=21300 → ticks(21300,44100)=939
  const frag2 = r.buildFragment();
  const b2 = walkTop(frag2);
  const v2 = readTrafMeta(frag2.subarray(0, b2[1].start + b2[1].size));
  const a2 = readTrafMeta(frag2.subarray(b2[1].start + b2[1].size));
  assert.equal(v2.baseMediaDecodeTime, 66, '第二段视频 tfdt 取绝对 dts 的 ticks（非累加）');
  assert.equal(a2.baseMediaDecodeTime, Math.round((21_300 * 44_100) / 1e6), '音频 tfdt 按采样率时基换算');
  assert.ok(v2.baseMediaDecodeTime > v1.baseMediaDecodeTime, '跨片段视频 tfdt 递增');
});
