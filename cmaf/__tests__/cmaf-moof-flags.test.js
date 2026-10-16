/**
 * cmaf moof 解析深化单测：trun flag 组合 / tfhd 缺省回落 / tfdt 双版本 / 多 traf
 *
 * 此前 parseTrun/parseTfhd 仅被 muxer 固定形态覆盖（全字段 trun + v1 tfdt）。
 * 本文件手工构造 moof 字节，覆盖：
 *  - trun 仅 data-offset 标志（rows 全零回落）与无 data-offset 标志；
 *  - trun v0 + composition offset（无符号语义，仅 v1 才有符号）；
 *  - tfdt v0（u32）与 v1（u64）经 parseMoof 提取 baseTime；
 *  - materializeSamples：trun 显式值覆盖 tfhd 默认、缺省字段回落 tfhd、
 *    tfhd 无默认 flags 时回落 0；
 *  - 单 moof 多 traf → 单 chunk 内多轨；
 *  - first-sample-flags 消费与应用（isobmff.js:191 曾不消费 4 字节字段导致
 *    rows 整体错位，第九十四波已修，本文件锁定）；
 *  - materializeSamples 的 data_offset 以 moof 起点为基准（曾错加在 mdat
 *    载荷起点上偏大 moof.size+8，第九十四波已修，本文件锁定）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitChunks } from '../src/chunk-parser.js';
import { parseMoof, parseTrun, parseTfhd, parseMfhd, iterateBoxes, isKeyframeFlag } from '../src/isobmff.js';

/* ---------------- 字节构造原语 ---------------- */

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
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

/** tfhd：trackId + 可选 default duration/size/flags（按位设置 flags） */
function tfhd(trackId, { duration = null, size = null, flags = null } = {}) {
  let f = 0x020000; // default-base-is-moof
  const payloads = [u32(trackId)];
  if (duration != null) { f |= 0x08; payloads.push(u32(duration)); }
  if (size != null) { f |= 0x10; payloads.push(u32(size)); }
  if (flags != null) { f |= 0x20; payloads.push(u32(flags)); }
  return fullBox('tfhd', 0, f, ...payloads);
}
function tfdt(version, baseTime) {
  return fullBox('tfdt', version, 0, version === 1 ? u64(baseTime) : u32(baseTime));
}
/**
 * trun：按 opts 决定 flag 位。
 * rows: [{duration,size,flags,cts}]，未给的字段不写行内字节。
 */
function trun(version, { dataOffset = null, rows = [] }) {
  let f = 0;
  const head = [u32(rows.length)];
  if (dataOffset != null) { f |= 0x000001; head.push(u32(dataOffset)); }
  // flag 位是 box 级语义：任一行声明某字段，则所有行都要写该字段
  // （缺省行写 0，由解析侧回落 tfhd 默认）
  for (const r of rows) {
    if (r.duration != null || rows.some((x) => x.duration != null)) f |= 0x000100;
    if (r.size != null || rows.some((x) => x.size != null)) f |= 0x000200;
    if (r.flags != null || rows.some((x) => x.flags != null)) f |= 0x000400;
    if (r.cts != null || rows.some((x) => x.cts != null)) f |= 0x000800;
  }
  const bodies = rows.map((r) => {
    const parts = [];
    if (f & 0x000100) parts.push(u32(r.duration ?? 0));
    if (f & 0x000200) parts.push(u32(r.size ?? 0));
    if (f & 0x000400) parts.push(u32(r.flags ?? 0));
    if (f & 0x000800) {
      const b = new Uint8Array(4);
      if (version === 1) new DataView(b.buffer).setInt32(0, r.cts ?? 0);
      else new DataView(b.buffer).setUint32(0, (r.cts ?? 0) >>> 0);
      parts.push(b);
    }
    return parts;
  }).flat();
  return fullBox('trun', version, f, ...head, ...bodies);
}
/** styp 等价占位（内容不重要） */
function styp() {
  return box('styp', u32(0x200), u32(0x6d736468));
}
/** 组装 [styp] + moof(单/多 traf) + mdat */
function buildMoofStream(trafBoxes, { withStyp = true, mdatBytes = 64 } = {}) {
  const moof = box('moof', ...trafBoxes);
  const mdat = box('mdat', new Uint8Array(mdatBytes).fill(0xab));
  const stream = withStyp ? concatAll([styp(), moof, mdat]) : concatAll([moof, mdat]);
  // Keep generated trun data offsets inside the associated mdat payload.
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const moofBox = Array.from(iterateBoxes(stream)).find((b) => b.type === 'moof');
  const dataOffset = moof.length + 8;
  for (const trafBox of iterateBoxes(stream, moofBox.contentStart, moofBox.contentEnd)) {
    if (trafBox.type !== 'traf') continue;
    for (const child of iterateBoxes(stream, trafBox.contentStart, trafBox.contentEnd)) {
      if (child.type === 'trun' && parseTrun(stream, child.contentStart, child.contentEnd).hasDataOffset) {
        dv.setInt32(child.contentStart + 8, dataOffset);
      }
    }
  }
  return stream;
}
function traf(trackId, baseTime, tfdtVer, trunBox, defaults = {}) {
  return box('traf', tfhd(trackId, defaults), tfdt(tfdtVer, baseTime), trunBox);
}

/* ---------------- parseTrun flag 组合 ---------------- */

test('parseTrun：仅 data-offset 标志 → 行字段全零回落', () => {
  const b = trun(0, { dataOffset: 140, rows: [{}, {}] });
  const r = parseTrun(b, 8, b.length);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.dataOffset, 140);
  assert.deepEqual(r.rows, [
    { duration: 0, size: 0, flags: 0, cts: 0 },
    { duration: 0, size: 0, flags: 0, cts: 0 },
  ]);
});

test('parseTrun：data_offset、first_sample_flags 与样本行不得跨 trun 边界读取', () => {
  const dataOffsetBox = trun(0, { dataOffset: 8, rows: [] });
  assert.throws(() => parseTrun(dataOffsetBox, 8, dataOffsetBox.length - 4),
    (err) => err.code === 'NOT_SUPPORTED');

  const firstFlagsBox = fullBox('trun', 0, 0x000004, u32(0), u32(0x02000000));
  assert.throws(() => parseTrun(firstFlagsBox, 8, firstFlagsBox.length - 2),
    (err) => err.code === 'NOT_SUPPORTED');

  const rowBox = trun(0, { rows: [{ duration: 3003 }] });
  assert.throws(() => parseTrun(rowBox, 8, rowBox.length - 2),
    (err) => err.code === 'NOT_SUPPORTED');
});

test('parseTrun：无 data-offset 标志 → dataOffset=0 且不读偏移字节', () => {
  // 行内显式 duration+size：若解析器错把首个 u32 当 dataOffset，rows 会错位
  const b = trun(0, { rows: [{ duration: 3003, size: 16 }, { duration: 3003, size: 17 }] });
  const r = parseTrun(b, 8, b.length);
  assert.equal(r.dataOffset, 0);
  assert.deepEqual(r.rows.map((x) => x.duration), [3003, 3003]);
  assert.deepEqual(r.rows.map((x) => x.size), [16, 17]);
});

test('parseTrun：拒绝 first_sample_flags 与逐样本 flags 同时存在', () => {
  const conflicting = fullBox('trun', 0, 0x000004 | 0x000400, u32(0), u32(1));
  assert.throws(() => parseTrun(conflicting, 8, conflicting.length),
    (err) => err.code === 'NOT_SUPPORTED' && /同时/.test(err.message));
});

test('parseTrun：拒绝未知 reserved flags', () => {
  const unknownFlags = fullBox('trun', 0, 0x000002, u32(0));
  assert.throws(() => parseTrun(unknownFlags, 8, unknownFlags.length),
    (err) => err.code === 'NOT_SUPPORTED' && /flags/.test(err.message));
});

test('parseTrun：拒绝不支持的 version 2，避免将 CTS 错读为有符号', () => {
  const unsupported = trun(2, { dataOffset: 8, rows: [{ duration: 1, size: 1, flags: 1, cts: 0x80000000 }] });
  assert.throws(() => parseTrun(unsupported, 8, unsupported.length),
    (err) => err.code === 'NOT_SUPPORTED' && /version/.test(err.message));
});

test('parseTrun：v0 + composition offset 为无符号读取（与 v1 有符号区分）', () => {
  // 同一组字节 0xFFFFFFFF：v0 → 4294967295；v1 → -1
  const v0 = trun(0, { dataOffset: 8, rows: [{ duration: 1, size: 1, flags: 1, cts: 0xffffffff }] });
  const v1 = trun(1, { dataOffset: 8, rows: [{ duration: 1, size: 1, flags: 1, cts: 0xffffffff }] });
  assert.equal(parseTrun(v0, 8, v0.length).rows[0].cts, 4294967295);
  assert.equal(parseTrun(v1, 8, v1.length).rows[0].cts, -1);
});

/* ---------------- tfdt v0/v1 经 parseMoof ---------------- */

test('parseMoof：tfdt v0 以 u32 读取 baseMediaDecodeTime（可超过 2^31）', () => {
  const stypLen = styp().length;
  const stream = buildMoofStream([
    traf(1, 0xf0000001, 0, trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 16 }] })),
  ]);
  // styp 之后即 moof
  for (const b of iterateBoxes(stream, stypLen, stream.length)) {
    if (b.type === 'moof') {
      const trafs = parseMoof(stream, b.contentStart, b.contentEnd);
      assert.equal(trafs[0].baseTime, 0xf0000001);
      assert.equal(trafs[0].trun.dataOffset, b.size + 8);
    }
  }
});

test('parseMoof：tfdt v1 超过 Number.MAX_SAFE_INTEGER 时拒绝精度丢失', () => {
  const stream = buildMoofStream([
    traf(1, 0x20_0000_0000_0000n, 1, trun(0, { dataOffset: 8, rows: [{ duration: 1, size: 1 }] })),
  ]);
  const moof = Array.from(iterateBoxes(stream)).find((b) => b.type === 'moof');
  assert.throws(() => parseMoof(stream, moof.contentStart, moof.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED');
});

test('parseMoof：tfdt v1 以 u64 读取（跨 2^32 的 baseTime）', () => {
  const stypLen = styp().length;
  const stream = buildMoofStream([
    traf(1, 0x1_0000_0001, 1, trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 16 }] })),
  ]);
  for (const b of iterateBoxes(stream, stypLen, stream.length)) {
    if (b.type === 'moof') {
      const trafs = parseMoof(stream, b.contentStart, b.contentEnd);
      assert.equal(trafs[0].baseTime, 0x1_0000_0001, 'v1 64bit baseTime 应完整保留');
    }
  }
});

/* ---------------- materializeSamples 缺省回落 ---------------- */

test('splitChunks：样本累计 DTS 超出安全整数时拒绝', () => {
  const stream = buildMoofStream([
    traf(Number(1), Number.MAX_SAFE_INTEGER, 1, trun(0, {
      dataOffset: 8,
      rows: [
        { duration: 1, size: 1, flags: 0x02000000 },
        { duration: 1, size: 1, flags: 0x02000000 },
      ],
    })),
  ]);
  assert.throws(() => splitChunks(stream), (err) => err.code === 'NOT_SUPPORTED');
});

test('splitChunks：trun 显式 duration 覆盖 tfhd 默认，缺省行回落默认值', () => {
  // tfhd 默认 duration=1024；行0 显式 3003，行1 省略
  const multiRunTraf = box('traf',
    tfhd(7, { duration: 1024, size: 32, flags: 0x02000000 }),
    tfdt(1, 9009),
    trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 20 }] }),
    trun(0, { rows: [{ size: 21 }] }),
  );
  const stream = buildMoofStream([multiRunTraf]);
  const { chunks } = splitChunks(stream);
  const samples = chunks[0].tracks[0].samples;
  assert.equal(chunks[0].tracks[0].trackId, 7);
  assert.deepEqual(samples.map((s) => s.durationTicks), [3003, 1024], '显式值优先，缺省回落 tfhd');
  assert.deepEqual(samples.map((s) => s.size), [20, 21]);
  // dtsOffset 累计：baseTime + 前序 duration 之和
  assert.deepEqual(samples.map((s) => s.dtsOffset), [9009, 12012]);
});

test('splitChunks：tfhd 无 default flags → flags 回落 0（isKeyframeFlag(0)=true 语义）', () => {
  const stream = buildMoofStream([
    traf(3, 0, 0, trun(0, { dataOffset: 8, rows: [{ duration: 1000, size: 10 }] })),
  ]);
  const { chunks } = splitChunks(stream);
  const s = chunks[0].tracks[0].samples[0];
  assert.equal(s.keyframe, true, 'flags=0：nonSync=0 → 按 sync 样本处理');
  assert.equal(isKeyframeFlag(0), true);
});

test('splitChunks：tfhd 默认 flags 参与关键帧判定（inter 帧非关键）', () => {
  const stream = buildMoofStream([
    traf(3, 0, 0, trun(0, { dataOffset: 8, rows: [{ duration: 1000, size: 10 }] }),
      { duration: 1000, size: 10, flags: 0x01010000 }),
  ]);
  const { chunks } = splitChunks(stream);
  assert.equal(chunks[0].tracks[0].samples[0].keyframe, false, 'depends_on=1 + non-sync → 非关键帧');
});

test('splitChunks：trun 显式 flags=0 覆盖 tfhd 的非关键默认标志', () => {
  const stream = buildMoofStream([
    traf(3, 0, 0, trun(0, {
      dataOffset: 8,
      rows: [{ duration: 1000, size: 10, flags: 0 }],
    }), { duration: 1000, size: 10, flags: 0x01010000 }),
  ]);
  const { chunks } = splitChunks(stream);
  assert.equal(chunks[0].tracks[0].samples[0].keyframe, true, '明确 flags=0 必须覆盖默认 non-sync');
});

test('splitChunks：trun 显式 flags 覆盖 tfhd 默认 flags', () => {
  const stream = buildMoofStream([
    traf(3, 0, 0, trun(0, {
      dataOffset: 8,
      rows: [{ duration: 1000, size: 10, flags: 0x02000000 }],
    }), { duration: 1000, size: 10, flags: 0x01010000 }),
  ]);
  const { chunks } = splitChunks(stream);
  assert.equal(chunks[0].tracks[0].samples[0].keyframe, true, '行内显式 I 帧标志优先于默认 inter 标志');
});

/* ---------------- 多 traf 单 moof ---------------- */

test('splitChunks：同一 traf 的多个 trun 合并且沿用连续 DTS 与数据偏移', () => {
  const multiRunTraf = box('traf',
    tfhd(7, { duration: 3003, size: 16, flags: 0x02000000 }),
    tfdt(1, 9009),
    trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 16 }] }),
    trun(0, { rows: [{ duration: 3003, size: 17 }] }),
  );
  const stream = buildMoofStream([multiRunTraf]);
  const { chunks } = splitChunks(stream);
  const samples = chunks[0].tracks[0].samples;
  assert.equal(samples.length, 2, '两个 trun 的样本都必须输出');
  assert.deepEqual(samples.map((sample) => sample.size), [16, 17]);
  assert.deepEqual(samples.map((sample) => sample.dtsOffset), [9009, 12012]);
  assert.equal(samples[1].dataStart, samples[0].dataStart + samples[0].size, '无新 data_offset 的 run 紧跟前一个 run');
});

test('splitChunks：同一 traf 的后续 trun 指向已使用样本范围时拒绝', () => {
  const multiRunTraf = box('traf',
    tfhd(7, { duration: 3003, size: 16, flags: 0x02000000 }),
    tfdt(1, 0),
    trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 16 }] }),
    trun(0, { dataOffset: 8, rows: [{ duration: 3003, size: 16 }] }),
  );
  const stream = buildMoofStream([multiRunTraf]);
  assert.throws(() => splitChunks(stream), (err) => err.code === 'NOT_SUPPORTED');
});

test('splitChunks：单 moof 双 traf → 单 chunk 内两条轨，各自默认与样本独立', () => {
  const stream = buildMoofStream([
    // 视频 traf：trun 全显式
    traf(1, 0, 1, trun(1, {
      dataOffset: 8,
      rows: [{ duration: 3003, size: 40, flags: 0x02000000, cts: -1501 }],
    })),
    // 音频 traf：trun 无行内字段，全靠 tfhd 默认
    traf(2, 0, 1, trun(0, { dataOffset: 8, rows: [{}, {}] }),
      { duration: 1024, size: 12, flags: 0x02000000 }),
  ]);
  const moofBox = Array.from(iterateBoxes(stream)).find((b) => b.type === 'moof');
  const trafBoxes = Array.from(iterateBoxes(stream, moofBox.contentStart, moofBox.contentEnd))
    .filter((b) => b.type === 'traf');
  const audioRun = Array.from(iterateBoxes(stream, trafBoxes[1].contentStart, trafBoxes[1].contentEnd))
    .find((b) => b.type === 'trun');
  new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
    .setInt32(audioRun.contentStart + 8, moofBox.size + 8 + 40);
  const { chunks } = splitChunks(stream);
  assert.equal(chunks.length, 1, '同一 moof 的多 traf 归入同一 chunk');
  assert.equal(chunks[0].tracks.length, 2);
  const [v, a] = chunks[0].tracks;
  assert.equal(v.trackId, 1);
  assert.equal(a.trackId, 2);
  assert.deepEqual(v.samples.map((s) => s.cts), [-1501], '视频 v1 trun 负 cts');
  assert.deepEqual(a.samples.map((s) => s.durationTicks), [1024, 1024], '音频走 tfhd 默认');
  assert.deepEqual(a.samples.map((s) => s.dtsOffset), [0, 1024], '音频 dtsOffset 独立累计');
  assert.equal(v.samples[0].keyframe, true);
  assert.equal(a.samples[0].keyframe, true);
});

test('splitChunks：跨 traf 指向重叠 mdat 样本范围时拒绝', () => {
  const stream = buildMoofStream([
    traf(1, 0, 1, trun(1, {
      dataOffset: 8,
      rows: [{ duration: 3003, size: 40, flags: 0x02000000 }],
    })),
    traf(2, 0, 1, trun(0, { dataOffset: 8, rows: [{}, {}] }),
      { duration: 1024, size: 12, flags: 0x02000000 }),
  ]);
  assert.throws(() => splitChunks(stream), (err) => err.code === 'NOT_SUPPORTED');
});

test('parseMoof：拒绝缺失或重复 tfhd，以及截断的 traf 子 box', () => {
  const noHeader = box('moof', box('traf', trun(0, { dataOffset: 8, rows: [] })));
  const noHeaderMoof = Array.from(iterateBoxes(noHeader))[0];
  assert.throws(() => parseMoof(noHeader, noHeaderMoof.contentStart, noHeaderMoof.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED' && /tfhd/.test(err.message));

  const duplicateHeader = box('moof', box('traf', tfhd(7), tfhd(7)));
  const duplicateMoof = Array.from(iterateBoxes(duplicateHeader))[0];
  assert.throws(() => parseMoof(duplicateHeader, duplicateMoof.contentStart, duplicateMoof.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED' && /多个 tfhd/.test(err.message));

  const validTraf = box('traf', tfhd(7), tfdt(0, 0), trun(0, { dataOffset: 8, rows: [] }));
  const malformedTraf = new Uint8Array(validTraf.length + 2);
  malformedTraf.set(validTraf);
  new DataView(malformedTraf.buffer).setUint32(0, malformedTraf.length);
  malformedTraf.set([0, 0], validTraf.length);
  const malformedMoof = box('moof', malformedTraf);
  const parsedMoof = Array.from(iterateBoxes(malformedMoof))[0];
  assert.throws(() => parseMoof(malformedMoof, parsedMoof.contentStart, parsedMoof.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED' && /box 列表/.test(err.message));
});

test('parseMoof：每个 traf 都必须包含 tfdt', () => {
  const trafBox = box('moof', box('traf', tfhd(7), trun(0, { rows: [] })));
  const moofBox = Array.from(iterateBoxes(trafBox))[0];
  assert.throws(() => parseMoof(trafBox, moofBox.contentStart, moofBox.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED' && /tfdt/.test(err.message));
});

test('parseMoof：拒绝无效 content range 与非空 duration-is-empty traf', () => {
  const bytes = new Uint8Array(32);
  assert.throws(() => parseMoof(bytes, 8, Number.MAX_SAFE_INTEGER + 1),
    (err) => err.code === 'NOT_SUPPORTED');
  const durationEmpty = fullBox('tfhd', 0, 0x030000, u32(7));
  const trafBox = box('moof', box('traf', durationEmpty, tfdt(0, 0),
    trun(0, { dataOffset: 8, rows: [{ duration: 1, size: 1 }] })));
  const moofBox = Array.from(iterateBoxes(trafBox))[0];
  assert.throws(() => parseMoof(trafBox, moofBox.contentStart, moofBox.contentEnd),
    (err) => err.code === 'NOT_SUPPORTED' && /duration-is-empty/.test(err.message));
});

test('parseMoof：空 traf 的显式 data base 参与后续 traf 隐式继承', () => {
  const traf1 = box('traf', tfhd(1), tfdt(0, 0),
    trun(0, { dataOffset: 8, rows: [{ duration: 1, size: 4 }] }));
  const traf2 = box('traf', fullBox('tfhd', 0, 0x000001, u32(2), u64(0)), tfdt(0, 0));
  const traf3 = box('traf', fullBox('tfhd', 0, 0, u32(3)), tfdt(0, 0),
    trun(0, { dataOffset: 0, rows: [{ duration: 1, size: 4 }] }));
  const stream = buildMoofStream([traf1, traf2, traf3]);
  const moofBox = Array.from(iterateBoxes(stream)).find((entry) => entry.type === 'moof');
  const mdatBox = Array.from(iterateBoxes(stream)).find((entry) => entry.type === 'mdat');
  const trafBoxes = Array.from(iterateBoxes(stream, moofBox.contentStart, moofBox.contentEnd))
    .filter((entry) => entry.type === 'traf');
  const middleTfhd = Array.from(iterateBoxes(stream, trafBoxes[1].contentStart, trafBoxes[1].contentEnd))
    .find((entry) => entry.type === 'tfhd');
  const lastTrun = Array.from(iterateBoxes(stream, trafBoxes[2].contentStart, trafBoxes[2].contentEnd))
    .find((entry) => entry.type === 'trun');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  view.setBigUint64(middleTfhd.contentStart + 8, BigInt(mdatBox.contentStart + 8));
  view.setInt32(lastTrun.contentStart + 8, 0);
  const tracks = splitChunks(stream).chunks[0].tracks;
  assert.equal(tracks.length, 2, 'empty traf does not produce an output track');
  assert.equal(tracks[0].samples[0].dataStart, mdatBox.contentStart);
  assert.equal(tracks[1].samples[0].dataStart, mdatBox.contentStart + 8,
    'following traf inherits the immediately preceding empty traf data base');
});

test('splitChunks：trun data_offset 相对显式 tfhd base_data_offset', () => {
  const trafBox = box('traf',
    fullBox('tfhd', 0, 0x000001, u32(7), u64(0)),
    tfdt(0, 0),
    trun(0, { dataOffset: 8, rows: [{ duration: 1, size: 4 }] }),
  );
  const stream = buildMoofStream([trafBox]);
  const moofBox = Array.from(iterateBoxes(stream)).find((entry) => entry.type === 'moof');
  const traf = Array.from(iterateBoxes(stream, moofBox.contentStart, moofBox.contentEnd))
    .find((entry) => entry.type === 'traf');
  const children = Array.from(iterateBoxes(stream, traf.contentStart, traf.contentEnd));
  const tfhdBox = children.find((entry) => entry.type === 'tfhd');
  const trunBox = children.find((entry) => entry.type === 'trun');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  view.setBigUint64(tfhdBox.contentStart + 8, BigInt(moofBox.boxStart + 4));
  view.setInt32(trunBox.contentStart + 8, moofBox.size + 4);
  const samples = splitChunks(stream).chunks[0].tracks[0].samples;
  assert.equal(samples[0].dataStart, moofBox.boxStart + moofBox.size + 8);
});

test('parseTfhd：拒绝不支持的 FullBox version 与 reserved flags', () => {
  const unsupported = fullBox('tfhd', 1, 0, u32(1));
  assert.throws(() => parseTfhd(unsupported, 8, unsupported.length),
    (err) => err.code === 'NOT_SUPPORTED' && /version/.test(err.message));
  const reserved = fullBox('tfhd', 0, 0x000004, u32(1));
  assert.throws(() => parseTfhd(reserved, 8, reserved.length),
    (err) => err.code === 'NOT_SUPPORTED' && /flags/.test(err.message));
});

test('parseTfhd、parseTrun、parseMfhd：非法 content range 受控拒绝', () => {
  const invalidEnd = Number.MAX_SAFE_INTEGER + 1;
  const tfhdBox = tfhd(7);
  const trunBox = trun(0, { rows: [] });
  const mfhdBox = fullBox('mfhd', 0, 0, u32(1));
  for (const [parser, input] of [
    [parseTfhd, tfhdBox], [parseTrun, trunBox], [parseMfhd, mfhdBox],
  ]) {
    assert.throws(() => parser(input, 8, invalidEnd), (err) => err.code === 'NOT_SUPPORTED');
    assert.throws(() => parser(input, -1, input.length), (err) => err.code === 'NOT_SUPPORTED');
  }
});

test('parseTfhd：可选 base_data_offset 截断于 tfhd 边界时拒绝', () => {
  const truncated = fullBox('tfhd', 0, 0x000001, u32(1), u32(0));
  assert.throws(() => parseTfhd(truncated, 8, truncated.length), (err) => err.code === 'NOT_SUPPORTED');
});

test('parseTfhd：缺失 track_ID 时不得从后续 box 读取字段', () => {
  const truncated = fullBox('tfhd', 0, 0, new Uint8Array(2));
  assert.throws(() => parseTfhd(truncated, 8, truncated.length), (err) => err.code === 'NOT_SUPPORTED');
});

test('parseTfhd：base_data_offset 超出安全整数范围时拒绝精度损失', () => {
  const truncated = fullBox('tfhd', 0, 0x000001, u32(1), u64(0x20_0000_0000_0000n));
  assert.throws(() => parseTfhd(truncated, 8, truncated.length), (err) => err.code === 'NOT_SUPPORTED');
});

test('parseTfhd：无默认字段时 default* 为 null（不误读 trackId 后字节）', () => {
  const b = tfhd(9);
  const t = parseTfhd(b, 8, b.length);
  assert.equal(t.trackId, 9);
  assert.equal(t.defaultSampleDuration, null);
  assert.equal(t.defaultSampleSize, null);
  assert.equal(t.defaultSampleFlags, null);
  assert.equal(t.baseDataOffset, null);
});

/* ---------------- 第九十四波缺陷回归 ---------------- */

test('parseTrun：first-sample-flags 被消费并应用到首样本（rows 不错位）', () => {
  // flags: dataOffset(0x1) | firstSampleFlags(0x4) | duration(0x100) | size(0x200)
  const f = 0x000001 | 0x000004 | 0x000100 | 0x000200;
  const body = concatAll([
    u32(2),              // sample_count
    u32(0x40),           // data_offset
    u32(0x02000000),     // first_sample_flags
    u32(10), u32(16),    // row0: duration,size
    u32(20), u32(24),    // row1: duration,size
  ]);
  const b = fullBox('trun', 0, f, body);
  const r = parseTrun(b, 8, b.length);
  assert.equal(r.firstSampleFlags, 0x02000000);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].flags, 0x02000000, '首样本 flags 取 first_sample_flags');
  assert.equal(r.rows[1].flags, 0, '后续样本 flags 回落默认（此处 0）');
  // 修复前 rows 整体错位 4 字节：row0.duration 会被读成 first_sample_flags 值
  assert.equal(r.rows[0].duration, 10);
  assert.equal(r.rows[0].size, 16);
  assert.equal(r.rows[1].duration, 20);
  assert.equal(r.rows[1].size, 24);
});

test('materializeSamples：data_offset 以 moof 起点为基准（=mdat 载荷起点）', () => {
  const stypLen = 16; // box('styp', u32,u32) = 8 + 8
  const build = (dataOffset) => {
    const moof = box('moof', traf(1, 0, 0,
      trun(0, { dataOffset, rows: [{ duration: 1000, size: 16 }] }),
      { duration: 1000, size: 16 }));
    return { moof, buf: concatAll([styp(), moof, box('mdat', new Uint8Array(32).fill(0xcd))]) };
  };
  // 两遍回填：dataOffset = moof 长度 + 8（mdat 头），与各 muxer 写法一致
  const { moof } = build(0);
  const { buf } = build(moof.length + 8);
  const { chunks } = splitChunks(buf);
  const s = chunks[0].tracks[0].samples[0];
  // mdat 载荷起点 = styp(16) + moof + 8；修复前 = 该值 + moof.length + 8
  assert.equal(s.dataStart, stypLen + moof.length + 8,
    `dataStart 应为 mdat 载荷起点，实得 ${s.dataStart}`);
});
