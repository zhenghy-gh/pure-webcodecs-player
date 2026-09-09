/**
 * FlvRemuxer 单测（契约 µs 样本输入 → fMP4 输出）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvRemuxer } from '../src/fmp4-remuxer.js';
import { createFlvDemuxer } from '../src/flv-demuxer.js';
import { assembleFlv } from './fixtures/build-flv.mjs';

function walkBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > bytes.length) throw new Error(`盒子越界 @${pos} size=${size}`);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    boxes.push({ type, start: pos, size });
    pos += size;
  }
  return boxes;
}

function findBox(bytes, path) {
  let current = bytes;
  for (const name of path) {
    const found = walkBoxes(current).find((b) => b.type === name);
    if (!found) return null;
    current = current.subarray(found.start + 8, found.start + found.size);
    if (name === 'stsd') current = current.subarray(8);                       // version/flags+entry_count
    else if (name === 'avc1' || name === 'hvc1') current = current.subarray(78); // VisualSampleEntry 固定体
    else if (name === 'mp4a') current = current.subarray(28);                 // AudioSampleEntry 固定体
  }
  return current;
}

async function remux(file, { fragmentUs = 100_000 } = {}) {
  const d = await createFlvDemuxer(file);
  const r = new FlvRemuxer({ fragmentUs });
  const inits = [];
  const segs = [];
  r.on('initSegment', (s) => inits.push(s));
  r.on('mediaSegment', (s) => segs.push(s));
  await r.drain(d);
  await d.destroy();
  return { inits, segs };
}

test('remux：init segment 结构完整且只输出一次', async () => {
  const { inits } = await remux(assembleFlv({ video: { frames: 8 }, audio: { count: 6 } }));
  assert.equal(inits.length, 1);
  assert.deepEqual(walkBoxes(inits[0].data).map((b) => b.type), ['ftyp', 'moov']);
  const moov = findBox(inits[0].data, ['moov']);
  assert.ok(findBox(moov, ['mvhd']));
  assert.ok(findBox(moov, ['mvex', 'trex']));
  const trakVideo = findBox(moov, ['trak']);
  assert.ok(findBox(trakVideo, ['mdia', 'minf', 'stbl', 'stsd', 'avc1']));
  assert.ok(findBox(trakVideo, ['mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC']));
});

test('remux：media segment 为 moof+mdat、trun 与 mdat 账目一致、data_offset 精确', async () => {
  const { segs } = await remux(assembleFlv({ video: { frames: 12, gopSize: 6 }, audio: { count: 4 } }));
  assert.ok(segs.length >= 2);
  const videoSegs = segs.filter((s) => s.trackId === 1);
  for (const seg of segs) {
    assert.deepEqual(walkBoxes(seg.data).map((b) => b.type), ['moof', 'mdat']);
    const moofFull = seg.data.subarray(0, walkBoxes(seg.data)[0].size);
    const trun = findBox(findBox(moofFull, ['moof', 'traf']), ['trun']);
    const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
    const flags = view.getUint32(0) & 0xffffff;
    const count = view.getUint32(4);
    const hasFirstFlags = (flags & 0x004) !== 0;
    const ctsPresent = (flags & 0x400) !== 0;
    let pos = hasFirstFlags ? 16 : 12;
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += view.getUint32(pos + 4);
      pos += 8 + (ctsPresent ? 4 : 0);
    }
    const mdatSize = walkBoxes(seg.data)[1].size - 8;
    assert.equal(total, mdatSize, 'trun 样本总大小应等于 mdat 负载');
    assert.equal(view.getUint32(8), moofFull.length + 8, 'data_offset 应为 moof 长度+8');

    // 视频分片（除 flush 残段外）必须以关键帧开头（first_sample_flags 标记同步样本）
    if (seg.trackId === 1 && seg !== videoSegs[videoSegs.length - 1]) {
      assert.ok((flags & 0x004) !== 0, `视频分片 seq=${seg.seqNo} 未以关键帧开头`);
    }
  }
});

test('remux：时间基归零（baseMediaDecodeTime 从 0 开始）', async () => {
  const { segs } = await remux(assembleFlv({ video: { frames: 6 }, audio: { count: 2 } }));
  assert.ok(segs.length > 0);
  assert.equal(segs[0].baseDts, 0);
});

test('remux：纯音频流产出 mp4a init 与分片', async () => {
  const { inits, segs } = await remux(assembleFlv({ audio: { count: 10 } }));
  assert.equal(inits.length, 1);
  assert.ok(findBox(inits[0].data, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']));
  assert.ok(segs.length >= 1);
});

test('remux：init segment 可被 mp4 模块 probe 识别（pm 验收点）', async () => {
  let Mp4Demuxer = null;
  try { ({ Mp4Demuxer } = await import('../../mp4/src/index.js')); } catch { /* 模块不可用则跳过 */ }
  if (!Mp4Demuxer) return;
  const { inits } = await remux(assembleFlv({ video: { frames: 4 }, audio: { count: 2 } }));
  const pr = Mp4Demuxer.probe(inits[0].data.subarray(0, 64));
  assert.ok(pr && pr.confidence >= 0.8 && pr.container === 'mp4', JSON.stringify(pr));
});
