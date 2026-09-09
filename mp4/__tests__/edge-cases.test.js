/**
 * mp4/__tests__/edge-cases.test.js — 解析/封装边界补量套件
 * ------------------------------------------------------------
 * 覆盖三处此前未覆盖的边界：
 *  1. remuxer tfdt v1 的 8 字节基时间宽度（>2^32 ticks 往返精确）；
 *  2. elst 空编辑表（entry_count=0）的解析与构造两侧行为；
 *  3. esds 描述符链变长长度编码（非规范双字节形式 + 127/128 阈值）。
 * 只加测试不改产品代码；fixture 全部程序化生成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream, ByteWriter, usToTicks } from '../../core/src/index.js';
import { iterateBoxes, parseBoxByType, parseElst } from '../src/box-parser.js';
import {
  buildMoofMdat,
  buildEdts,
  buildEsds,
  fullBox,
  box as wrapBox,
} from '../src/box-builder.js';
import { parseMoofTracks } from '../src/demuxer.js';
import { Fmp4Remuxer } from '../src/remuxer.js';

/* ------------------------------ 小工具 ------------------------------ */

function findBox(bytes, type) {
  let found = null;
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

function findIn(bytes, parentBox, type) {
  let found = null;
  iterateBoxes(bytes, parentBox.contentStart, parentBox.end, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

/* ============================================================
 * 1. tfdt v1：基时间 8 字节宽度
 * ============================================================ */

test('remuxer tfdt v1：基时间 >2^32 ticks 时按 64 位写出且往返精确', () => {
  // 直接走 box-builder：2^32+999 必须占用高 32 位进位
  const bigTicks = 2 ** 32 + 999;
  const samples = [
    { duration: 1024, size: 4, keyframe: true, cts: 0, data: new Uint8Array(4).fill(7) },
  ];
  const { data } = buildMoofMdat({
    sequenceNumber: 0,
    trackId: 1,
    baseMediaDecodeTime: bigTicks,
    samples,
  });

  const moof = findBox(data, 'moof');
  const traf = findIn(data, moof, 'traf');
  const tfdt = findIn(data, traf, 'tfdt');

  // v1 固定 20 字节：8 头 + 4 ver/flags + 8 基时间——宽度断言的核心
  assert.equal(tfdt.size, 20, 'tfdt v1 应为 20 字节（8 字节基时间）');
  const dv = new DataView(data.buffer, data.byteOffset + tfdt.contentStart, 12);
  assert.equal(dv.getUint8(0), 1, 'version=1');
  assert.equal(dv.getUint32(4, false), Math.floor(bigTicks / 2 ** 32), '高 32 位承载进位');
  assert.equal(dv.getUint32(8, false), bigTicks % 2 ** 32, '低 32 位为余数');

  // 解析侧（parseTfdt 经 parseBoxByType 分派）与 moof 级汇总均应精确还原
  const parsed = parseBoxByType(new ByteStream(data, tfdt.contentStart, tfdt.end - tfdt.contentStart), 'tfdt');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.baseMediaDecodeTime, bigTicks);
  const frags = parseMoofTracks(data, moof.contentStart, moof.end);
  assert.equal(frags[0].baseMediaDecodeTime, bigTicks);

  // 端到端：timescale=1000 时 1 tick=1000µs，须 ≥2^32 ticks（约 49.7 天媒体时间）
  // 才会溢出 32 位；取 (2^32+999) ticks 对应的整微秒 dts。
  const dtsUs = (2 ** 32 + 999) * 1000; // 4_294_968_295_000µs，Number 精度内无损
  const remuxer = new Fmp4Remuxer();
  const seg = remuxer.createMediaSegment(
    { id: 1, type: 'video', timescale: 1000 },
    [{ timestamp: dtsUs, dts: dtsUs, duration: 40000, keyframe: true, data: new Uint8Array(16).fill(3) }],
  );
  assert.equal(seg.baseMediaDecodeTimeUs, dtsUs);
  const moof2 = findBox(seg.data, 'moof');
  const frag2 = parseMoofTracks(seg.data, moof2.contentStart, moof2.end)[0];
  assert.ok(frag2.baseMediaDecodeTime > 2 ** 32, '基准时间确已超出 32 位表示范围');
  assert.equal(frag2.baseMediaDecodeTime, usToTicks(dtsUs, 1000), 'µs→ticks 回转后仍精确');
});

/* ============================================================
 * 2. elst 空编辑表边界
 * ============================================================ */

test('elst 空编辑表：entry_count=0 解析为空数组；构造侧整体省略 edts', () => {
  // v0：仅 4 字节 entry_count
  const v0 = fullBox('elst', 0, 0, (w) => w.writeU32(0));
  const p0 = parseElst(new ByteStream(v0.subarray(8)));
  assert.deepEqual(p0.entries, [], 'v0 空表 → 空 entries');

  // v1：同样只写计数（无条目负载）
  const counter = new ByteWriter();
  counter.writeU32(0);
  const v1 = fullBox('elst', 1, 0, (w) => w.writeRaw(counter.toUint8Array()));
  const p1 = parseElst(new ByteStream(v1.subarray(8)));
  assert.deepEqual(p1.entries, [], 'v1 空表 → 空 entries');
  assert.deepEqual(Object.keys(p1), ['entries'], '空表不应产生多余字段');

  // 构造侧契约：entries 为空的编辑表没有信息量，edts 作为可选 box 应整体省略
  assert.equal(buildEdts({ entries: [] }), null, '空 entries 时 buildEdts 返回 null');

  // 手工把空 elst 包进 edts 再遍历：容器嵌套不受空表影响
  const edts = wrapBox('edts', (w) => w.writeRaw(v0));
  const children = [];
  iterateBoxes(edts, 8, edts.byteLength, (h) => children.push(h));
  assert.deepEqual(children.map((h) => h.type), ['elst']);
  const inner = parseElst(new ByteStream(edts, children[0].contentStart, children[0].end - children[0].contentStart));
  assert.deepEqual(inner.entries, []);
});

/* ============================================================
 * 3. esds 描述符链长度边界
 * ============================================================ */

/** MPEG-4 描述符：tag + 变长长度 + 载荷。forceTwoByte 强制非规范双字节形式 */
function descBytes(tag, payload, forceTwoByte = false) {
  const len = payload.length;
  const lenBytes = forceTwoByte
    ? [0x80 | ((len >> 7) & 0x7f), len & 0x7f]
    : len < 128
      ? [len]
      : [0x80 | (len >> 7), len & 0x7f];
  const out = new Uint8Array(1 + lenBytes.length + len);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(payload, 1 + lenBytes.length);
  return out;
}

/** 组一条 ES>DCD>DSI 描述符链字节（oti=AAC，streamType=5 audio） */
function buildDescriptorChain(dsiPayload, { forceTwoByte = false } = {}) {
  const dsi = descBytes(0x05, dsiPayload, forceTwoByte);
  const dcdBody = new Uint8Array([
    0x40,         // objectTypeIndication：AAC
    (5 << 2) | 1, // streamType=5（audio）+ upStream/reserved 位
    0, 0, 0,      // bufferSizeDB
    0, 0, 0, 0,   // maxBitrate（本套件聚焦长度边界，不断言比特率语义）
    0, 0, 0, 0,   // avgBitrate
    ...dsi,
  ]);
  const dcd = descBytes(0x04, dcdBody, forceTwoByte);
  const esBody = new Uint8Array([0x00, 0x01, 0x00, ...dcd]); // ES_ID=1 + flags=0
  return descBytes(0x03, esBody, forceTwoByte);
}

test('esds 描述符链：非规范双字节长度可解析，127/128 阈值完整取回 ASC', () => {
  const asc = new Uint8Array([0x12, 0x10]);

  // 非规范形式：所有长度都用「续位 + 补零」的双字节编码（部分封装器会这么写）
  const chain = buildDescriptorChain(asc, { forceTwoByte: true });
  const esdsBox = fullBox('esds', 0, 0, (w) => w.writeRaw(chain));
  const out = parseBoxByType(new ByteStream(esdsBox.subarray(8)), 'esds');
  assert.equal(out.objectTypeIndication, 0x40);
  assert.equal(out.streamType, 5);
  assert.ok(out.audioSpecificConfig, '冗余续位长度编码下仍必须取出 ASC');
  assert.deepEqual([...out.audioSpecificConfig], [...asc]);

  // 127 → 单字节长度；128 → 规范双字节 [0x81,0x00]：阈值两侧都须无损还原
  for (const n of [127, 128]) {
    const padded = new Uint8Array(n);
    padded.set(asc, 0);
    const raw = buildDescriptorChain(padded);
    const bx = fullBox('esds', 0, 0, (w) => w.writeRaw(raw));
    const got = parseBoxByType(new ByteStream(bx.subarray(8)), 'esds').audioSpecificConfig;
    assert.ok(got, `DSI ${n} 字节应能取出`);
    assert.equal(got.length, n, `DSI ${n} 字节须完整取回`);
    assert.equal(got[0], 0x12);
    assert.equal(got[got.length - 1], 0);
  }

  // 对照组：模块自带构造器（单字节长度）产物同样可解析回同一 ASC
  const built = buildEsds(asc);
  const rt = parseBoxByType(new ByteStream(built.subarray(8)), 'esds');
  assert.deepEqual([...rt.audioSpecificConfig], [...asc]);
  assert.equal(rt.objectTypeIndication, 0x40);
});
