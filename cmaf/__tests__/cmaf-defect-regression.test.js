/**
 * cmaf 缺陷回归测试：修复 audit-2 两处解析缺陷
 *
 *  - 缺陷 A（chunk-parser.js:149，已修）：materializeSamples 的 dataStart 基准。
 *    default-base-is-moof 下 trun.data_offset 相对 moof 起点；此前误加在 mdat
 *    载荷起点，dataStart 普遍偏大 (moof.size+8)。回归：首样本 dataStart 精确等于
 *    mdat 载荷起点；chunk 内相邻 dataStart 间距 == 前样 size。
 *  - 缺陷 B（isobmff.js:191，已修）：parseTrun 遇 first-sample-flags(0x004) 时
 *    未消费 4 字节字段，导致所有样本行错位 4 字节、首样本标志也未应用。
 *    回归：rows 正确对齐、first_sample_flags 仅作用于首样本（且被首样本自身
 *    显式 flags 覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';
import { parseTrun, iterateBoxes } from '../src/isobmff.js';

/* ---------------- 字节构造助手 ---------------- */

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function box(type, ...payloads) {
  let len = 0;
  for (const p of payloads) len += p.length;
  const out = new Uint8Array(8 + len);
  new DataView(out.buffer).setUint32(0, len + 8);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of payloads) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function fullBox(type, version, flags, ...payloads) {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payloads);
}
function styp() {
  return box('styp', u32(0x200), u32(0x6d736468));
}
function trun(version, { dataOffset = null, firstSampleFlags = null, rows = [] }) {
  let f = 0;
  const head = [u32(rows.length)];
  if (dataOffset != null) { f |= 0x000001; head.push(u32(dataOffset)); }
  if (firstSampleFlags != null) f |= 0x000004;
  for (const r of rows) {
    if (r.duration != null || rows.some((x) => x.duration != null)) f |= 0x000100;
    if (r.size != null || rows.some((x) => x.size != null)) f |= 0x000200;
    if (r.flags != null || rows.some((x) => x.flags != null)) f |= 0x000400;
    if (r.cts != null || rows.some((x) => x.cts != null)) f |= 0x000800;
  }
  const all = [...head];
  if (firstSampleFlags != null) all.push(u32(firstSampleFlags));
  const bodies = rows.map((r) => {
    const parts = [];
    if (f & 0x000100) parts.push(u32(r.duration ?? 0));
    if (f & 0x000200) parts.push(u32(r.size ?? 0));
    if (f & 0x000400) parts.push(u32(r.flags ?? 0));
    if (f & 0x000800) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, r.cts ?? 0);
      parts.push(b);
    }
    return parts;
  }).flat();
  return fullBox('trun', version, f, ...all, ...bodies);
}
function tfhd(trackId, { duration = null, size = null, flags = null } = {}) {
  let f = 0;
  const ps = [u32(trackId)];
  if (duration != null) { f |= 0x08; ps.push(u32(duration)); }
  if (size != null) { f |= 0x10; ps.push(u32(size)); }
  if (flags != null) { f |= 0x20; ps.push(u32(flags)); }
  return fullBox('tfhd', 0, f, ...ps);
}
function tfdt(baseTime) {
  return fullBox('tfdt', 1, 0, (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(baseTime)); return b; })());
}
function traf(trackId, baseTime, trunBox, defs = {}) {
  return box('traf', tfhd(trackId, defs), tfdt(baseTime), trunBox);
}
function moofStream(trafBoxes, { mdatBytes = 64 } = {}) {
  const moof = box('moof', ...trafBoxes);
  const mdat = box('mdat', new Uint8Array(mdatBytes).fill(0xab));
  return { stream: (() => { const out = new Uint8Array(styp().length + moof.length + mdat.length); out.set(styp(), 0); out.set(moof, styp().length); out.set(mdat, styp().length + moof.length); return out; })(), moofLen: moof.length };
}

/* ---------------- 缺陷 B：first-sample-flags 解析对齐 ---------------- */

test('回归 B：first-sample-flags 不引发 rows 错位，且首样本标志被应用', () => {
  const b = trun(0, {
    dataOffset: 8,
    firstSampleFlags: 0x02000000, // 首样本 I 帧（sync）
    rows: [{ duration: 3003, size: 16 }, { duration: 3003, size: 17 }],
  });
  const r = parseTrun(b, 8, b.length);
  // 关键：rows 必须按 (duration,size) 正确解析，不得把 first_sample_flags 读成 duration
  assert.deepEqual(r.rows, [
    { duration: 3003, size: 16, flags: 0x02000000, cts: 0 },
    { duration: 3003, size: 17, flags: 0, cts: 0 },
  ]);
  assert.equal(r.firstSampleFlags, 0x02000000);
});

test('回归 B：first-sample-flags 与首样本显式 flags 共存时，显式值优先', () => {
  const b = trun(0, {
    dataOffset: 8,
    firstSampleFlags: 0x02000000, // 默认若是 I 帧
    rows: [
      { duration: 3003, size: 16, flags: 0x01010000 }, // 首样本自身声明 inter
      { duration: 3003, size: 17 },
    ],
  });
  const r = parseTrun(b, 8, b.length);
  assert.equal(r.rows[0].flags, 0x01010000, '首样本显式 flags 覆盖 first_sample_flags');
  assert.equal(r.rows[1].flags, 0, '非首样本无自身 flags → 回落 0（first_sample_flags 仅首样本）');
});

test('回归 B：splitChunks 读回 first-sample-flags 的首样本关键帧判定', () => {
  const { stream } = moofStream([
    traf(5, 9009, trun(0, {
      dataOffset: 8,
      firstSampleFlags: 0x02000000,
      rows: [{ duration: 1024, size: 10 }, { duration: 1024, size: 11 }],
    }), { duration: 1024, size: 10, flags: 0x02000000 }),
  ]);
  const { chunks } = splitChunks(stream);
  const s = chunks[0].tracks[0].samples;
  assert.equal(s[0].keyframe, true, '首样本应取 first_sample_flags 的 I 帧位');
  assert.equal(s[1].keyframe, true, 'tfhd 默认 flags（sync）作用于其余样本');
});

/* ---------------- 缺陷 A：dataStart 基准 ---------------- */

test('回归 A：首样本 dataStart 精确等于 mdat 载荷起点（moof 基准）', () => {
  const frames = [0, 1].map((i) => ({
    dts: i * 3003, pts: i * 3003, duration: 3003,
    keyframe: i === 0, data: new Uint8Array(16 + i).fill(i + 1),
  }));
  const frag = fmp4.buildFragment({ trackId: 1, samples: frames });
  let mdatContent = -1;
  for (const b of iterateBoxes(frag)) if (b.type === 'mdat') mdatContent = b.contentStart;
  const { chunks } = splitChunks(frag);
  const samples = chunks[0].tracks[0].samples;
  assert.equal(samples[0].dataStart, mdatContent, 'dataStart 应精确指向 mdat 载荷起点');
  assert.equal(samples[0].size, 16);
  assert.equal(samples[1].dataStart, mdatContent + 16, '第二样本紧随第一样本载荷');
});

test('回归 A：多样本 chunk 内 dataStart 间距恒等于前样 size，无 moof.size 偏移残差', () => {
  const frames = [0, 1, 2].map((i) => ({
    dts: i * 1001, pts: i * 1001, duration: 1001,
    keyframe: i === 0, data: new Uint8Array(20 + i * 7).fill(i),
  }));
  const frag = fmp4.buildFragment({ trackId: 1, samples: frames });
  const { chunks } = splitChunks(frag);
  const s = chunks[0].tracks[0].samples;
  for (let i = 1; i < s.length; i++) {
    assert.equal(s[i].dataStart - s[i - 1].dataStart, s[i - 1].size, `样本${i}间距应等于前样 size`);
  }
  // 整段载荷长度守恒
  const total = s[s.length - 1].dataStart + s[s.length - 1].size - s[0].dataStart;
  const payloadLen = frames.reduce((n, f) => n + f.data.length, 0);
  assert.equal(total, payloadLen);
});

test('回归 A：手工 moof 中 data_offset(moof 基准) 直接定位到 mdat 起点', () => {
  // 两遍构造：先以占位 data_offset 量出 moof 真实长度，再回填精确偏移
  const probe = box('moof', traf(1, 0, trun(0, { dataOffset: 0, rows: [{ duration: 1024, size: 10 }] }),
    { duration: 1024, size: 10, flags: 0x02000000 }));
  const moofLen = probe.length;
  const moof = box('moof', traf(1, 0, trun(0, { dataOffset: moofLen + 8, rows: [{ duration: 1024, size: 10 }] }),
    { duration: 1024, size: 10, flags: 0x02000000 }));
  const mdat = box('mdat', new Uint8Array(64).fill(0xab));
  const stream = new Uint8Array(styp().length + moof.length + mdat.length);
  stream.set(styp(), 0); stream.set(moof, styp().length); stream.set(mdat, styp().length + moof.length);

  let moofStart = -1, mdatContent = -1;
  for (const b of iterateBoxes(stream, 0, stream.length)) {
    if (b.type === 'moof') moofStart = b.contentStart - 8;
    if (b.type === 'mdat') mdatContent = b.contentStart;
  }
  const { chunks } = splitChunks(stream);
  assert.equal(chunks[0].tracks[0].samples[0].dataStart, moofStart + (moofLen + 8),
    'data_offset(moof 基准) 应使 起点+偏移 = mdat 载荷起点');
  assert.equal(chunks[0].tracks[0].samples[0].dataStart, mdatContent);
});
