/**
 * FlvDemuxer 深度补测（纯逻辑/边界分支，零网络）。
 *
 * 聚焦 rtmp/__tests__/flv-demuxer.test.js 与 rtmp-demuxer-pipeline.test.js 未覆盖的
 * 分支：空长度音视频 Tag（data.length<1 早返回）、正/负 CTS 的 SI24 三形态、
 * 更多「不支持」编解码（codecId/SoundFormat 多值）、半包魔数嗅探的「等待」分支。
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

function collectWith(opts) {
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

const AVC_SEQ = () => join(Uint8Array.from([0x17, 0, 0, 0, 0]), makeAvcC());
/** ctsBytes 大端 3 字节；可传 0 / 正数 / 0xffffff（负） */
const AVC_NALU = (ctsBytes = 0) =>
  Uint8Array.from([
    0x17, 1,
    (ctsBytes >> 16) & 0xff,
    (ctsBytes >> 8) & 0xff,
    ctsBytes & 0xff,
    0x00, 0x00, 0x00, 0x02, 0x65, 0x88,
  ]);

test('空长度视频 Tag（data.length=0）→ 静默忽略，不出样本、不报错', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(9, 0, new Uint8Array(0))));
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.errors.length, 0, '0 字节视频 Tag 不应抛错');
});

test('空长度音频 Tag（data.length=0）→ 静默忽略', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(8, 0, new Uint8Array(0))));
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.errors.length, 0);
});

test('cts 为正（SI24 高位非符号位）→ ptsUs 早于 dtsUs 之后（dts + cts）', () => {
  const { d, got } = collectWith();
  // 两个样本：cts=256ms（0x000100）与 cts=4095ms（0x000fff）
  d.push(join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, 0, AVC_NALU(0x000100)), serializeTag(9, 1000, AVC_NALU(0x000fff))));
  d.flush();
  assert.equal(got.samples.length, 2);
  assert.equal(got.samples[0].dtsUs, 0);
  assert.equal(got.samples[0].ptsUs, 256 * 1000, '正 cts：pts = dts + 256ms');
  assert.equal(got.samples[1].dtsUs, 1000 * 1000);
  assert.equal(got.samples[1].ptsUs, 1000 * 1000 + 4095 * 1000, '大正 cts 仍按有符号正向');
  // 两者均不应触发解析错误
  assert.equal(got.errors.length, 0);
});

test('不支持的视频 codecId 多值（2/4/5/6）→ 各自 NOT_SUPPORTED 且继续解析', () => {
  const { d, got } = collectWith();
  const codecIds = [2, 4, 5, 6]; // H263 / VP6 / VP6A / ScreenVideo
  const tags = [flvFileHeader()];
  for (const cid of codecIds) {
    const first = (1 << 4) | cid; // frameType=1
    tags.push(serializeTag(9, 0, Uint8Array.from([first, 0, 0, 0, 0])));
  }
  d.push(join(...tags));
  d.flush();
  assert.equal(got.samples.length, 0);
  for (const cid of codecIds) {
    assert.ok(
      got.errors.some((e) => e.code === 'NOT_SUPPORTED' && e.message.includes(`CodecID=${cid}`)),
      `应报 CodecID=${cid}`,
    );
  }
});

test('不支持的音频 SoundFormat 多值（2/3/7/11）→ 各自 NOT_SUPPORTED', () => {
  const { d, got } = collectWith();
  const formats = [2, 3, 7, 11]; // MP3 / PCM / G711 / Speex
  const tags = [flvFileHeader()];
  for (const f of formats) {
    const first = (f << 4); // 仅取高 4 位作为 SoundFormat
    tags.push(serializeTag(8, 0, Uint8Array.from([first, 0])));
  }
  d.push(join(...tags));
  d.flush();
  assert.equal(got.samples.length, 0);
  for (const f of formats) {
    assert.ok(
      got.errors.some((e) => e.code === 'NOT_SUPPORTED' && e.message.includes(`SoundFormat=${f}`)),
      `应报 SoundFormat=${f}`,
    );
  }
});

test('半包魔数嗅探：仅 3 字节非 FLV 前缀 → 保持等待不报错（截尾前奏）', () => {
  const { d, got } = collectWith();
  d.push(Uint8Array.from([0xaa, 0xbb, 0xcc]));
  assert.equal(got.errors.length, 0, '≤3 字节且无非 FLV 魔数时不应报错');
  assert.equal(d.buffer.length, 3, '应保留这 3 字节继续等待后续字节');
  // 补齐剩余：魔力 5 字节 + 至少到达 13 字节（9B 头 + 4B prev0 仅需再 7 字节）
  d.push(Uint8Array.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 0x09, 0, 0, 0, 0]));
  assert.equal(got.header?.hasVideo, true, '补齐后成功识别出 FLV 头');
});

test('半包魔数嗅探：FLV 魔数被切断为前 2 字节 → 等待后续字节再识别', () => {
  const { d, got } = collectWith();
  d.push(Uint8Array.from([0x46, 0x4c])); // 仅 2 字节（magic 前 2）
  assert.equal(got.errors.length, 0);
  assert.equal(d.buffer.length, 2, '魔数未凑齐应继续等待');
  // 续上 0x56 + 头尾（达到 13 字节）
  d.push(Uint8Array.from([0x56, 1, 1, 0, 0, 0, 0x09, 0, 0, 0, 0]));
  assert.equal(got.header?.hasVideo, true, '魔数凑齐后应解析出头');
});
