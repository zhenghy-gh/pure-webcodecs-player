/**
 * iso-bmff.js 基础写入器与静态盒子字节布局单测
 * 覆盖：concatBytes / box / fullBox / ftyp / mvhd / tkhd / mdhd / hdlr /
 *       vmhd / smhd / dinf(dref/url) / videoSampleEntry / audioSampleEntry /
 *       空表 stbl / mvex(trex) / 容器盒尺寸闭合
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  concatBytes, box, fullBox,
  ftypBox, mvhdBox, trakBox, tkhdBox, mdiaBox, mdhdBox, hdlrBox,
  minfBox, vmhdBox, smhdBox, dinfBox, stblBox, emptyStblBoxes,
  videoSampleEntry, audioSampleEntry, mvexBox,
} from '../src/iso-bmff.js';

/** 逐层遍历顶层盒子：[{type,size,body(Uint8Array 从盒头后开始)}] */
function walk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos);
    assert.ok(size >= 8 && pos + size <= bytes.length, `盒子越界 @${pos} size=${size}`);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    out.push({ type, size, start: pos, body: bytes.subarray(pos + 8, pos + size) });
    pos += size;
  }
  assert.equal(pos, bytes.length, '盒子总长应恰好覆盖输入');
  return out;
}

function findBox(bytes, path) {
  let cur = bytes;
  for (const name of path) {
    const found = walk(cur).find((b) => b.type === name);
    if (!found) return null;
    cur = found.body;
    if (name === 'stsd') cur = cur.subarray(4 + 4);            // version/flags + entry_count
    else if (name === 'avc1' || name === 'hvc1') cur = cur.subarray(78);
    else if (name === 'mp4a') cur = cur.subarray(28);
  }
  return cur;
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

/* ------------------------------ concatBytes ------------------------------ */

test('concatBytes：单元素原样返回（同一引用），多元素按序拼接', () => {
  const a = Uint8Array.from([1, 2, 3]);
  assert.equal(concatBytes([a]), a, '单元素应返回原数组引用');

  const b = Uint8Array.from([4, 5]);
  const c = Uint8Array.from([]);
  const out = concatBytes([a, b, c]);
  assert.deepEqual([...out], [1, 2, 3, 4, 5]);
  assert.notEqual(out, a, '多元素必须产生新数组');
});

test('concatBytes：空列表产出空 Uint8Array', () => {
  const out = concatBytes([]);
  assert.equal(out.length, 0);
  assert.ok(out instanceof Uint8Array);
});

/* --------------------------- box / fullBox 基元 --------------------------- */

test('box：size 字段=总长、type 四字符、payload 从偏移 8 开始', () => {
  const payload = Uint8Array.from([0xaa, 0xbb, 0xcc]);
  const b = box('test', payload);
  assert.equal(b.length, 11);
  const view = new DataView(b.buffer);
  assert.equal(view.getUint32(0), 11, 'size 应等于 8+payload');
  assert.equal(ascii(b.subarray(4, 8)), 'test');
  assert.deepEqual([...b.subarray(8)], [0xaa, 0xbb, 0xcc]);
});

test('box：空 payload 得到 8 字节空盒；多段 payload 按序拼接', () => {
  const empty = box('empt');
  assert.equal(empty.length, 8);
  assert.deepEqual([...empty.subarray(8)], []);

  const multi = box('mult', Uint8Array.from([1]), Uint8Array.from([2, 3]), Uint8Array.from([4]));
  assert.equal(multi.length, 12);
  assert.deepEqual([...multi.subarray(8)], [1, 2, 3, 4]);
});

test('fullBox：version 占 1 字节、flags 24 位大端编码', () => {
  const b = fullBox('fbox', 1, 0x020701);
  assert.equal(b.length, 12);
  assert.equal(b[8], 1, 'version');
  assert.deepEqual([...b.subarray(9, 12)], [0x02, 0x07, 0x01], 'flags 高位在前');

  const zero = fullBox('zzzz', 0, 0);
  assert.deepEqual([...zero.subarray(8, 12)], [0, 0, 0, 0]);
});

/* ------------------------------ ftyp / mvhd ------------------------------ */

test('ftypBox：major_brand=isom、minor=512、四个兼容 brand', () => {
  const f = ftypBox();
  assert.equal(f.length, 8 + 24);
  const body = f.subarray(8);
  assert.equal(ascii(body.subarray(0, 4)), 'isom');
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(4), 512);
  assert.equal(ascii(body.subarray(8, 12)), 'isom');
  assert.equal(ascii(body.subarray(12, 16)), 'iso6');
  assert.equal(ascii(body.subarray(16, 20)), 'avc1');
  assert.equal(ascii(body.subarray(20, 24)), 'mp41');
});

test('mvhdBox：v0 布局 108 字节，timescale/rate/volume/matrix/next_track_id', () => {
  const m = mvhdBox(1000);
  assert.equal(m.length, 108, '8 头 + 4 ver/flags + 96 固定体');
  const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
  assert.equal(m[8], 0, 'version=0');
  assert.equal(view.getUint32(20), 1000, 'timescale');
  assert.equal(view.getUint32(24), 0, 'duration=0（流式未知）');
  assert.equal(view.getUint32(28), 0x00010000, 'rate=1.0');
  assert.equal(view.getUint16(32), 0x0100, 'volume=1.0');
  assert.equal(view.getUint32(44), 0x00010000, 'matrix a');
  assert.equal(view.getUint32(60), 0x00010000, 'matrix d');
  assert.equal(view.getUint32(72), 0x40000000, 'matrix w');
  assert.equal(view.getUint32(104), 2, 'next_track_id');
});

/* ------------------------------ tkhd / mdhd ------------------------------ */

test('tkhdBox：flags=7、trackId、宽高 16.16 定点、音轨默认宽高为 0', () => {
  const t = tkhdBox({ trackId: 3, width: 1920, height: 1080 });
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const flags = view.getUint32(8) & 0xffffff;
  assert.equal(flags, 7, 'enabled+in_movie+in_preview');
  assert.equal(view.getUint32(20), 3, 'track_id @ ver/flags+creation+mod 之后');
  assert.equal(view.getUint32(84), 1920 * 65536, 'width 16.16');
  assert.equal(view.getUint32(88), 1080 * 65536, 'height 16.16');

  const audio = tkhdBox({ trackId: 9 });   // 无宽高 → 0
  const av = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  assert.equal(av.getUint32(84), 0);
  assert.equal(av.getUint32(88), 0);
  assert.equal(av.getUint32(20), 9);
});

test('mdhdBox：timescale 与 language=und(0x55c4)', () => {
  const m = mdhdBox(44100);
  assert.equal(m.length, 8 + 4 + 20);
  const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
  assert.equal(view.getUint32(20), 44100);
  assert.equal(view.getUint16(28), 0x55c4, "packed language 'und'");
});

/* --------------------------------- hdlr --------------------------------- */

test('hdlrBox：video→vide/VideoHandler，audio→soun/SoundHandler（含 NUL 结尾）', () => {
  const v = hdlrBox('video');
  const vBody = v.subarray(8);
  assert.equal(ascii(vBody.subarray(4, 8)), '\0\0\0\0', 'pre_defined');
  assert.equal(ascii(vBody.subarray(8, 12)), 'vide');
  assert.deepEqual([...vBody.subarray(12, 24)], new Array(12).fill(0), 'reserved 12 字节');
  assert.equal(ascii(vBody.subarray(24)), 'VideoHandler\0');

  const a = hdlrBox('audio');
  const aBody = a.subarray(8);
  assert.equal(ascii(aBody.subarray(8, 12)), 'soun');
  assert.equal(ascii(aBody.subarray(24)), 'SoundHandler\0');
});

/* --------------------------- vmhd / smhd / dinf --------------------------- */

test('vmhd flags=1、smhd flags=0，payload 均为定长零字段', () => {
  const v = vmhdBox();
  assert.equal(v.length, 8 + 4 + 8);
  assert.equal((new DataView(v.buffer).getUint32(8) & 0xffffff), 1, 'graphicsmode 盒要求 flags=1');
  assert.deepEqual([...v.subarray(12)], [0, 0, 0, 0, 0, 0, 0, 0]);

  const s = smhdBox();
  assert.equal(s.length, 8 + 4 + 4);
  assert.equal((new DataView(s.buffer).getUint32(8) & 0xffffff), 0);
  assert.deepEqual([...s.subarray(12)], [0, 0, 0, 0]);
});

test('dinfBox：dref entry_count=1，url 盒 flags=1 表示 self-contained', () => {
  const d = dinfBox();
  const dref = findBox(d, ['dinf', 'dref']);
  assert.ok(dref, 'dinf 内应有 dref');
  const view = new DataView(dref.buffer, dref.byteOffset, dref.byteLength);
  assert.equal(view.getUint32(4), 1, 'entry_count=1（version/flags 之后）');
  const url = dref.subarray(8);
  assert.equal(url.length, 12, 'url 盒：8 头 + 4 ver/flags（无 payload）');
  assert.equal(ascii(url.subarray(4, 8)), 'url ');
  assert.equal(new DataView(url.buffer, url.byteOffset).getUint32(8) & 0xffffff, 1, 'self-contained');
});

/* ----------------------------- 采样描述 entry ----------------------------- */

test('videoSampleEntry：78 字节固定体字段 + 配置盒整体追加', () => {
  const config = box('avcC', Uint8Array.from([1, 2, 3]));
  const e = videoSampleEntry('avc1', { width: 640, height: 360 }, config);
  assert.equal(e.length, 8 + 78 + config.length);
  assert.equal(ascii(e.subarray(4, 8)), 'avc1');
  const view = new DataView(e.buffer, e.byteOffset, e.byteLength);
  assert.equal(view.getUint16(8 + 6), 1, 'data_reference_index=1');
  assert.equal(view.getUint16(8 + 24), 640, 'width');
  assert.equal(view.getUint16(8 + 26), 360, 'height');
  assert.equal(view.getUint32(8 + 28), 0x00480000, 'hres 72dpi');
  assert.equal(view.getUint32(8 + 32), 0x00480000, 'vres 72dpi');
  assert.equal(view.getUint16(8 + 40), 1, 'frame_count=1');
  assert.equal(view.getUint16(8 + 74), 0x0018, 'depth=24');
  assert.equal(view.getUint16(8 + 76), 0xffff, 'pre_defined=-1');
  // 配置盒必须紧随固定体
  assert.equal(ascii(e.subarray(8 + 78 + 4, 8 + 78 + 8)), 'avcC');
});

test('audioSampleEntry：28 字节固定体、声道数、16.16 定点采样率、内嵌 esds', () => {
  const asc = Uint8Array.from([0x12, 0x10]);
  const e = audioSampleEntry(44100, 2, asc);
  assert.equal(ascii(e.subarray(4, 8)), 'mp4a');
  const view = new DataView(e.buffer, e.byteOffset, e.byteLength);
  assert.equal(view.getUint16(8 + 6), 1, 'data_reference_index=1');
  assert.equal(view.getUint16(8 + 16), 2, 'channels');
  assert.equal(view.getUint16(8 + 18), 16, 'sample_size');
  assert.equal(view.getUint32(8 + 24), (44100 << 16) >>> 0, '采样率 16.16 定点');
  const esds = e.subarray(8 + 28);
  assert.equal(ascii(esds.subarray(4, 8)), 'esds', '固定体后应紧跟 esds');
});

/* ------------------------------- 空表 stbl ------------------------------- */

test('emptyStblBoxes：五个空表 + stsd 携带 entry_count=1 与采样描述', () => {
  const entry = box('avc1', new Uint8Array(78), box('avcC', Uint8Array.from([9])));
  const boxes = emptyStblBoxes(entry);
  assert.deepEqual(boxes.map((b) => ascii(b.subarray(4, 8))), ['stts', 'stsc', 'stsz', 'stco', 'stsd']);

  assert.equal(boxes[0].length, 8 + 4 + 4, 'stts 空：entry_count=0');
  assert.equal(boxes[2].length, 8 + 4 + 8, 'stsz 空：sample_size+count=0');
  assert.equal(boxes[3].length, 8 + 4 + 4, 'stco 空');

  const stsd = boxes[4];
  const view = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
  assert.equal(view.getUint32(12), 1, 'entry_count=1');
  assert.deepEqual([...stsd.subarray(16, 16 + entry.length)], [...entry], '采样描述原样内嵌');
});

test('容器盒（trak/mdia/minf/stbl）：尺寸闭合等于子盒之和 + 8', () => {
  const entry = box('avc1', new Uint8Array(78));
  const stbl = stblBox(...emptyStblBoxes(entry));
  const children = emptyStblBoxes(entry);
  assert.equal(stbl.length, 8 + children.reduce((n, b) => n + b.length, 0));

  const trak = trakBox(tkhdBox({ trackId: 1 }), mdiaBox(mdhdBox(1000), hdlrBox('video'), minfBox(vmhdBox(), dinfBox(), stbl)));
  assert.equal(ascii(trak.subarray(4, 8)), 'trak');
  const inner = walk(trak.subarray(8));
  assert.deepEqual(inner.map((b) => b.type), ['tkhd', 'mdia']);
  assert.equal(inner[0].size + inner[1].size, trak.length - 8, '子盒长度之和闭合');
});

/* ------------------------------- mvex/trex ------------------------------- */

test('mvexBox：每轨一个 trex，字段含默认索引与可选默认值；空轨列表得空盒', () => {
  const m = mvexBox([
    { trackId: 1, defaultFlags: 0x01010000 },
    { trackId: 2, defaultDuration: 1024, defaultSize: 371 },
  ]);
  const trex1 = findBox(m, ['mvex', 'trex']);
  assert.ok(trex1, '第一个 trex');
  const view1 = new DataView(trex1.buffer, trex1.byteOffset, trex1.byteLength);
  assert.equal(view1.getUint32(4), 1, 'track_id');
  assert.equal(view1.getUint32(8), 1, 'default_sample_description_index=1');
  assert.equal(view1.getUint32(12), 0, 'default_duration 缺省 0');
  assert.equal(view1.getUint32(20), 0x01010000, 'default_flags');

  const trexes = walk(m.subarray(8));
  assert.equal(trexes.length, 2);
  assert.equal(trexes[0].size, 8 + 4 + 20, 'trex v0 固定 32 字节');
  const t2 = trexes[1].body;
  const view2 = new DataView(t2.buffer, t2.byteOffset, t2.byteLength);
  assert.equal(view2.getUint32(12), 1024, 'default_duration=1024');
  assert.equal(view2.getUint32(16), 371, 'default_size=371');
  assert.equal(view2.getUint32(20), 0, 'default_flags 缺省 0');

  const empty = mvexBox([]);
  assert.equal(empty.length, 8, '无轨道时 mvex 为空盒');
});
