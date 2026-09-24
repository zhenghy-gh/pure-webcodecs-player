/**
 * box-parser 残余版本/防御分支补测（第二百零二波）
 * ------------------------------------------------------------
 *   - iterateBoxes：尾部非零零头 throw / 全零 padding 早退 / size=0 延展到容器末尾；
 *   - parseMvhd / parseMdhd 的 version 1 64 位字段分支；
 *   - parseSampleEntry：mp4a v1 扩展段、v2 QuickTime 扩展、未识别类型 raw 兜底；
 *   - parseMoov：largesize（size=1）与 size=0 两种头部形态；
 *   - parseTrak：edts → elst 嵌套扫描。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ByteStream, ByteWriter } from '../../core/src/index.js';
import {
  iterateBoxes,
  parseMoov,
  parseTrak,
  parseMvhd,
  parseMdhd,
  parseSampleEntry,
} from '../src/box-parser.js';
import { buildMvhd } from '../src/box-builder.js';

/** 8 字节标准头 box；sizeOverride 可写非常规声明值 */
function box(type, payload, sizeOverride) {
  const b = new Uint8Array(8 + payload.byteLength);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, sizeOverride ?? b.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(payload, 8);
  return b;
}

/** 16 字节 largesize 头 box（size=1 + u64 实际长） */
function box64(type, payload) {
  const b = new Uint8Array(16 + payload.byteLength);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  dv.setBigUint64(8, BigInt(16 + payload.byteLength), false);
  b.set(payload, 16);
  return b;
}

const fourcc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/* ------------------------------ iterateBoxes ------------------------------ */

test('iterateBoxes：尾部非零零头 → truncated box header', () => {
  const bytes = new Uint8Array([...box('free', new Uint8Array(0)), 1, 2, 3]);
  assert.throws(() => iterateBoxes(bytes, 0, bytes.length, () => {}), /truncated box header at 8/);
});

test('iterateBoxes：尾部全零 padding → 静默早退不抛', () => {
  const bytes = new Uint8Array([...box('free', new Uint8Array(0)), 0, 0, 0, 0]);
  const seen = [];
  iterateBoxes(bytes, 0, bytes.length, (h) => seen.push(h.type));
  assert.deepEqual(seen, ['free']);
});

test('iterateBoxes：size=0 → box 延展到容器末尾', () => {
  const bytes = box('mdat', new Uint8Array(12), 0); // 头部声明 0 = 至父容器末尾
  const seen = [];
  iterateBoxes(bytes, 0, bytes.length, (h) => seen.push([h.type, h.size, h.end]));
  assert.deepEqual(seen, [['mdat', 20, 20]]);
});

/* ------------------------------ v1 64 位字段分支 ------------------------------ */

test('parseMvhd version 1：creation/modification/duration 按 u64 读', () => {
  const w = new ByteWriter();
  w.writeU8(1); w.writeU24(0);
  w.writeU64(1000n); w.writeU64(2000n);
  w.writeU32(600); w.writeU64(12345n);
  w.writeFixed16_16(1); w.writeU16(256);
  const mvhd = parseMvhd(new ByteStream(w.toUint8Array(), 0));
  assert.equal(mvhd.creationTime, 1000);
  assert.equal(mvhd.modificationTime, 2000);
  assert.equal(mvhd.timescale, 600);
  assert.equal(mvhd.duration, 12345);
  assert.equal(mvhd.rate, 1);
  assert.equal(mvhd.volume, 1);
});

test('buildMvhd rate uses numeric 16.16 input', () => {
  const bytes = buildMvhd({ timescale: 1000 });
  const mvhd = parseMvhd(new ByteStream(bytes, 8));
  assert.equal(mvhd.rate, 1);
});

test('parseMdhd version 1：64 位时间字段 + language 解包', () => {
  const w = new ByteWriter();
  w.writeU8(1); w.writeU24(0);
  w.writeU64(0n); w.writeU64(0n);
  w.writeU32(44100); w.writeU64(441000n);
  w.writeU16((21 << 10) | (14 << 5) | 4); // 'und'
  const mdhd = parseMdhd(new ByteStream(w.toUint8Array(), 0));
  assert.equal(mdhd.timescale, 44100);
  assert.equal(mdhd.duration, 441000);
  assert.equal(mdhd.language, 'und');
});

/* ------------------------------ sample entry 版本分支 ------------------------------ */

/** SampleEntry 公共头 8B（reserved6 + data_ref_index）之后即 version 字段 */
function audioEntry(version, fields) {
  const w = new ByteWriter();
  w.writeRaw(new Uint8Array(6)); w.writeU16(1);
  w.writeU16(version); w.writeU16(0); w.writeRaw(fourcc('mac '));
  fields(w);
  return w.toUint8Array();
}

test('parseSampleEntry mp4a v1：常规字段后跳过 16 字节扩展段', () => {
  const entryBytes = audioEntry(1, (w) => {
    w.writeU16(2); w.writeU16(16); w.writeRaw(new Uint8Array(4));
    w.writeFixed16_16(44100);
    w.writeRaw(new Uint8Array(16)); // samples/bytes_per_packet 等 4×u32
  });
  const e = parseSampleEntry('mp4a', new ByteStream(entryBytes, 0));
  assert.equal(e.version, 1);
  assert.equal(e.channelCount, 2);
  assert.equal(e.sampleSize, 16);
  assert.equal(e.sampleRate, 44100);
});

test('parseSampleEntry mp4a v2：QuickTime 扩展（F64 采样率 + u32 字段）', () => {
  const entryBytes = audioEntry(2, (w) => {
    w.writeRaw(new Uint8Array(8)); // reserved[2]
    w.writeF64(48000);
    w.writeU32(1); w.writeU32(32);
    w.writeU32(0); w.writeU32(0); // format flags / reserved
  });
  const e = parseSampleEntry('mp4a', new ByteStream(entryBytes, 0));
  assert.equal(e.version, 2);
  assert.equal(e.channelCount, 1);
  assert.equal(e.sampleSize, 32);
  assert.equal(e.sampleRate, 48000);
});

test('parseSampleEntry 未识别类型：raw 兜底不误解析', () => {
  const e = parseSampleEntry('tx33', new ByteStream(new Uint8Array(0), 0));
  assert.deepEqual(e, { type: 'tx33', raw: true, children: {} });
});

/* ------------------------------ parseMoov / parseTrak 头部形态 ------------------------------ */

/** 最小合法 moov 内容：仅 mvhd v0（parseMoov 要求 mvhd 存在） */
function mvhdV0() {
  const w = new ByteWriter();
  w.writeU8(0); w.writeU24(0);
  w.writeU32(0); w.writeU32(0);
  w.writeU32(600); w.writeU32(120);
  w.writeFixed16_16(1); w.writeU16(256);
  return box('mvhd', w.toUint8Array());
}

test('parseMoov：largesize（size=1）16 字节头正确剥离', () => {
  const moov = parseMoov(box64('moov', mvhdV0()));
  assert.equal(moov.mvhd.timescale, 600);
  assert.deepEqual(moov.traks, []);
});

test('parseMoov：拒绝截断或超出安全范围的 largesize', () => {
  const truncated = new Uint8Array(12);
  new DataView(truncated.buffer).setUint32(0, 1);
  truncated.set(fourcc('moov'), 4);
  assert.throws(() => parseMoov(truncated), /truncated moov largesize header/);

  const unsafe = new Uint8Array(16);
  const view = new DataView(unsafe.buffer);
  view.setUint32(0, 1);
  unsafe.set(fourcc('moov'), 4);
  view.setBigUint64(8, 1n << 60n, false);
  assert.throws(() => parseMoov(unsafe), /moov size exceeds safe range/);
});

test('parseMoov：size=0 头按容器实际长度收口', () => {
  const moov = parseMoov(box('moov', mvhdV0(), 0));
  assert.equal(moov.mvhd.timescale, 600);
});

test('parseTrak：edts → elst 嵌套扫描提取编辑列表', () => {
  const w = new ByteWriter();
  w.writeU8(0); w.writeU24(0);
  w.writeU32(1); // entry_count
  w.writeU32(1000); w.writeU32(-1024 >>> 0); // segmentDuration / mediaTime(i32)
  w.writeU16(1); w.writeU16(0); // mediaRate 1.0
  const elst = box('elst', w.toUint8Array());
  const trakBody = box('edts', elst);
  const fullTrak = box('trak', trakBody);
  const trak = parseTrak(fullTrak);
  assert.equal(trak.elst.entries.length, 1);
  assert.deepEqual(trak.elst.entries[0], {
    segmentDuration: 1000, mediaTime: -1024, mediaRateInteger: 1, mediaRateFraction: 0,
  });
});
