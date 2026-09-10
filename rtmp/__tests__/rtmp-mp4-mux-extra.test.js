/**
 * Fmp4Remuxer 补充测试：此前 mp4-mux.test.js 只覆盖「视频轨」与「视频+音频」配置。
 * 本文件聚焦其未覆盖分支：纯音频轨（audio-only）、轨道校验抛错、未配置即 initSegment、
 * 状态 getter、addSample 跨类型丢弃、pts≠dts 告警一次。纯函数、零网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer } from '../src/mp4-mux.js';
import { makeAvcC } from '../../samples/gateway/src/index.js';

// ---- 最小 box 遍历（与 mp4-mux.test.js 同源算法，但本地自含）----
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
/** 沿路径进入容器载荷（每步跳过 8B box 头，可加 skip）*/
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

const ASC_44100_2CH = Uint8Array.from([0x12, 0x10]);

function audioSample(dtsUs = 1000, ptsUs = 1000) {
  return { kind: 'audio', data: Uint8Array.from([0x21, 0x10, 0x05]), dtsUs, ptsUs, keyframe: true, durationUs: 0 };
}
function videoSample(dtsUs = 1000, ptsUs = 1000) {
  return { kind: 'video', data: Uint8Array.from([0, 0, 0, 3, 0x65, 1, 2]), dtsUs, ptsUs, keyframe: true, durationUs: 0 };
}

test('setVideoTrack 缺 description → STATE_ERROR', () => {
  const r = new Fmp4Remuxer();
  assert.throws(
    () => r.setVideoTrack({ width: 16 }),
    (e) => e.code === 'STATE_ERROR' && /description/.test(e.message),
  );
});

test('setAudioTrack 缺 description / sampleRate → STATE_ERROR', () => {
  const r = new Fmp4Remuxer();
  assert.throws(
    () => r.setAudioTrack({ sampleRate: 44100 }),
    (e) => e.code === 'STATE_ERROR' && /description/.test(e.message),
  );
  assert.throws(
    () => r.setAudioTrack({ description: ASC_44100_2CH }),
    (e) => e.code === 'STATE_ERROR' && /采样率/.test(e.message),
  );
});

test('initSegment 未配置任何轨道 → STATE_ERROR', () => {
  const r = new Fmp4Remuxer();
  assert.throws(
    () => r.initSegment(),
    (e) => e.code === 'STATE_ERROR' && /尚未设置/.test(e.message),
  );
});

test('纯音频轨：initSegment 仅含一个 trak（audio id=1）且内嵌 esds', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });
  const init = r.initSegment();
  assert.deepEqual(walkTop(init).map((b) => b.type), ['ftyp', 'moov']);
  const traks = walkTop(enter(init, 'moov')).filter((b) => b.type === 'trak');
  assert.equal(traks.length, 1, '纯音频应只有 1 个 trak');
  assert.ok(findBox(enter(init, 'moov', 'trak', 'mdia', 'minf', 'stbl', { type: 'stsd', skip: 8 }, { type: 'mp4a', skip: 28 }), 'esds'), 'mp4a 应含 esds');
});

test('纯音频轨：buildFragment 的 tfhd trackId=1（无视频时不复用 2）', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });
  r.addSample(audioSample());
  const frag = r.buildFragment();
  const traf = enter(frag, 'moof', 'traf');
  assert.ok(traf, '应有 traf');
  // tfhd 是 traf 内第一个 box：fullbox 头 8B + flags 4B + u32(trackId)@12
  const tfhd = findBox(traf, 'tfhd');
  const trackId = new DataView(traf.buffer, traf.byteOffset + tfhd.start).getUint32(12);
  assert.equal(trackId, 1, '纯音频轨 id 应为 1');
});

test('hasVideo / hasAudio / pendingSamples getter 反映配置与队列', () => {
  const r = new Fmp4Remuxer();
  assert.equal(r.hasVideo, false);
  assert.equal(r.hasAudio, false);
  assert.equal(r.pendingSamples, 0);

  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  assert.equal(r.hasVideo, true);
  assert.equal(r.hasAudio, false);

  r.addSample(videoSample());
  assert.equal(r.pendingSamples, 1);
});

test('addSample 跨类型丢弃：仅配置视频时不缓存音频样本', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  r.addSample(audioSample());
  assert.equal(r.pendingSamples, 0, '未配置音频轨时音频样本应被丢弃');

  const r2 = new Fmp4Remuxer();
  r2.setAudioTrack({ description: ASC_44100_2CH, sampleRate: 44100, channels: 2 });
  r2.addSample(videoSample());
  assert.equal(r2.pendingSamples, 0, '未配置视频轨时视频样本应被丢弃');
});

test('pts≠dts（疑似 B 帧）→ 仅告警一次', () => {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a);
  try {
    r.addSample(videoSample(0, 5000)); // pts-dts=5000µs > 1000
    r.addSample(videoSample(0, 5000)); // 第二次不应再告警
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, 'pts≠dts 告警应只触发一次');
  assert.ok(/B 帧/.test(String(warns[0]?.[0] ?? '')), '告警应提及 B 帧');
});
