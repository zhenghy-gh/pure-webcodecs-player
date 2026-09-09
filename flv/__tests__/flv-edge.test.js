/**
 * flv 边界与容错补充单测（补量单素材：AMF0 边界类型 / Enhanced-FLV FourCC 畸变 /
 * remuxer trun 回填边界）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFlvDemuxer, FlvDemuxer } from '../src/flv-demuxer.js';
import { FlvRemuxer } from '../src/fmp4-remuxer.js';
import { decodeAmf0, decodeAmf0All, encodeAmf0 } from '../src/amf0.js';
import { assembleFlv } from './fixtures/build-flv.mjs';

/* ------------------------------ AMF0 边界类型 ------------------------------ */

test('AMF0 strict-array(0x0A) 解码', () => {
  // marker + u32 count + 两个 number
  const bytes = new Uint8Array([
    0x0a, 0x00, 0x00, 0x00, 0x02,
    0x00, 0x40, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   // 3.0
    0x00, 0x40, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   // 4.0
  ]);
  const { value } = decodeAmf0(bytes);
  assert.deepEqual(value, [3, 4]);
});

test('AMF0 date(0x0B) 解码（毫秒+时区占位）', () => {
  const bytes = new Uint8Array(11);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0x0b);
  view.setFloat64(1, 1700000000000);      // epoch ms
  view.setInt16(9, -480);                 // timezone 占位
  const { value } = decodeAmf0(bytes);
  assert.ok(value instanceof Date);
  assert.equal(value.getTime(), 1700000000000);
});

test('AMF0 long-string(0x0C) 与 undefined(0x06)', () => {
  const long = 'x'.repeat(300);
  const enc = new Uint8Array([0x0c, 0x00, 0x00, 0x01, 0x2c, ...new TextEncoder().encode(long)]);
  assert.equal(decodeAmf0(enc).value.length, 300);

  const { value } = decodeAmf0(new Uint8Array([0x06]));
  assert.equal(value, undefined);
});

test('AMF0 ECMA 数组含非连续键时保留对象形态', () => {
  const meta = { weird: { '0': 'a', '2': 'c' } };    // 键不连续 → 不应折叠为数组
  const { value } = decodeAmf0(encodeAmf0(meta));
  assert.equal(typeof value.weird, 'object');
  assert.ok(!Array.isArray(value.weird));
});

/* ------------------------------ Enhanced-FLV FourCC 畸变 ------------------------------ */

function videoTag(payload, ts = 0) {
  const head = new Uint8Array(11);
  head[0] = 9;
  head[1] = (payload.length >> 16) & 0xff;
  head[2] = (payload.length >> 8) & 0xff;
  head[3] = payload.length & 0xff;
  head[4] = (ts >> 16) & 0xff; head[5] = (ts >> 8) & 0xff; head[6] = ts & 0xff;
  return new Uint8Array([...head, ...payload, ...new Uint8Array(4)]);
}

function fileWith(...tags) {
  const header = new Uint8Array([0x46, 0x4c, 0x56, 1, 0x01, 0, 0, 0, 9, 0, 0, 0, 0]);
  return new Uint8Array([...header, ...tags.flatMap((t) => [...t])]);
}

test('Enhanced-FLV：未知 FourCC 落入传统路径并报不支持 CodecID', async () => {
  // payload: frameType=1 + 'abcd'(未知) —— 不命中白名单 → 传统 CodecID=0xD 低四位=13 无效
  const payload = Uint8Array.from([0x10, 0x61, 0x62, 0x63, 0x64, 0x01, 0xaa]);
  const p = new (await import('../src/flv-parser.js')).FlvParser();
  const errors = [];
  p.on('error', (e) => errors.push(e.message));
  p.push(fileWith(videoTag(payload)));
  p.flush();
  assert.ok(errors.some((m) => m.includes('CodecID')), errors.join(';'));
});

test('Enhanced-FLV：packetType=2(end) 上报 end 事件、不产出码流', async () => {
  const p = new (await import('../src/flv-parser.js')).FlvParser();
  const log = { video: [], errors: [] };
  p.on('video', (v) => log.video.push(v));
  p.on('error', (e) => log.errors.push(e.message));
  p.push(fileWith(videoTag(Uint8Array.from([0x10, 0x68, 0x76, 0x63, 0x31, 0x02]))));
  p.flush();
  assert.deepEqual(log.video.map((v) => v.packetType), ['end']);
  assert.ok(log.video.every((v) => !v.data && !v.configBytes));
  assert.equal(log.errors.length, 0);
});

test('Enhanced-FLV av01/vp09：配置透传、codec string 留空（禁编造 profile）', async () => {
  // av01 序列头：FrameType=1(关键帧) + FourCC 'av01' + packetType=0(seq start) + AV1DecoderConfig
  const fakeAv01Cfg = new Uint8Array([0x0a, 0x0b, 0x0c]);
  const tagData = new Uint8Array([
    0x10, 0x61, 0x76, 0x30, 0x31, 0x00, ...fakeAv01Cfg,
  ]);
  const full = new Uint8Array([...fileWith(videoTag(tagData))]);
  const d = await createFlvDemuxer(full);
  const v = d.tracks.find((t) => t.type === 'video');
  assert.ok(v, 'av01 轨道应建立');
  assert.equal(v.description ? v.description.length : -1, fakeAv01Cfg.length);   // 配置透传
  assert.equal(v.codec, '');                       // 禁编造 profile：留空（契约 §3）
  await d.destroy();
});

/* ------------------------------ remuxer 回填边界 ------------------------------ */

async function remux(file, opts) {
  const d = await createFlvDemuxer(file);
  const r = new FlvRemuxer(opts);
  const inits = [];
  const segs = [];
  r.on('initSegment', (s) => inits.push(s));
  r.on('mediaSegment', (s) => segs.push(s));
  await r.drain(d);
  await d.destroy();
  return { inits, segs };
}

test('remux 边界：极小 fragmentUs 下每关键帧即切，data_offset 全部精确', async () => {
  const { inits, segs } = await remux(
    assembleFlv({ video: { frames: 12, gopSize: 3 }, audio: null }),
    { fragmentUs: 1 },
  );
  assert.equal(inits.length, 1);
  assert.ok(segs.length >= 4, `应多分片，实际 ${segs.length}`);
  for (const seg of segs) {
    const boxes = walkBoxes(seg.data);
    const moofFull = seg.data.subarray(0, boxes[0].size);
    const traf = findBox(findBox(moofFull, ['moof']), ['traf']);
    const trun = findBox(traf, ['trun']);
    const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
    assert.equal(view.getUint32(8), moofFull.length + 8);
  }
});

test('remux 边界：大 CompositionTime 正确写入 trun cts 字段', async () => {
  const file = assembleFlv({ video: { frames: 3 } });
  // 直接以 pushSample 注入大 CTS 样本验证字段宽度
  const d = await createFlvDemuxer(file);
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks(d.mediaInfo.tracks);
  const baseUs = 0;
  const bigCtsUs = 100_000;                        // 100ms 偏移（远超常见值）
  r.pushSample({
    trackId: 1, timestamp: baseUs + bigCtsUs, dts: baseUs,
    duration: 33_000, keyframe: true, data: new Uint8Array(64),
  });
  r.pushSample({
    trackId: 1, timestamp: baseUs + bigCtsUs + 33_000, dts: baseUs + 33_000,
    duration: 33_000, keyframe: false, data: new Uint8Array(48),
  });
  await r.flush();
  assert.ok(segs.length >= 1);
  const moofFull = segs[0].data.subarray(0, walkBoxes(segs[0].data)[0].size);
  const trun = findBox(findBox(moofFull, ['moof', 'traf']), ['trun']);
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const flags = view.getUint32(0) & 0xffffff;
  const hasFirstFlags = (flags & 0x004) !== 0;
  let pos = 12 + (hasFirstFlags ? 4 : 0);
  const count = view.getUint32(4);
  for (let i = 0; i < count; i++) {
    const cts = view.getUint32(pos + 8);
    assert.ok(cts >= 0 && cts <= 100_000, `cts 应在合理范围: ${cts}`);
    pos += 12;
  }
  await d.destroy();
});

test('remux reset() 后实例可复用（二次 drain）', async () => {
  const file = assembleFlv({ video: { frames: 4 }, audio: null });
  const r = new FlvRemuxer({});
  let firstCount = 0;
  r.on('mediaSegment', () => firstCount++);

  const d1 = await createFlvDemuxer(file);
  await r.drain(d1);
  await d1.destroy();
  const c1 = firstCount;

  r.reset();
  const d2 = await createFlvDemuxer(file);
  await r.drain(d2);
  await d2.destroy();
  assert.ok(c1 >= 1);
  assert.equal(r.seqNo > 1, true, 'seqNo 应跨轮累计');
});

/* ------------------------------ 工具 ------------------------------ */

function walkBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > bytes.length) throw new Error(`盒子越界 @${pos}`);
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
    if (name === 'stsd') current = current.subarray(8);
    else if (name === 'avc1' || name === 'hvc1') current = current.subarray(78);
    else if (name === 'mp4a') current = current.subarray(28);
  }
  return current;
}
