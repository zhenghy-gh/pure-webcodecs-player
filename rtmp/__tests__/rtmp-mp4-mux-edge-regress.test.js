/**
 * rtmp-mp4-mux-edge-regress.test.js —— fMP4 remuxer 两项边缘缺陷的回归锁。
 *
 * 对应深测 rtmp-mp4-mux-deep.test.js 记录的两项边缘问题（根因已定位、已修源）：
 *   (1) 音频 sample duration 双舍入抖动：
 *       旧实现 `toTicks(next) - toTicks(cur)` 各自取整后再相减，44.1kHz 等时基下
 *       等间隔音频会算出 939/940/939；改为「对相邻 dts 之差单次取整」后恒为 939。
 *   (2) 负 dts 的 tfdt baseMediaDecodeTime 被 Math.max(0,*) 钳为 0：
 *       无符号 32 位字段应保留真实偏移（>>>0 回绕），与 flv fmp4-remuxer 既定约定一致；
 *       钳 0 会静默抹掉解码偏移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer } from '../src/mp4-mux.js';
import { makeAvcC } from '../../samples/gateway/src/index.js';

// ---- box 遍历工具（本地自含，与 rtmp-mp4-mux-deep.test.js 同源）----
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

function videoSample(dtsUs, keyframe = false) {
  return { kind: 'video', data: Uint8Array.from([0, 0, 0, 5, 0x65, 1, 2, 3, 4]), dtsUs, ptsUs: dtsUs, keyframe, durationUs: 0 };
}
function audioSample(dtsUs, durationUs = 0) {
  return { kind: 'audio', data: Uint8Array.from([0x21, 0x10, 0x05]), dtsUs, ptsUs: dtsUs, keyframe: true, durationUs };
}
const ASC_44K_2CH = Uint8Array.from([0x12, 0x10]);

/** 解析 trun：每个 sample 的 duration/size/flags + 头字段 */
function readTrun(fragOrMoof) {
  let moofScope = findBox(fragOrMoof, 'moof') ? enter(fragOrMoof, 'moof') : fragOrMoof;
  const traf = enter(moofScope, 'traf');
  const trun = findBox(traf, 'trun');
  const dv = at(traf, trun.start, trun.size);
  const count = dv.getUint32(12);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      duration: dv.getUint32(20 + 12 * i),
      size: dv.getUint32(24 + 12 * i),
      flags: dv.getUint32(28 + 12 * i),
    });
  }
  return { count, entries };
}
/** traf 内 tfdt 的 baseMediaDecodeTime（v0，32 位） */
function readTfdt(trafScope) {
  const tfdt = findBox(trafScope, 'tfdt');
  return at(trafScope, tfdt.start, 16).getUint32(12);
}

// ------------------------------------------------------------------- 回归

test('(回归-1) 音频等间隔样本 duration 严格一致：44.1kHz 下不再出现 939/940 抖动', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: ASC_44K_2CH, sampleRate: 44100, channels: 2 });
  r.addSample(audioSample(0));
  r.addSample(audioSample(21_300));
  r.addSample(audioSample(42_600));
  const trun = readTrun(r.buildFragment());

  // 旧实现：round(42600·44100/1e6)-round(21300·44100/1e6)=1879-939=940 → [939,940,939]
  // 修复后：对相邻 dts 差 (21300µs) 单次取整，三样本恒为 939。
  assert.deepEqual(trun.entries.map((e) => e.duration), [939, 939, 939]);
});

test('(回归-1) 音频时长由差值取整：48kHz AAC 帧（1024 样本≈21333µs）恒为 1024 ticks', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: ASC_44K_2CH, sampleRate: 48000, channels: 2 });
  const FRAME = 21_333; // 1024 样本 @ 48kHz ≈ 21333.33µs
  r.addSample(audioSample(0, FRAME));
  r.addSample(audioSample(FRAME, FRAME));
  r.addSample(audioSample(FRAME * 2, FRAME));
  const trun = readTrun(r.buildFragment());
  assert.deepEqual(trun.entries.map((e) => e.duration), [1024, 1024, 1024]);
});

test('(回归-1) 视频相邻 dts 差取整：时序与时基无关路径不受影响', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.addSample(videoSample(0, true));
  r.addSample(videoSample(33_000));
  r.addSample(videoSample(66_000));
  const trun = readTrun(r.buildFragment());
  assert.deepEqual(trun.entries.map((e) => e.duration), [33, 33, 66]);
});

test('(回归-2) 负 dts 的 tfdt 经 >>>0 无符号回绕为 0xFFFFFFFF（不钳为 0）', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.addSample(videoSample(-1000, true)); // dts=-1000µs → timescale=1000 → -1 tick
  const frag = r.buildFragment();
  const traf = enter(frag, 'moof', 'traf');
  assert.equal(readTfdt(traf), (-1) >>> 0, '负 dts 保留真实偏移（0xFFFFFFFF）而非钳 0');
});

test('(回归-2) 非负 dts 的 tfdt 与旧行为一致（回绕分支对合法输入无副作用）', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.addSample(videoSample(0, true));
  r.addSample(videoSample(66_000));
  const frag = r.buildFragment();
  const traf = enter(frag, 'moof', 'traf');
  assert.equal(readTfdt(traf), 0, '首样本 dts=0 → tfdt=0');
});
