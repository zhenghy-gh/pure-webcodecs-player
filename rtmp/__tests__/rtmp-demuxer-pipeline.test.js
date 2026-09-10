/**
 * FlvDemuxer 正向管线补测（多 Tag 连续喂入、跨 push 边界的半包组装、音视频交错、
 * EOS 统计、字段/顺序边界）。全部使用程序化构造的 FLV 字节，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer } from '../src/flv-demuxer.js';
import { flvFileHeader, serializeTag, makeAvcC } from '../../samples/gateway/src/index.js';

function join(...parts) {
  const ps = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const len = ps.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 双标志 FLV 头（hasAudio|hasVideo） */
function headerBothFlags() {
  const h = Uint8Array.from(flvFileHeader());
  h[4] = 0x05; // audio(0x04) | video(0x01)
  return h;
}

const AVC_SEQ = () => join(Uint8Array.from([0x17, 0, 0, 0, 0]), makeAvcC());
/** 单 NALU 的 AVCC 载荷（长度前缀 + NAL），可指定大小以模拟大 Tag */
function avcNalu(size = 2, keyframe = false, cts = 0) {
  const nal = new Uint8Array(Math.max(size, 1));
  nal[0] = 0x65;
  for (let i = 1; i < nal.length; i++) nal[i] = i & 0xff;
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, nal.length);
  const first = keyframe ? 0x17 : 0x27;
  return join(
    Uint8Array.from([first, 1, (cts >> 16) & 0xff, (cts >> 8) & 0xff, cts & 0xff]),
    len,
    nal,
  );
}

const AAC_SEQ = () => Uint8Array.from([0xaf, 0, 0x12, 0x10]);
const AAC_FRAME = (b) => Uint8Array.from([0xaf, 1, b, 0x10, 0x05]);

function collect(opts) {
  const d = new FlvDemuxer(opts);
  const got = { header: null, metadata: [], tracks: [], samples: [], errors: [], warns: [], done: null };
  d.on('header', (h) => (got.header = h));
  d.on('metadata', (m) => got.metadata.push(m));
  d.on('track', (t) => got.tracks.push(t));
  d.on('sample', (s) => got.samples.push(s));
  d.on('error', (e) => got.errors.push(e));
  d.on('warn', (w) => got.warns.push(w));
  d.on('done', (i) => (got.done = i));
  return { d, got };
}

test('双标志 FLV 头：hasAudio/hasVideo 同时为真并上报 version', () => {
  const { d, got } = collect();
  d.push(headerBothFlags());
  assert.equal(got.header.hasAudio, true);
  assert.equal(got.header.hasVideo, true);
  assert.equal(got.header.version, 1, 'version 取自头部第 4 字节');
  d.flush();
});

test('空 push 为 no-op：不改变缓冲、不报错', () => {
  const { d, got } = collect();
  d.push(new Uint8Array(0));
  assert.equal(d.buffer.length, 0);
  assert.equal(got.errors.length, 0);
  d.push(Uint8Array.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9]));
  d.push(new Uint8Array(0));
  assert.equal(got.header, null, '头部不足 13 字节不应产出 header');
  d.flush();
});

test('大 Tag（约 20KB NALU）跨三次不均等 push：组装结果与整块喂入逐字段一致', () => {
  const big = avcNalu(20_000, true);
  const stream = join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, 40, big));

  const one = collect();
  one.d.push(stream);
  one.d.flush();

  const split = collect();
  const a = 7;          // 落在 Tag 头内
  const b = 15_000;     // 落在 Tag 体中部
  split.d.push(stream.subarray(0, a));
  split.d.push(stream.subarray(a, b));
  split.d.push(stream.subarray(b));

  assert.equal(split.got.samples.length, 1);
  assert.equal(split.got.samples[0].data.length, one.got.samples[0].data.length);
  assert.deepEqual(Array.from(split.got.samples[0].data), Array.from(one.got.samples[0].data));
  assert.equal(split.got.samples[0].dtsUs, 40_000);
  assert.equal(split.got.samples[0].keyframe, true);
  assert.equal(split.got.errors.length, 0);
});

test('音视频交错连续喂入：样本按 Tag 顺序保留各自 kind/时间戳', () => {
  const stream = join(
    headerBothFlags(),
    serializeTag(9, 0, AVC_SEQ()),
    serializeTag(8, 0, AAC_SEQ()),
    serializeTag(9, 0, avcNalu(2, true)),
    serializeTag(8, 10, AAC_FRAME(0x21)),
    serializeTag(9, 20, avcNalu(2, false)),
    serializeTag(8, 30, AAC_FRAME(0x22)),
  );
  const { d, got } = collect();
  // 逐字节喂入，验证交错流跨边界组装的稳定性
  for (const byte of stream) d.push(Uint8Array.of(byte));
  d.flush();

  assert.equal(got.tracks.length, 2, '应先建视频轨再建音频轨');
  assert.deepEqual(got.samples.map((s) => s.kind), ['video', 'audio', 'video', 'audio']);
  assert.deepEqual(got.samples.map((s) => s.dtsUs), [0, 10_000, 20_000, 30_000]);
  assert.deepEqual(Array.from(got.samples[1].data), [0x21, 0x10, 0x05], 'AAC 应剥 2 字节帧头');
});

test('音频帧先于 AAC 序列头到达 → 丢弃（不出样本）', () => {
  const { d, got } = collect();
  d.push(join(headerBothFlags(), serializeTag(8, 0, AAC_FRAME(0x21))));
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.tracks.length, 0, '未收 ASC 不建轨');
});

test('AVC 头长度不足（1~4 字节）→ 静默忽略，不报错', () => {
  const { d, got } = collect();
  d.push(join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, 30, Uint8Array.from([0x17, 1, 0]))));
  d.push(serializeTag(9, 60, Uint8Array.from([0x17]))); // 仅 1 字节（<1 分支外）
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.errors.length, 0);
});

test('AAC 帧长度不足（仅 1 字节）→ 静默忽略', () => {
  const { d, got } = collect();
  d.push(join(headerBothFlags(), serializeTag(8, 0, AAC_SEQ()), serializeTag(8, 5, Uint8Array.from([0xaf]))));
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.errors.length, 0);
});

test('metadata 先于视频轨：宽高记录在 metadata，不回溯填充后建轨（顺序语义）', () => {
  const enc = new TextEncoder();
  const name = enc.encode('onMetaData');
  const key = enc.encode('width');
  const val = new Uint8Array(9);
  val[0] = 0x00;
  new DataView(val.buffer).setFloat64(1, 1024);
  const script = join(
    Uint8Array.from([0x02, 0x00, name.length]), name,
    Uint8Array.from([0x08, 0, 0, 0, 1, 0, key.length]), key, val,
    Uint8Array.from([0x00, 0x00, 0x09]),
  );
  const { d, got } = collect();
  d.push(join(flvFileHeader(), serializeTag(18, 0, script), serializeTag(9, 0, AVC_SEQ())));
  d.flush();

  assert.equal(got.metadata[0].width, 1024);
  const video = got.tracks.find((t) => t.kind === 'video');
  assert.equal(video.width, null, 'metadata 早于建轨时不回溯填充（仅 script 解析时回填）');
  assert.deepEqual(got.tracks.map((t) => t.kind), ['video']);
});

test('EOS(flush)：done 事件上报累计样本数，且队列内不完整尾 Tag 被丢弃', () => {
  const stream = join(
    flvFileHeader(),
    serializeTag(9, 0, AVC_SEQ()),
    serializeTag(9, 0, avcNalu(2, true)),
    serializeTag(9, 33, avcNalu(2)),
    serializeTag(9, 66, avcNalu(2)),
  );
  const tail = serializeTag(9, 99, avcNalu(2)).subarray(0, 6); // 不完整尾 Tag
  const { d, got } = collect();
  d.push(join(stream, tail));
  assert.equal(got.samples.length, 3);
  d.flush();
  assert.deepEqual(got.done, { samples: 3 });
  assert.equal(d.buffer.length, 0);
});

test('push 接受 ArrayBuffer（非 Uint8Array）输入', () => {
  const stream = join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, 0, avcNalu(2, true)));
  const { d, got } = collect();
  d.push(stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.byteLength));
  d.flush();
  assert.equal(got.samples.length, 1);
  assert.equal(got.header.hasVideo, true);
});
