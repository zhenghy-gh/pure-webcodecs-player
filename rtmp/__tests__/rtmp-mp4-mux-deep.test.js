/**
 * Fmp4Remuxer 深度补测（正向管线深水区）。
 *
 * 既有 mp4-mux.test.js / rtmp-mp4-mux-extra.test.js / rtmp-mp4-mux-dual.test.js 已覆盖
 * 结构、双轨、跨片段 tfdt 与配置校验。本文件补其未精确到「样本条目级」与计数器/时基的
 * 分支：
 *   - trun 每个 sample 的 duration 计算（中间差 vs 末样本 fallback、video/audio 时基差异）；
 *   - trun 每个 sample 的 flags（关键帧 0x02000000 vs 非关键帧 0x01010000）；
 *   - dataOffset 严格等于 moof 大小（default-base-is-moof 语义）；
 *   - 双轨「一侧队列为空」时只产出一个 moof+mdat；
 *   - sequence / totalSamples 计数器（跨多次 buildFragment 累加）；
 *   - moov 时基接线（mvhd=1000、video mdhd=1000、audio mdhd=采样率）；
 *   - 负 dts 在 tfdt 处被 Math.max(0,*) 钳为 0。
 * 全部纯函数、零网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer } from '../src/mp4-mux.js';
import { makeAvcC } from '../../samples/gateway/src/index.js';

// ---- box 遍历工具（本地自含，与既有测试同源算法）----
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
function at(bytes, off, len) {
  return new DataView(bytes.buffer, bytes.byteOffset + off, len);
}

const ASC_44K_2CH = Uint8Array.from([0x12, 0x10]);
function videoSample(dtsUs, keyframe = false) {
  return { kind: 'video', data: Uint8Array.from([0, 0, 0, 5, 0x65, 1, 2, 3, 4]), dtsUs, ptsUs: dtsUs, keyframe, durationUs: 0 };
}
function audioSample(dtsUs) {
  return { kind: 'audio', data: Uint8Array.from([0x21, 0x10, 0x05]), dtsUs, ptsUs: dtsUs, keyframe: true, durationUs: 0 };
}
const KF = 0x02000000;
const NON_KF = 0x01010000;

/** 解析 traf 内 trun：每个 sample 的 duration/size/flags + 头字段 */
function readTrun(fragOrMoof) {
  let moofScope = findBox(fragOrMoof, 'moof') ? enter(fragOrMoof, 'moof') : fragOrMoof;
  const traf = enter(moofScope, 'traf');
  const trun = findBox(traf, 'trun');
  const dv = at(traf, trun.start, trun.size);
  const count = dv.getUint32(12);
  const dataOffset = dv.getInt32(16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      duration: dv.getUint32(20 + 12 * i),
      size: dv.getUint32(24 + 12 * i),
      flags: dv.getUint32(28 + 12 * i),
    });
  }
  return { count, dataOffset, declaredSize: trun.size, entries };
}
/** traf 内 tfdt 的 baseMediaDecodeTime（v0，32 位） */
function readTfdt(trafScope) {
  const tfdt = findBox(trafScope, 'tfdt');
  return at(trafScope, tfdt.start, 16).getUint32(12);
}
/** moof 内 mfhd 的 sequence_number（fullbox 头 8B + version/flags 4B 后） */
function readMfhdSeq(fragOrMoof) {
  const moofScope = findBox(fragOrMoof, 'moof') ? enter(fragOrMoof, 'moof') : fragOrMoof;
  const mfhd = findBox(moofScope, 'mfhd');
  return at(moofScope, mfhd.start, 16).getUint32(12);
}

// ------------------------------------------------------------------- tests

test('trun：每 sample 的 duration（中间差=相邻 dts 差，末样本=fallback）与 flags（关键帧/非关键帧）', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  // 视频 timescale=1000；dts 0,33000,66000 µs
  r.addSample(videoSample(0, true));
  r.addSample(videoSample(33_000, false));
  r.addSample(videoSample(66_000, false));
  const frag = r.buildFragment();
  const trun = readTrun(frag);

  assert.equal(trun.count, 3);
  // 中间样本：相邻 dts 差 = 33000µs → 33 ticks；末样本：fallback 66_000µs → 66 ticks
  assert.deepEqual(trun.entries.map((e) => e.duration), [33, 33, 66]);
  // 关键帧首样本 KF，其余 NON_KF
  assert.equal(trun.entries[0].flags, KF);
  assert.equal(trun.entries[1].flags, NON_KF);
  assert.equal(trun.entries[2].flags, NON_KF);
  // size 应等于各样本 NAL 长度
  assert.deepEqual(trun.entries.map((e) => e.size), [9, 9, 9]);
});

test('音频 trun：duration 按采样率时基换算（末样本 fallback=21.3ms）', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: ASC_44K_2CH, sampleRate: 44100, channels: 2 });
  // 音频 timescale=44100；dts 0,21300,42600 µs
  r.addSample(audioSample(0));
  r.addSample(audioSample(21_300));
  r.addSample(audioSample(42_600));
  const trun = readTrun(r.buildFragment());

  // 注意：源码 `toTicks` 对每个样本 dts 各自取整再相减（非对差值取整），
  // 故中间样本 duration 为 round(42600·44100/1e6)-round(21300·44100/1e6)=1879-939=940，
  // 末样本走 fallback 21.3ms → 939。以下为实际算法行为。
  assert.deepEqual(trun.entries.map((e) => e.duration), [939, 940, 939]);
  assert.ok(trun.entries.every((e) => e.flags === KF), '音频样本应标记为关键帧');
});

test('dataOffset 严格等于 moof 大小（default-base-is-moof）', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  for (const s of [videoSample(0, true), videoSample(33_000), videoSample(66_000)]) r.addSample(s);
  const frag = r.buildFragment();
  const moof = findBox(frag, 'moof');
  const trun = readTrun(frag);
  assert.equal(moof.size, trun.dataOffset, 'trun.dataOffset 应等于 moof 整体大小');
  assert.equal(trun.declaredSize, 56, 'trun size 字段与实际 trun 盒大小一致');
});

test('双轨「一侧队列为空」：只产出一个 moof+mdat，trackId 取对应轨', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.setAudioTrack({ description: ASC_44K_2CH, sampleRate: 44100, channels: 2 });

  const readTrackId = (frag) => {
    const traf = enter(frag, 'moof', 'traf');
    const tfhd = findBox(traf, 'tfhd');
    return new DataView(traf.buffer, traf.byteOffset + tfhd.start).getUint32(12);
  };

  // 仅视频入队 → 仅视频片段
  r.addSample(videoSample(0, true));
  let frag = r.buildFragment();
  assert.deepEqual(walkTop(frag).map((b) => b.type), ['moof', 'mdat']);
  assert.equal(readTrun(frag).entries.length, 1);
  assert.equal(readTrackId(frag), 1, '纯视频片段 trackId 应为 1');

  // 仅音频入队 → 仅音频片段
  r.addSample(audioSample(0));
  frag = r.buildFragment();
  assert.deepEqual(walkTop(frag).map((b) => b.type), ['moof', 'mdat']);
  assert.equal(readTrackId(frag), 2, '纯音频片段 trackId 应为 2');
});

test('sequence / totalSamples 计数器：跨多次 buildFragment 累加且队列清空', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });

  r.addSample(videoSample(0, true));
  r.addSample(videoSample(33_000));
  const f1 = r.buildFragment();
  assert.equal(readMfhdSeq(f1), 0, '首片段 sequence=0');
  assert.equal(r.pendingSamples, 0, 'buildFragment 应清空视频队列');
  assert.equal(r.totalSamples, 2, 'totalSamples 累加已打包样本数');

  r.addSample(videoSample(66_000, true));
  r.addSample(videoSample(99_000));
  const f2 = r.buildFragment();
  assert.equal(readMfhdSeq(f2), 1, '次片段 sequence=1');
  assert.equal(r.totalSamples, 4, 'totalSamples 跨片段继续累加');
  assert.equal(r.pendingSamples, 0);
});

test('moov 时基接线：mvhd=1000、video mdhd=1000、audio mdhd=采样率', () => {
  const SR = 48000;
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.setAudioTrack({ description: Uint8Array.from([0x11, 0x88]), sampleRate: SR, channels: 1 });
  const init = r.initSegment();

  const mvhd = enter(init, 'moov', 'mvhd');
  assert.equal(at(mvhd, 12, 4).getUint32(0), 1000, 'mvhd timescale=1000');

  const moovBytes = enter(init, 'moov');
  const traks = walkTop(moovBytes).filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);
  const vMdhd = enter(moovBytes, 'trak', 'mdia', 'mdhd');
  assert.equal(at(vMdhd, 12, 4).getUint32(0), 1000, 'video mdhd timescale=1000');
  // 第二个 trak 是音频（setVideoTrack 先、setAudioTrack 后）
  const audioTrak = traks[1];
  // Audio trak is present and carries the sample-rate timescale in its mdhd.
  const audioSlice = moovBytes.subarray(audioTrak.start, audioTrak.start + audioTrak.size);
  const mdhdPos = audioSlice.findIndex((v, i) => i + 4 < audioSlice.length
    && v === 0x6d && audioSlice[i + 1] === 0x64 && audioSlice[i + 2] === 0x68 && audioSlice[i + 3] === 0x64);
  assert.ok(mdhdPos >= 0, '音频 trak 应包含 mdhd');
  assert.equal(new DataView(audioSlice.buffer, audioSlice.byteOffset + mdhdPos + 16, 4).getUint32(0), SR, 'audio mdhd timescale=采样率');
});

test('负 dts：tfdt baseMediaDecodeTime 被 Math.max(0,*) 钳为 0', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.addSample(videoSample(-1000, true)); // 负 dts
  const frag = r.buildFragment();
  const traf = enter(frag, 'moof', 'traf');
  assert.equal(readTfdt(traf), 0, '负 dts 不应产生负 baseMediaDecodeTime');
});
