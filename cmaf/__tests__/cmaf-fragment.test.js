/**
 * cmaf fragmented MP4 片段解析补充单测：
 *  - moof/mdat 构造、两遍 data_offset 回填、tfhd/tfdt/trun 字段；
 *  - 多轨分片按 trackId 分组、连续片段 mfhd seq 递增；
 *  - 异常输入：moof 后无 mdat 应抛 NOT_SUPPORTED。
 *
 * 片段字节由 hls fMP4 构造器生成，cmaf 仅做解析（零浏览器）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';
import { iterateBoxes, parseMoof, parseTfhd, parseMfhd } from '../src/isobmff.js';

function u8(n, v) { return new Uint8Array(n).fill(v); }
function makeFrames(baseDts, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      dts: baseDts + i * 3003,
      pts: baseDts + i * 3003,
      duration: 3003,
      keyframe: i === 0,
      data: u8(16 + i, i + 1),
    });
  }
  return out;
}
/** 在缓冲内定位首个类型为 type 的 box */
function findBox(buf, type) {
  for (const b of iterateBoxes(buf)) if (b.type === type) return b;
  return null;
}

/* ---------------- moof/mdat 与 data_offset 回填 ---------------- */

test('fragment：两遍 data_offset 回填正确，mdat 载荷等于帧拼接', () => {
  const frames = makeFrames(0, 2);
  const frag = fmp4.buildFragment({ trackId: 1, samples: frames });

  const moof = findBox(frag, 'moof');
  const mdat = findBox(frag, 'mdat');
  assert.ok(moof && mdat, '应同时存在 moof 与 mdat');

  // trun 内的 data_offset 应为 moof 长度 + mdat 8 字节头（距 moof 起点的标准偏移）
  const trafs = parseMoof(frag, moof.contentStart, moof.contentEnd);
  assert.equal(trafs.length, 1);
  assert.equal(trafs[0].trun.dataOffset, moof.size + 8);

  // 契约校验：moof 起点 + data_offset 应精确指向 mdat 载荷起点
  const moofStart = (() => { for (const b of iterateBoxes(frag)) { if (b.type === 'moof') return b.contentStart - 8; } })();
  assert.equal(moofStart + trafs[0].trun.dataOffset, mdat.contentStart,
    'data_offset 应使 moof起点+偏移 = mdat 载荷起点');

  // mdat 载荷应等于各帧字节顺序拼接（封装完整性）
  const payload = frag.subarray(mdat.contentStart, mdat.contentEnd);
  const expected = new Uint8Array(frames.reduce((n, f) => n + f.data.length, 0));
  let o = 0;
  for (const f of frames) { expected.set(f.data, o); o += f.data.length; }
  assert.deepEqual(Array.from(payload), Array.from(expected), 'mdat 载荷应等于帧拼接');

  // splitChunks 结构：样本个数与 size 与帧一致
  const { chunks } = splitChunks(frag);
  assert.equal(chunks.length, 1);
  const samples = chunks[0].tracks[0].samples;
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.size), frames.map((f) => f.data.length));
});

test('fragment：parseMoof 提取 tfhd 默认字段与 tfdt baseMediaDecodeTime', () => {
  const frag = fmp4.buildFragment({ trackId: 1, samples: makeFrames(9009, 1) });
  const moof = findBox(frag, 'moof');
  const traf = parseMoof(frag, moof.contentStart, moof.contentEnd)[0];

  assert.equal(traf.trackId, 1);
  assert.equal(traf.baseTime, 9009, 'tfdt(baseMediaDecodeTime) 应等于首样本 dts');
  assert.equal(traf.defaults.trackId, 1);
  assert.equal(traf.defaults.baseDataOffset, null, 'default-base-is-moof：无 baseDataOffset');
  assert.ok(traf.defaults.defaultSampleDuration > 0, '默认样本时长应被写出');
  assert.ok(traf.defaults.defaultSampleSize > 0, '默认样本尺寸应被写出');
  assert.equal(traf.trun.sampleCount, 1);
});

/* ---------------- 多轨 / 连续片段 seq 递增 ---------------- */

test('多轨分片：按 traf.trackId 分组为独立 chunk', () => {
  const init = fmp4.buildInit([
    { id: 1, type: 'video', codec: 'avc1.64001f', description: { tag: 'avcC', bytes: u8(8, 1) }, width: 64, height: 36, timescale: 90000 },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', description: { tag: 'esds', bytes: new Uint8Array([0x12, 0x10]) }, sampleRate: 44100, channels: 2, timescale: 44100 },
  ]);
  const vFrag = fmp4.buildFragment({ trackId: 1, samples: makeFrames(0, 1) });
  const aFrag = fmp4.buildAudioFragment(2, 44100, [
    { dts: 0, pts: 0, duration: 1024, keyframe: true, data: u8(12, 7) },
  ]);
  const buf = new Uint8Array(init.length + vFrag.length + aFrag.length);
  buf.set(init, 0); buf.set(vFrag, init.length); buf.set(aFrag, init.length + vFrag.length);

  const { chunks, initRange } = splitChunks(buf);
  assert.ok(initRange, 'init 段应被识别');
  assert.equal(chunks.length, 2, '视频/音频分片各一个 chunk');
  assert.deepEqual(chunks.map((c) => c.tracks[0].trackId), [1, 2]);

  // 各 chunk 的 moof 内 trackId 与 traf 一致
  chunks.forEach((c, i) => {
    const expected = i + 1;
    const moof = findBox(buf.subarray(c.startOffset), 'moof');
    const traf = parseMoof(buf, c.startOffset + moof.contentStart, c.startOffset + moof.contentEnd);
    assert.equal(traf[0].trackId, expected);
  });
});

test('连续片段：mfhd seq 严格递增且 moof 长度稳定', () => {
  const seqs = [1, 2, 3];
  const frags = seqs.map((s) => fmp4.buildFragment({ trackId: 1, samples: makeFrames(0, 1), seq: s }));

  const moofLens = frags.map((f) => findBox(f, 'moof').size);
  assert.deepEqual(moofLens, [moofLens[0], moofLens[0], moofLens[0]], 'seq 仅是 u32，moof 长度不应随 seq 变化');

  frags.forEach((f, i) => {
    const moof = findBox(f, 'moof');
    let mfhdBox = null;
    for (const sub of iterateBoxes(f, moof.contentStart, moof.contentEnd)) {
      if (sub.type === 'mfhd') mfhdBox = sub;
    }
    assert.ok(mfhdBox, 'moof 内应含 mfhd');
    assert.equal(parseMfhd(f, mfhdBox.contentStart), seqs[i], `第${i}个片段 seq 应=${seqs[i]}`);
  });
});

/* ---------------- 异常输入 ---------------- */

test('fragment：moof 后无 mdat 抛 NOT_SUPPORTED（无法定位样本数据）', () => {
  const frag = fmp4.buildFragment({ trackId: 1, samples: makeFrames(0, 1) });
  const moof = findBox(frag, 'moof');
  const truncated = frag.subarray(0, moof.contentEnd); // 保留 styp+moof，砍掉 mdat
  assert.throws(
    () => splitChunks(truncated),
    (e) => e.code === 'NOT_SUPPORTED',
    '缺 mdat 应抛 NOT_SUPPORTED'
  );
});
