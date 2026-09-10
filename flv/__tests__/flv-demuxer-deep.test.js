/**
 * flv-demuxer 深化补测（flv 第九十波之后的新增面）
 *
 * 覆盖（均为此前未触达或仅浅触达的分支）：
 *   - probe 边界：null / <3 字节 / 恰好 3 字节 'FLV'
 *   - AAC ASC 序列头边角（demuxer 集成层）：mono 声道、48000 采样率、AOT=31 扩展
 *   - AVC 多 sps/pps：description 透传、spsList/ppsList 数量正确
 *   - 非官方 CodecID=12（HEVC）传统路径解析
 *   - AAC 裸帧先于序列头 / 视频 coded 帧先于序列头 → 触发 error 事件
 *   - PreviousTagSize 不被校验（损坏字段被忽略，解析仍正确）—— 记录为观察点
 *   - 魔数/截断/malformed：截断头、3 字节非 FLV、null → 拒绝
 *   - destroy 后写入守卫：push 不抛错、不新增样本
 *   - 非 seekable 时 getBufferedRanges 返回 []
 *   - vp09（Enhanced-FLV）配置透传、codec 留空
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer, createFlvDemuxer } from '../src/flv-demuxer.js';
import { parseAvcConfig } from '../src/codec-info.js';
import { MemoryDataSource } from '../../core/src/index.js';

import {
  flvHeader, tag, avcSequenceTag, avcVideoTag, aacSequenceTag, aacRawTag, mp3RawTag,
  buildAvcC, buildHvcC, defaultH264Sps, defaultH264Pps, toAvcc,
} from './fixtures/build-flv.mjs';

function concat(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

function u32be(v) {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff; b[1] = (v >>> 16) & 0xff; b[2] = (v >>> 8) & 0xff; b[3] = v & 0xff;
  return b;
}

/* ------------------------------ probe 边界 ------------------------------ */

test('probe：null / <3 字节返回 null；恰好 3 字节 "FLV" 命中', () => {
  assert.equal(FlvDemuxer.probe(null), null);
  assert.equal(FlvDemuxer.probe(new Uint8Array(2).fill(0x46)), null);
  const pr = FlvDemuxer.probe(new Uint8Array([0x46, 0x4c, 0x56]));
  assert.ok(pr && pr.container === 'flv' && pr.confidence >= 0.8);
});

/* ------------------------------ AAC ASC 边角（集成层） ------------------------------ */

test('demuxer：mono AAC（channels=1）→ numberOfChannels=1、codec=mp4a.40.2', async () => {
  const asc = Uint8Array.from([0x12, 0x08]); // AOT=2 LC, freqIdx=4(44.1k), channels=1
  const file = concat([
    flvHeader({ hasAudio: true, hasVideo: false }),
    aacSequenceTag(asc, 0),
    aacRawTag(new Uint8Array(16), 23),
  ]);
  const d = await createFlvDemuxer(file);
  const a = d.tracks.find((t) => t.type === 'audio');
  assert.equal(a.numberOfChannels, 1, '单声道应解析为 1 声道');
  assert.equal(a.sampleRate, 44100);
  assert.equal(a.codec, 'mp4a.40.2');
  await d.destroy();
});

test('demuxer：48000 采样率立体声 → sampleRate=48000', async () => {
  const asc = Uint8Array.from([0x11, 0x90]); // AOT=2, freqIdx=3(48k), channels=2
  const file = concat([
    flvHeader({ hasAudio: true, hasVideo: false }),
    aacSequenceTag(asc, 0),
    aacRawTag(new Uint8Array(16), 23),
  ]);
  const d = await createFlvDemuxer(file);
  const a = d.tracks.find((t) => t.type === 'audio');
  assert.equal(a.sampleRate, 48000, 'freqIdx=3 → 48000');
  await d.destroy();
});

test('demuxer：AAC AOT=31 扩展位 → 正确解析扩展 AOT 编号', async () => {
  // 位布局（19bit）：aot=11111(31) → 扩展 6bit=000001(1) → aot=32+1=33；freqIdx=0100(4)；channels=0010(2)
  const asc = Uint8Array.from([0xf8, 0x28, 0x40]);
  const file = concat([
    flvHeader({ hasAudio: true, hasVideo: false }),
    aacSequenceTag(asc, 0),
    aacRawTag(new Uint8Array(16), 23),
  ]);
  const d = await createFlvDemuxer(file);
  const a = d.tracks.find((t) => t.type === 'audio');
  assert.equal(a.sampleRate, 44100);
  assert.equal(a.numberOfChannels, 2);
  assert.ok(a.codec.startsWith('mp4a'), '扩展 AOT 经 aacCodecStringFromAsc 生成 mp4a.xx codec string');
  await d.destroy();
});

/* ------------------------------ AVC 多 sps/pps ------------------------------ */

function buildAvcCMultiSpsPps() {
  const sps1 = Uint8Array.from([0x67, 1, 2, 3, 4, 5]);
  const sps2 = Uint8Array.from([0x67, 6, 7, 8, 9]);
  const pps1 = Uint8Array.from([0x68, 1, 2, 3]);
  const pps2 = Uint8Array.from([0x68, 4, 5, 6]);
  const out = [1, 66, 0xc0, 30, 0xff, 0xe2]; // 2 SPS
  out.push((sps1.length >> 8) & 0xff, sps1.length & 0xff, ...sps1);
  out.push((sps2.length >> 8) & 0xff, sps2.length & 0xff, ...sps2);
  out.push(0x02); // 2 PPS
  out.push((pps1.length >> 8) & 0xff, pps1.length & 0xff, ...pps1);
  out.push((pps2.length >> 8) & 0xff, pps2.length & 0xff, ...pps2);
  return Uint8Array.from(out);
}

test('demuxer：AVC 多 sps/pps 序列头 → description 透传且 spsList/ppsList 数量正确', async () => {
  const avcC = buildAvcCMultiSpsPps();
  const file = concat([
    flvHeader({ hasVideo: true, hasAudio: false }),
    avcSequenceTag(avcC, 0),
    avcVideoTag(true, toAvcc([defaultH264Sps(), defaultH264Pps(), new Uint8Array([0x65, 1, 2, 3])]), 0),
  ]);
  const d = await createFlvDemuxer(file);
  const v = d.tracks.find((t) => t.type === 'video');
  assert.deepEqual([...v.description], [...avcC], 'avcC 应原样透传为 description');
  const info = parseAvcConfig(v.description);
  assert.equal(info.spsList.length, 2, '应解析出 2 个 SPS');
  assert.equal(info.ppsList.length, 2, '应解析出 2 个 PPS');
  await d.destroy();
});

/* ------------------------------ 非官方 CodecID=12 HEVC ------------------------------ */

test('demuxer：传统路径 CodecID=12（非官方 HEVC）→ 识别为 hevc 轨', async () => {
  const vps = new Uint8Array([0x40, 0x01]);
  const sps = new Uint8Array([0x42, 0x01, 0xaa]);
  const pps = new Uint8Array([0x44, 0x01]);
  const hvcC = buildHvcC(vps, sps, pps);
  // frameType=0x1c → frameType=1 关键帧 + 低 4 位 CodecID=12；AVCPacketType=0 序列头；body=hvcC
  const seqTag = tag(9, concat([Uint8Array.from([0x1c, 0x00, 0x00, 0x00, 0x00]), hvcC]), 0);
  const file = concat([flvHeader({ hasVideo: true, hasAudio: false }), seqTag]);
  const d = await createFlvDemuxer(file);
  const v = d.tracks.find((t) => t.type === 'video');
  assert.ok(v, '应识别出 HEVC 轨');
  assert.ok(v.codec.startsWith('hvc1'), `应生成 hvc1 codec string，实际 ${v.codec}`);
  assert.ok(v.description instanceof Uint8Array, '配置透传');
  await d.destroy();
});

/* ------------------------------ 缺序列头的 error 事件 ------------------------------ */

test('demuxer：AAC 裸帧先于序列头 → 触发 "未收到 AAC 序列头" error', async () => {
  const file = concat([
    flvHeader({ hasAudio: true, hasVideo: false }),
    aacRawTag(new Uint8Array(16), 0), // 裸帧在前，无序列头
  ]);
  const d = new FlvDemuxer(new MemoryDataSource(file));
  const errors = [];
  d.on('error', (e) => errors.push(e.message));
  // 缺序列头 → 无可用轨道配置 → open 以 PARSE_ERROR 拒绝；错误事件先于拒绝触发
  await assert.rejects(() => d.open(), (e) => e.code === 'PARSE_ERROR');
  assert.ok(errors.some((m) => m.includes('未收到 AAC 序列头')), errors.join('|'));
  await d.destroy();
});

test('demuxer：视频 coded 帧先于序列头 → 触发 "未收到视频序列头" error', async () => {
  const file = concat([
    flvHeader({ hasVideo: true, hasAudio: false }),
    avcVideoTag(true, toAvcc([new Uint8Array([0x65, 1, 2, 3])]), 0), // 无序列头
  ]);
  const d = new FlvDemuxer(new MemoryDataSource(file));
  const errors = [];
  d.on('error', (e) => errors.push(e.message));
  await assert.rejects(() => d.open(), (e) => e.code === 'PARSE_ERROR');
  assert.ok(errors.some((m) => m.includes('未收到视频序列头')), errors.join('|'));
  await d.destroy();
});

/* ------------------------------ PreviousTagSize 不被校验 ------------------------------ */

function setPrev(tagBytes, wrong) {
  return concat([tagBytes.subarray(0, tagBytes.length - 4), u32be(wrong)]);
}

test('demuxer：PreviousTagSize 字段损坏被忽略，解析仍正确产出全部样本', async () => {
  const avcC = buildAvcC(defaultH264Sps(), defaultH264Pps());
  const seq = avcSequenceTag(avcC, 0);
  const f1 = setPrev(avcVideoTag(true, toAvcc([defaultH264Sps(), defaultH264Pps(), new Uint8Array([0x65, 1, 2, 3])]), 33), 7777);
  const f2 = setPrev(avcVideoTag(false, toAvcc([new Uint8Array([0x41, 9])]), 66), 8888);
  const file = concat([flvHeader({ hasVideo: true, hasAudio: false }), seq, f1, f2]);
  const d = await createFlvDemuxer(file);
  assert.equal(d.mediaInfo.seekable, true);
  const vs = [];
  for await (const s of d.samples(1)) vs.push(s);
  assert.equal(vs.length, 2, '两个 coded 帧都应被解析（PreviousTagSize 未参与分帧）');
  await d.destroy();
});

/* ------------------------------ 魔数/截断/malformed ------------------------------ */

test('demuxer：截断头（仅 5 字节）open 拒绝（PARSE_ERROR）', async () => {
  const file = new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x05]); // 'FLV' + version + flags，无 DataOffset
  await assert.rejects(
    () => createFlvDemuxer(file),
    (e) => e.code === 'PARSE_ERROR',
  );
});

test('demuxer：3 字节非 FLV → 工厂 PROBE_FAILED', async () => {
  await assert.rejects(
    () => createFlvDemuxer(new Uint8Array([0x00, 0x01, 0x02])),
    (e) => e.code === 'PROBE_FAILED',
  );
});

test('demuxer：null 输入 → 工厂 PROBE_FAILED', async () => {
  await assert.rejects(
    () => createFlvDemuxer(null),
    (e) => e.code === 'PROBE_FAILED',
  );
});

/* ------------------------------ destroy 后写入守卫 ------------------------------ */

test('demuxer：destroy 后 push() 不抛错且不新增样本', async () => {
  const file = concat([
    flvHeader({ hasVideo: true, hasAudio: false }),
    avcSequenceTag(buildAvcC(defaultH264Sps(), defaultH264Pps()), 0),
    avcVideoTag(true, toAvcc([defaultH264Sps(), defaultH264Pps(), new Uint8Array([0x65, 1, 2, 3])]), 0),
  ]);
  const d = await createFlvDemuxer(file);
  let n = 0;
  for await (const s of d.samples(1)) n++;
  assert.ok(n >= 1);

  await d.destroy();
  // 销毁后继续写入不应抛错，也不会把新字节解析为样本
  assert.doesNotThrow(() => {
    d.push(new Uint8Array([
      0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0,
    ]));
  });
  // 现状守卫：销毁后 samples() 由 core/demuxer.js:_requireUsable 抛 STATE_ERROR（而非静默返回 0 个样本）
  await assert.rejects(
    async () => { for await (const s of d.samples(1)) void s; },
    (e) => e.code === 'STATE_ERROR',
    '销毁后 samples() 应抛 STATE_ERROR（state=destroyed）',
  );
});

/* ------------------------------ 非 seekable 缓冲区间 ------------------------------ */

test('demuxer：非 seekable 时 getBufferedRanges 返回 []', async () => {
  // 纯音频、无 onMetaData → seekable=false
  const file = concat([
    flvHeader({ hasAudio: true, hasVideo: false }),
    aacSequenceTag(Uint8Array.from([0x12, 0x10]), 0),
    aacRawTag(new Uint8Array(16), 0),
  ]);
  const d = await createFlvDemuxer(file);
  assert.equal(d.mediaInfo.seekable, false);
  assert.deepEqual(d.getBufferedRanges(2), [], '非 seekable 应返回空区间');
  await d.destroy();
});

/* ------------------------------ vp09 Enhanced-FLV 配置透传 ------------------------------ */

test('demuxer：Enhanced-FLV vp09 配置透传、codec 留空（禁编造 profile）', async () => {
  const fakeVp09Cfg = new Uint8Array([0x0a, 0x0b, 0x0c]);
  const tagData = Uint8Array.from([0x10, 0x76, 0x70, 0x30, 0x39, 0x00, ...fakeVp09Cfg]); // 'vp09'
  const full = concat([flvHeader({ hasVideo: true, hasAudio: false }), tag(9, tagData, 0)]);
  const d = await createFlvDemuxer(full);
  const v = d.tracks.find((t) => t.type === 'video');
  assert.ok(v, 'vp09 轨道应建立');
  assert.equal(v.description.length, fakeVp09Cfg.length, '配置透传');
  assert.equal(v.codec, '', '禁编造 profile：codec 留空');
  await d.destroy();
});
