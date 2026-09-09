import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer, avcCodecString } from '../src/flv-demuxer.js';
import { FlvLoopSource, flvFileHeader, serializeTag, makeAvcC, VIDEO_FPS } from '../../samples/gateway/src/index.js';

/** 用网关构建器生成一段完整 FLV 字节流（init + n 帧） */
function buildStream(frameCount = 10) {
  const src = new FlvLoopSource({ frameCount });
  const parts = [src.initChunk(), ...src.take(frameCount)];
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function collect(frameCount = 10) {
  const d = new FlvDemuxer();
  const got = { header: null, metadata: null, tracks: [], samples: [], errors: [], done: null };
  d.on('header', (h) => (got.header = h));
  d.on('metadata', (m) => (got.metadata = m));
  d.on('track', (t) => got.tracks.push(t));
  d.on('sample', (s) => got.samples.push(s));
  d.on('error', (e) => got.errors.push(e));
  d.on('done', (info) => (got.done = info));
  return { d, got };
}

test('FLV 头解析：仅视频标志', () => {
  const { d, got } = collect();
  d.push(buildStream(4));
  d.flush();
  assert.equal(got.header.hasVideo, true);
  assert.equal(got.header.hasAudio, false);
});

test('onMetaData：AMF0 ECMA 数组字段完整', () => {
  const { d, got } = collect();
  d.push(buildStream());
  assert.ok(got.metadata, '应有 metadata');
  assert.equal(got.metadata.width, 16);
  assert.equal(got.metadata.height, 16);
  assert.equal(got.metadata.framerate, VIDEO_FPS);
  assert.equal(got.metadata.videocodecid, 7);
});

test('视频轨配置：avcC 与网关构建器一致，codec string 正确', () => {
  const { d, got } = collect();
  d.push(buildStream());
  const video = got.tracks.find((t) => t.kind === 'video');
  assert.ok(video, '应有 video track');
  assert.deepEqual(Array.from(video.description), Array.from(makeAvcC()));
  assert.equal(avcCodecString(video.description), 'avc1.42c01e');
});

test('样本流：数量正确、µs 时间基单调、关键帧标志、AVCC 形态', () => {
  const n = 12;
  const { d, got } = collect(n);
  d.push(buildStream(n));
  assert.equal(got.samples.length, n);
  // 首帧为 IDR
  assert.equal(got.samples[0].keyframe, true);
  // 时间戳：15fps → 步长 ≈66.67ms，换算 µs 后单调
  for (let i = 1; i < got.samples.length; i++) {
    assert.ok(got.samples[i].dtsUs > got.samples[i - 1].dtsUs, `dts 应严格递增 @${i}`);
    assert.equal(Number.isInteger(got.samples[i].dtsUs), true, '必须是整数微秒（§0.5）');
  }
  assert.ok(Math.abs(got.samples[1].dtsUs - Math.round((1000 / VIDEO_FPS) * 1000)) <= 1000);
  // AVCC：首 4 字节为 NAL 长度前缀，长度与数据吻合
  const first = got.samples[0].data;
  const nalLen = (first[0] << 24) | (first[1] << 16) | (first[2] << 8) | first[3];
  assert.equal(first.length, 4 + nalLen);
});

test('半包/逐字节喂入结果一致（粘包聚合逐字节等价）', () => {
  const stream = buildStream(6);
  const run = (feeder) => {
    const d = new FlvDemuxer();
    const samples = [];
    d.on('sample', (s) => samples.push(s));
    feeder(d);
    return samples;
  };
  const a = run((d) => d.push(stream));
  const b = run((d) => {
    for (const byte of stream) d.push(Uint8Array.of(byte)); // 极端半包
  });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(Array.from(a[i].data), Array.from(b[i].data));
    assert.equal(a[i].dtsUs, b[i].dtsUs);
  }
});

test('垃圾前缀自动嗅探跳过（meta 缺席场景的消费端兜底）', () => {
  const stream = buildStream(3);
  const junk = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
  const prefixed = new Uint8Array(junk.length + stream.length);
  prefixed.set(junk, 0);
  prefixed.set(stream, junk.length);

  const d = new FlvDemuxer();
  let samples = 0;
  d.on('sample', () => samples++);
  d.push(prefixed);
  d.flush();
  assert.ok(samples >= 3, `应跳过垃圾前缀后正常出样本，实际 ${samples}`);
});

test('损坏输入不抛异常：错误经事件外报且码为 PARSE_ERROR', () => {
  const d = new FlvDemuxer();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.push(flvFileHeader());
  // 构造一个声明超大 data 的 Tag 头
  d.push(serializeTag(9, 0, new Uint8Array(4)).subarray(0, 11).map((v, i) => (i >= 1 && i <= 3 ? 0xff : v)));
  d.flush();
  assert.ok(errs.some((e) => e.code === 'PARSE_ERROR'), '应产生 PARSE_ERROR');
});

test('flush 幂等且报告样本数', () => {
  const d = new FlvDemuxer();
  let done = 0;
  d.on('done', (info) => {
    done++;
    assert.equal(typeof info.samples, 'number');
  });
  d.push(buildStream(2));
  d.flush();
  d.flush();
  assert.equal(done, 2);
});
