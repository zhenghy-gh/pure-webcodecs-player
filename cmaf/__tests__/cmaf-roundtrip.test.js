/**
 * cmaf 往返单测：hls fMP4 muxer 产段 → cmaf chunk-parser 读回，逐字段断言
 *
 * 与既有 fragment 测试的差异：这里锁的是"时间线语义"而非 box 结构——
 *  - dtsOffset 按 durationTicks 跨样本累计、跨 chunk 接续；
 *  - cts（pts-dts）经 trun v1 有符号往返，含 B 帧负偏移；
 *  - keyframe 标志位（0x02000000 / 0x01010000）经 isKeyframeFlag 往返；
 *  - 音频轨（trun v0 无 cts）cts 恒 0；
 *  - chunk 内相邻样本 dataStart 间距 == 前一样本 size（自洽性，
 *    不锁绝对地址——受 chunk-parser.js:149 已知缺陷影响）；
 *  - index.js 出口 re-export 同一性 smoke。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';
import * as index from '../src/index.js';
import { splitChunks as splitChunksViaIndex } from '../src/index.js';

function concatAll(parts) {
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/* ---------------- 视频往返：B 帧 cts / dtsOffset 累计 ---------------- */

test('往返：B 帧负 cts 经 trun v1 有符号往返，dtsOffset 独立于 pts 累计', () => {
  // GOP：I0(P1 B2 B3 P4)，B 帧 pts 落后 dts 一帧
  const frames = [
    { dts: 0, pts: 0, duration: 3003, keyframe: true, data: new Uint8Array(50).fill(1) },
    { dts: 3003, pts: 6006, duration: 3003, keyframe: false, data: new Uint8Array(51).fill(2) },
    { dts: 6006, pts: 3003, duration: 3003, keyframe: false, data: new Uint8Array(52).fill(3) },
    { dts: 9009, pts: 9009, duration: 3003, keyframe: false, data: new Uint8Array(53).fill(4) },
  ];
  const frag = fmp4.buildFragment({ trackId: 1, samples: frames, seq: 7 });
  const { chunks } = splitChunks(frag);
  assert.equal(chunks.length, 1);
  const t = chunks[0].tracks[0];
  assert.equal(t.baseTime, 0, 'tfdt 记首样本 dts');

  // cts = pts - dts（往返后精确还原，含负值）
  assert.deepEqual(t.samples.map((s) => s.cts), frames.map((f) => f.pts - f.dts));
  // dtsOffset 按解码序累计，与 pts 无关
  assert.deepEqual(t.samples.map((s) => s.dtsOffset), [0, 3003, 6006, 9009]);
  assert.deepEqual(t.samples.map((s) => s.durationTicks), [3003, 3003, 3003, 3003]);
  assert.deepEqual(t.samples.map((s) => s.size), [50, 51, 52, 53]);
  // 关键帧仅 I0（0x02000000 → true；0x01010000 → false）
  assert.deepEqual(t.samples.map((s) => s.keyframe), [true, false, false, false]);
  // chunk 内 dataStart 间距 == 前一样本 size（自洽；绝对地址见已知缺陷）
  for (let i = 1; i < t.samples.length; i++) {
    assert.equal(t.samples[i].dataStart - t.samples[i - 1].dataStart, t.samples[i - 1].size);
  }
});

test('往返：连续 chunk 的 baseTime 接续、dtsOffset 跨 chunk 单调推进', () => {
  const chunkLen = 3, step = 3003;
  const frags = [0, 1, 2].map((c) =>
    fmp4.buildFragment({
      trackId: 1,
      samples: Array.from({ length: chunkLen }, (_, i) => ({
        dts: (c * chunkLen + i) * step,
        pts: (c * chunkLen + i) * step,
        duration: step,
        keyframe: c === 0 && i === 0,
        data: new Uint8Array(20).fill(i + 1),
      })),
      seq: c + 1,
    })
  );
  const { chunks } = splitChunks(concatAll(frags));
  assert.equal(chunks.length, 3);
  chunks.forEach((c, ci) => {
    assert.equal(c.tracks[0].baseTime, ci * chunkLen * step, `chunk${ci} tfdt 接续`);
    c.tracks[0].samples.forEach((s, si) => {
      assert.equal(s.dtsOffset, (ci * chunkLen + si) * step, '全局解码时间线单调');
    });
  });
});

/* ---------------- 音频往返：trun v0 无 cts ---------------- */

test('往返：音频分片（trun v0 无 cts）cts 恒 0、默认时长回落', () => {
  const frames = [0, 1, 2].map((i) => ({
    dts: i * 1024,
    pts: i * 1024,
    duration: 1024,
    keyframe: true,
    data: new Uint8Array(12 + i).fill(9),
  }));
  const frag = fmp4.buildAudioFragment(2, 44100, frames, 5);
  const { chunks } = splitChunks(frag);
  const t = chunks[0].tracks[0];
  assert.equal(t.trackId, 2);
  assert.equal(t.baseTime, 0);
  assert.deepEqual(t.samples.map((s) => s.cts), [0, 0, 0], 'v0 trun 无 cts 字段 → 回落 0');
  assert.deepEqual(t.samples.map((s) => s.durationTicks), [1024, 1024, 1024]);
  assert.deepEqual(t.samples.map((s) => s.dtsOffset), [0, 1024, 2048]);
  assert.equal(t.samples.every((s) => s.keyframe), true, '音频样本默认 flags 为 sync');
  assert.deepEqual(t.samples.map((s) => s.size), [12, 13, 14]);
});

/* ---------------- mfhd seq 往返 ---------------- */

test('往返：splitChunks 保留 chunk 顺序，seq 语义由 moof 内 mfhd 承载', () => {
  const mk = (seq) => fmp4.buildFragment({
    trackId: 1,
    samples: [{ dts: 0, pts: 0, duration: 3003, keyframe: true, data: new Uint8Array(16).fill(1) }],
    seq,
  });
  const { chunks } = splitChunks(concatAll([mk(100), mk(101)]));
  assert.deepEqual(chunks.map((c) => c.index), [0, 1]);
  assert.equal(chunks[0].byteLength, mk(100).length, 'byteLength 含 styp 全字节');
  assert.equal(chunks[0].tracks[0].baseTime, 0);
});

/* ---------------- index.js 出口 smoke ---------------- */

test('index.js 出口：re-export 与源模块同一、容器元数据齐全', () => {
  assert.equal(index.containerName, 'cmaf');
  assert.ok(index.extensions.includes('cmf1') && index.mimeTypes.includes('video/iso.segment'));
  assert.equal(index.splitChunks, splitChunksViaIndex, '同一函数引用（无重复绑定）');
  assert.equal(typeof index.probe, 'function');
  assert.equal(typeof index.parseMoof, 'function');
  assert.equal(typeof index.PartTimeline, 'function');
  assert.equal(typeof index.CmafWebCodecsPlayer, 'function');
});
