/**
 * cmaf chunk 边界语义深化单测（splitChunks finalize / 容错分支）
 *
 * 覆盖此前未测的分支：
 *  - styp 起始但不含 moof 的块 → 仍作为空 chunk 产出（finalize else 分支）；
 *  - 第二个 init 段（ftyp 起始且无 moof）→ initRange 仅记首个，其后整块丢弃；
 *  - 无 styp 的完整文件形态（ftyp+moov+moof+mdat）→ 容错归为单 chunk；
 *  - mdat 声明尺寸超出缓冲（截断）→ 找不到完整 mdat 抛 NOT_SUPPORTED；
 *  - initRange 的 startOffset/byteLength 精确对位。
 *
 * 注：样本 dataStart 的绝对值受已知缺陷影响（chunk-parser.js:149 将相对 moof
 * 起点的 data_offset 误加在 mdat 载荷起点上），本文件只断言 chunk 级边界语义，
 * 不锁死 dataStart 绝对值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';
import { iterateBoxes } from '../src/isobmff.js';

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

function makeFrames(baseDts, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      dts: baseDts + i * 3003,
      pts: baseDts + i * 3003,
      duration: 3003,
      keyframe: i === 0,
      data: new Uint8Array(16 + i).fill(i + 1),
    });
  }
  return out;
}

function makeInit() {
  return fmp4.buildInit([
    {
      id: 1,
      type: 'video',
      codec: 'avc1.64001f',
      description: { tag: 'avcC', bytes: new Uint8Array(8).fill(1) },
      width: 64,
      height: 36,
      timescale: 90000,
    },
  ]);
}

function makeFrag(baseDts) {
  return fmp4.buildFragment({ trackId: 1, samples: makeFrames(baseDts, 1) });
}

/* ---------------- finalize 分支语义 ---------------- */

test('splitChunks：styp 起始但无 moof 的块仍产出空 tracks chunk', () => {
  const frag = makeFrag(0);
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  const stypSize = dv.getUint32(0);
  const stypOnly = frag.subarray(0, stypSize);
  const { chunks, initRange } = splitChunks(stypOnly);
  assert.equal(initRange, null, 'styp 块不判为 init');
  assert.equal(chunks.length, 1, 'styp 块即便无 moof 也按 chunk 收尾');
  assert.equal(chunks[0].styp, true);
  assert.equal(chunks[0].tracks.length, 0, '无 moof → 无轨信息');
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].byteLength, stypSize, 'byteLength 含 styp 全部字节');
});

test('splitChunks：第二个 init 段被丢弃，initRange 仅记首个', () => {
  const init1 = makeInit();
  const init2 = makeInit(); // 内容相同的第二份 init（换轨重发场景）
  const frag = makeFrag(0);
  const buf = concatAll([init1, init2, frag]);
  const { chunks, initRange } = splitChunks(buf);
  assert.ok(initRange);
  assert.equal(initRange.startOffset, 0);
  assert.equal(initRange.byteLength, init1.length, 'initRange 精确等于第一份 init 长度');
  assert.equal(chunks.length, 1, '第二份 init 既非 chunk 也非 init → 丢弃');
  assert.equal(chunks[0].tracks[0].baseTime, 0);
});

test('splitChunks：无 styp 的完整文件（ftyp+moov+moof+mdat）容错归为单 chunk', () => {
  const init = makeInit();
  const frag = makeFrag(0);
  // 直接拼成普通 fMP4 文件形态：moov 与 moof 之间无 styp 边界
  const buf = concatAll([init, frag.subarray(new DataView(frag.buffer, frag.byteOffset, frag.byteLength).getUint32(0))]);
  const { chunks, initRange } = splitChunks(buf);
  // 整段含 moof → 不能判为 init；无 styp → 单 chunk 容错
  assert.equal(initRange, null, '块内含 moof 时 ftyp 起始不判为 init');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].styp, false);
  assert.equal(chunks[0].tracks.length, 1);
  assert.equal(chunks[0].tracks[0].trackId, 1);
  assert.equal(chunks[0].startOffset, 0, 'chunk 起点为首个 box 头');
  assert.equal(chunks[0].byteLength, buf.length);
});

test('splitChunks：initRange 与 frag 交替流中 init 定位精确', () => {
  const init = makeInit();
  const frag0 = makeFrag(0);
  const frag1 = makeFrag(3003);
  const buf = concatAll([init, frag0, frag1]);
  const { chunks, initRange } = splitChunks(buf);
  assert.equal(initRange.startOffset, 0);
  assert.equal(initRange.byteLength, init.length);
  assert.equal(chunks.length, 2);
  // chunk 边界对位：chunk1 紧随 init 之后
  assert.equal(chunks[0].startOffset, init.length);
  assert.equal(chunks[1].startOffset, init.length + frag0.length);
  assert.equal(chunks[1].byteLength, frag1.length);
  // chunk index 连续编号
  assert.deepEqual(chunks.map((c) => c.index), [0, 1]);
});

/* ---------------- 异常输入 ---------------- */

test('splitChunks：mdat 声明尺寸被截断 → 抛 NOT_SUPPORTED（找不到完整 mdat）', () => {
  const frag = makeFrag(0);
  // 砍掉 mdat 尾部若干字节：mdat 头中声明的 size 大于剩余缓冲
  const moof = [...iterateBoxes(frag)].find((b) => b.type === 'moof');
  const truncated = frag.subarray(0, moof.contentEnd + 4); // 只留 mdat 头 4 字节
  assert.throws(() => splitChunks(truncated), (e) => e.code === 'NOT_SUPPORTED');
});
