/**
 * cmaf box 字节级 / 结构解析补充单测：
 *  - readBoxHeader（普通 / largesize / 截断 / size=0 到文件尾 / 非法尺寸抛错）；
 *  - boxType / iterateBoxes / findBox / findTagInBuf；
 *  - parseTrun（v0 无 cts / v1 有符号 cts）、parseTfdt（v0/v1）、parseMfhd；
 *  - isKeyframeFlag 真值表；probe 异常输入。
 *
 * 全部为零依赖、零浏览器的字节构造与校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import {
  boxType,
  readBoxHeader,
  iterateBoxes,
  findBox,
  findTagInBuf,
  parseTrun,
  parseTfdt,
  parseMfhd,
  isKeyframeFlag,
  findAudioSpecificConfig,
} from '../src/isobmff.js';
import { probe } from '../src/chunk-parser.js';

/* ---------------- readBoxHeader / boxType ---------------- */

function makeBox(type, payloadLen) {
  const out = new Uint8Array(8 + payloadLen);
  new DataView(out.buffer).setUint32(0, 8 + payloadLen);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  return out;
}

test('findAudioSpecificConfig：esds 中没有合法 DSI 时返回 null', () => {
  const esds = new Uint8Array([0, 0, 0, 10, 0x65, 0x73, 0x64, 0x73, 0x06, 0x01]);
  assert.equal(findAudioSpecificConfig(esds), null);
});

test('findAudioSpecificConfig：DSI 声明长度超过剩余数据时返回 null', () => {
  const esds = new Uint8Array([
    0, 0, 0, 12, 0x65, 0x73, 0x64, 0x73,
    0x05, 0x04, 0x12, 0x10,
  ]);
  assert.equal(findAudioSpecificConfig(esds), null);
});

test('findAudioSpecificConfig：只接受 DecoderConfig 中的 DSI 描述符', () => {
  const esds = new Uint8Array([
    0, 0, 0, 39, 0x65, 0x73, 0x64, 0x73, 0, 0, 0, 0,
    0x03, 25, 0x05, 0x02, 0, 0x04, 17,
    0x40, 0x15, 0, 0, 0, 0x05, 0x02, 0xaa, 0xbb, 0, 0, 0, 0,
    0x05, 0x02, 0x12, 0x10, 0x06, 1, 2,
  ]);
  assert.deepEqual([...findAudioSpecificConfig(esds)], [0x12, 0x10]);
});

test('findAudioSpecificConfig：跳过 ES_Descriptor 的可选字段', () => {
  const esds = new Uint8Array([
    0, 0, 0, 46, 0x65, 0x73, 0x64, 0x73, 0, 0, 0, 0,
    0x03, 32, 0, 1, 0xe0, 0, 2, 2, 0x78, 0x79, 0, 3,
    0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x05, 0x02, 0x12, 0x10, 0x06, 1, 2,
  ]);
  assert.deepEqual([...findAudioSpecificConfig(esds)], [0x12, 0x10]);
});

test('findAudioSpecificConfig：不从 moov 外的顶层伪造 esds 提取 ASC', () => {
  const videoInit = fmp4.buildInit([{
    id: 1, type: 'video', codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    width: 64, height: 36, timescale: 90000,
  }]);
  const fakeEsds = new Uint8Array([
    0, 0, 0, 39, 0x65, 0x73, 0x64, 0x73, 0, 0, 0, 0,
    0x03, 25, 0x05, 0x02, 0, 0x04, 17,
    0x40, 0x15, 0, 0, 0, 0x05, 0x02, 0xaa, 0xbb, 0, 0, 0, 0,
    0x05, 0x02, 0x12, 0x10, 0x06, 1, 2,
  ]);
  const input = new Uint8Array(videoInit.length + fakeEsds.length);
  input.set(videoInit);
  input.set(fakeEsds, videoInit.length);
  assert.equal(findAudioSpecificConfig(input), null, 'top-level fake esds must not become audio config');
});

test('findAudioSpecificConfig：不从视频 avcC 嵌入的伪造 esds 提取 ASC', () => {
  const embeddedFakeEsds = new Uint8Array([
    0, 0, 0, 39, 0x65, 0x73, 0x64, 0x73, 0, 0, 0, 0,
    0x03, 25, 0x05, 0x02, 0, 0x04, 17,
    0x40, 0x15, 0, 0, 0, 0x05, 0x02, 0xaa, 0xbb, 0, 0, 0, 0,
    0x05, 0x02, 0x12, 0x10, 0x06, 1, 2,
  ]);
  const videoInit = fmp4.buildInit([{
    id: 1, type: 'video', codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: embeddedFakeEsds },
    width: 64, height: 36, timescale: 90000,
  }]);
  assert.equal(findAudioSpecificConfig(videoInit), null, 'video sample entry payload is not an audio config box');
});

test('findAudioSpecificConfig：不跨 esds 后续盒误识别 ASC', () => {
  const esds = new Uint8Array([0, 0, 0, 10, 0x65, 0x73, 0x64, 0x73, 0x06, 0x01]);
  const free = new Uint8Array([0, 0, 0, 12, 0x66, 0x72, 0x65, 0x65, 0x05, 0x02, 0x12, 0x10]);
  const init = new Uint8Array(esds.length + free.length);
  init.set(esds);
  init.set(free, esds.length);
  assert.equal(findAudioSpecificConfig(init), null);
});

test('readBoxHeader：普通盒类型/尺寸/头长', () => {
  const b = makeBox('ftyp', 8);
  const h = readBoxHeader(b, 0);
  assert.equal(h.type, 'ftyp');
  assert.equal(h.size, 16);
  assert.equal(h.headerSize, 8);
  assert.equal(boxType(b, 0), 'ftyp');
});

test('readBoxHeader：largesize（size=1 → 64bit）', () => {
  const out = new Uint8Array(24); // 16 头 + 8 载荷
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1);
  out.set([0x6d, 0x64, 0x61, 0x74], 4); // mdat
  dv.setBigUint64(8, 24n);
  const h = readBoxHeader(out, 0);
  assert.equal(h.headerSize, 16);
  assert.equal(h.size, 24);
});

test('readBoxHeader：截断返回 null（不足 8 字节 / largesize 声明但不够 16）', () => {
  assert.equal(readBoxHeader(new Uint8Array(4), 0), null);
  const partial = new Uint8Array(12);
  new DataView(partial.buffer).setUint32(0, 1); // 声称 largesize 但仅 12 字节
  assert.equal(readBoxHeader(partial, 0), null);
});

test('readBoxHeader：size=0 表示到文件尾', () => {
  const buf = new Uint8Array(100);
  new DataView(buf.buffer).setUint32(0, 0); // size=0
  const h = readBoxHeader(buf, 0);
  assert.equal(h.size, 100, 'size=0 应解释为到缓冲末尾');
});

test('readBoxHeader：非法尺寸（< 头长）抛 NOT_SUPPORTED', () => {
  const bad = new Uint8Array(16);
  new DataView(bad.buffer).setUint32(0, 4); // 4 < 8
  bad.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.throws(() => readBoxHeader(bad, 0), (e) => e.code === 'NOT_SUPPORTED');
});

test('readBoxHeader：负数、分数与非数偏移稳定拒绝，末尾不足仍返回 null', () => {
  const bytes = new Uint8Array(8);
  for (const off of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => readBoxHeader(bytes, off), (err) => err.code === 'NOT_SUPPORTED');
  }
  assert.equal(readBoxHeader(bytes, bytes.length + 1), null);
});

test('iterateBoxes：起止范围非法时拒绝', () => {
  const bytes = new Uint8Array(8);
  assert.throws(() => [...iterateBoxes(bytes, -1, 8)], (err) => err.code === 'NOT_SUPPORTED');
  assert.throws(() => [...iterateBoxes(bytes, 4, 3)], (err) => err.code === 'NOT_SUPPORTED');
  assert.throws(() => [...iterateBoxes(bytes, 0, 9)], (err) => err.code === 'NOT_SUPPORTED');
});

test('readBoxHeader：largesize 超出安全整数范围时拒绝', () => {
  const bad = new Uint8Array(16);
  const dv = new DataView(bad.buffer);
  dv.setUint32(0, 1);
  bad.set([0x6d, 0x64, 0x61, 0x74], 4);
  dv.setBigUint64(8, 0xffffffffffffffffn);
  assert.throws(() => readBoxHeader(bad), (e) => e.code === 'NOT_SUPPORTED');
});

/* ---------------- iterateBoxes / find ---------------- */

test('iterateBoxes：init 缓冲顶层顺序为 ftyp→moov', () => {
  const init = fmp4.buildInit([
    { id: 1, type: 'video', codec: 'avc1.64001f', description: { tag: 'avcC', bytes: new Uint8Array(8) }, width: 64, height: 36, timescale: 90000 },
  ]);
  const types = [...iterateBoxes(init)].map((b) => b.type);
  assert.deepEqual(types, ['ftyp', 'moov']);

  const moov = findBox(init, 0, init.length, 'moov');
  assert.ok(moov && moov.type === 'moov');
  assert.ok(findTagInBuf(init, 0, init.length, 'trak') >= 0, 'moov 内应含 trak');
});

/* ---------------- parseTrun ---------------- */

/** 手工造 trun box（standalone，vf 起点在偏移 8） */
function buildTrun(version, flags, dataOffset, rows) {
  const hasDur = flags & 0x000100, hasSize = flags & 0x000200, hasFl = flags & 0x000400, hasCts = flags & 0x000800;
  const perRow = 4 + (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFl ? 4 : 0) + (hasCts ? 4 : 0);
  const body = 4 /*sampleCount*/ + (flags & 0x000001 ? 4 : 0) + rows.length * perRow;
  const total = 8 + 4 + body;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  out.set([0x74, 0x72, 0x75, 0x6e], 4); // trun
  out[8] = version;
  dv.setUint8(9, (flags >> 16) & 0xff); dv.setUint8(10, (flags >> 8) & 0xff); dv.setUint8(11, flags & 0xff);
  let p = 12;
  dv.setUint32(p, rows.length); p += 4;
  if (flags & 0x000001) { dv.setInt32(p, dataOffset); p += 4; }
  for (const r of rows) {
    if (hasDur) { dv.setUint32(p, r.duration || 0); p += 4; }
    if (hasSize) { dv.setUint32(p, r.size || 0); p += 4; }
    if (hasFl) { dv.setUint32(p, r.flags || 0); p += 4; }
    if (hasCts) { if (version === 1) dv.setInt32(p, r.cts || 0); else dv.setUint32(p, r.cts || 0); p += 4; }
  }
  return out;
}

test('parseTrun：v0 无 cts，提取 duration/size/flags 与 dataOffset', () => {
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400; // dataOffset+dur+size+flags
  const box = buildTrun(0, flags, 128, [
    { duration: 3003, size: 50, flags: 0x02000000 },
    { duration: 3003, size: 60, flags: 0x01010000 },
  ]);
  const r = parseTrun(box, 8, box.length);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.dataOffset, 128);
  assert.equal(r.rows[0].duration, 3003);
  assert.equal(r.rows[0].size, 50);
  assert.equal(r.rows[0].flags, 0x02000000);
  assert.equal(r.rows[0].cts, 0, 'v0 无 cts 时 cts 为 0');
});

test('parseTrun：v1 有符号 cts（负 composition offset）', () => {
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const box = buildTrun(1, flags, 64, [
    { duration: 3003, size: 50, flags: 0x02000000, cts: -5 },
  ]);
  const r = parseTrun(box, 8, box.length);
  assert.equal(r.sampleCount, 1);
  assert.equal(r.rows[0].cts, -5, 'version=1 的 cts 应为有符号');
});

/* ---------------- parseTfdt / parseMfhd ---------------- */

function buildFullBox(type, version, payload) {
  const out = new Uint8Array(8 + 4 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out[8] = version;
  out.set(payload, 12);
  return out;
}

test('parseTfdt：v0(u32) 与 v1(64bit) 双版本', () => {
  const v0 = buildFullBox('tfdt', 0, (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, 4096); return b; })());
  assert.equal(parseTfdt(v0, 8), 4096);

  const v1 = buildFullBox('tfdt', 1, (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, 0x1_0000_0001n); return b; })());
  assert.equal(parseTfdt(v1, 8), 0x1_0000_0001);
});

test('parseTfdt：box content 截断与不支持的 version 均拒绝', () => {
  const v1 = buildFullBox('tfdt', 1, new Uint8Array(8));
  assert.throws(() => parseTfdt(v1, 8, v1.length - 4), (err) => err.code === 'NOT_SUPPORTED');
  const unsupported = buildFullBox('tfdt', 2, new Uint8Array(8));
  assert.throws(() => parseTfdt(unsupported, 8, unsupported.length), (err) => err.code === 'NOT_SUPPORTED');
});

test('parseMfhd：sequenceNumber 解析', () => {
  const box = buildFullBox('mfhd', 0, (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, 77); return b; })());
  assert.equal(parseMfhd(box, 8), 77);
});

test('parseMfhd：截断的 sequence_number 与未知 version 拒绝', () => {
  const box = buildFullBox('mfhd', 0, new Uint8Array([0, 0]));
  assert.throws(() => parseMfhd(box, 8, box.length), (err) => err.code === 'NOT_SUPPORTED');
  const unsupported = buildFullBox('mfhd', 1, new Uint8Array(4));
  assert.throws(() => parseMfhd(unsupported, 8, unsupported.length), (err) => err.code === 'NOT_SUPPORTED');
});

/* ---------------- isKeyframeFlag 真值表 ---------------- */

test('isKeyframeFlag：sample_depends_on / non-sync 真值表', () => {
  assert.equal(isKeyframeFlag(0x02000000), true, 'depends_on=2 → 关键帧');
  assert.equal(isKeyframeFlag(0x01010000), false, 'depends_on=1 且 non-sync=1 → 非关键帧');
  assert.equal(isKeyframeFlag(0x01000000), true, 'depends_on=1 但 non-sync=0 → 同步样本(关键帧)');
  assert.equal(isKeyframeFlag(0x00000000), true, 'depends_on=0 且 non-sync=0 → 视为同步样本');
  assert.equal(isKeyframeFlag(0x00010000), false, 'depends_on=0 且 non-sync=1 → 非同步(非关键)');
});

/* ---------------- probe 异常输入 ---------------- */

test('probe：null/undefined/过短/非 CMAF 字节均返回 null', () => {
  assert.equal(probe(null), null);
  assert.equal(probe(undefined), null);
  assert.equal(probe(new Uint8Array(8)), null, '<12B 返回 null');
  const notCmaf = new Uint8Array(16);
  notCmaf.set([0x66, 0x72, 0x65, 0x65], 4); // 'free' 非 ftyp/styp
  assert.equal(probe(notCmaf), null);
});
