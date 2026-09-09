import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer, avcCodecString, parseAudioSpecificConfig } from '../src/flv-demuxer.js';
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

/* ----------------------------------------------------------------------------
 * 分支补测：以下路径此前未被覆盖（audio 轨、不支持 codec、魔数缺失、
 * 时间戳扩展、cts 为负、PreviousTagSize 告警、destroy 后写入等）
 * -------------------------------------------------------------------------- */

/** 拼接若干字节块 */
function join(...parts) {
  const ps = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  let len = 0;
  for (const p of ps) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 带 options 的采集器（metadata/warn 收集为数组，可能多次） */
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
/** ctsBytes 默认 0；传 0xffffff 表示负偏移 -1ms */
const AVC_NALU = (ctsBytes = 0) =>
  Uint8Array.from([
    0x17,
    1,
    (ctsBytes >> 16) & 0xff,
    (ctsBytes >> 8) & 0xff,
    ctsBytes & 0xff,
    0x00,
    0x00,
    0x00,
    0x02,
    0x65,
    0x88,
  ]);

/** AAC 首字节：SoundFormat=10(AAC) + 44.1kHz + 16bit + 立体声 */
const AAC_FIRST = 0xaf;
// 位布局 5bit objectType(2=AAC-LC) + 4bit freqIdx(4=44100) + 4bit channels(2)
// → 00010 0100 0010 → 0x12 0x10
const ASC_44100_2CH = Uint8Array.from([0x12, 0x10]);

/** 构造 onMetaData 的 AMF0 script 数据 */
function amfMetaData(pairs, name = 'onMetaData') {
  const enc = new TextEncoder();
  const parts = [];
  const nb = enc.encode(name);
  parts.push(Uint8Array.from([0x02, (nb.length >> 8) & 0xff, nb.length & 0xff, ...nb]));
  parts.push(Uint8Array.from([0x08, 0, 0, 0, pairs.length]));
  for (const [k, v] of pairs) {
    const kb = enc.encode(k);
    parts.push(Uint8Array.from([(kb.length >> 8) & 0xff, kb.length & 0xff, ...kb]));
    const vb = new Uint8Array(9);
    vb[0] = 0x00; // Number marker
    new DataView(vb.buffer).setFloat64(1, v);
    parts.push(vb);
  }
  parts.push(Uint8Array.from([0x00, 0x00, 0x09]));
  return join(...parts);
}

test('AAC 音频轨：sequence header 建轨 + 裸帧出样本', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(8, 0, join(Uint8Array.from([AAC_FIRST, 0]), ASC_44100_2CH)),
      serializeTag(8, 23, join(Uint8Array.from([AAC_FIRST, 1]), Uint8Array.from([0x21, 0x10, 0x05]))),
    ),
  );
  d.flush();
  const audio = got.tracks.find((t) => t.kind === 'audio');
  assert.ok(audio, '应有 audio track');
  assert.equal(audio.codec, 'aac');
  assert.equal(audio.codecString, 'mp4a.40.2');
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.numberOfChannels, 2);
  assert.equal(audio.bitstreamFormat, 'aac-raw');
  assert.deepEqual(Array.from(audio.description), Array.from(ASC_44100_2CH));

  assert.equal(got.samples.length, 1);
  assert.equal(got.samples[0].kind, 'audio');
  assert.equal(got.samples[0].keyframe, true);
  assert.equal(got.samples[0].durationUs, 0, 'AAC 帧时长由消费端计算');
  assert.deepEqual(Array.from(got.samples[0].data), [0x21, 0x10, 0x05], '应剥掉 2 字节 AAC 头');
});

test('暂不支持的视频 codecId → NOT_SUPPORTED 且不中断', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(9, 0, Uint8Array.from([0x12, 0x00, 0x00, 0x00, 0x00]))));
  d.flush();
  assert.ok(
    got.errors.some((e) => e.code === 'NOT_SUPPORTED' && /CodecID=2/.test(e.message)),
    '应报 NOT_SUPPORTED 并带 codecId',
  );
  assert.equal(got.samples.length, 0);
});

test('暂不支持的音频 SoundFormat → NOT_SUPPORTED', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(8, 0, Uint8Array.from([0x22, 0x00])))); // MP3(2)
  d.flush();
  assert.ok(
    got.errors.some((e) => e.code === 'NOT_SUPPORTED' && /SoundFormat=2/.test(e.message)),
    '应报 NOT_SUPPORTED 并带 format',
  );
});

test('未知 Tag 类型 → 静默跳过（规范允许）', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(5, 0, Uint8Array.from([1, 2, 3, 4]))));
  d.flush();
  assert.equal(got.errors.length, 0, '未知类型不应报错');
  assert.equal(got.samples.length, 0);
});

test('avcPacketType=2（AVC end of sequence）→ 忽略', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(9, 0, Uint8Array.from([0x17, 2, 0, 0, 0]))));
  d.flush();
  assert.equal(got.samples.length, 0);
  assert.equal(got.errors.length, 0);
});

test('未收到 avcC 前的视频 NALU → 丢弃（避免无法解码的样本外泄）', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(9, 0, AVC_NALU())));
  d.flush();
  assert.equal(got.samples.length, 0, '缺少序列头不应出样本');
  assert.equal(got.tracks.length, 0);
});

test('parseScriptTags:false → 不解析 script tag（无 metadata 事件）', () => {
  const { d, got } = collectWith({ parseScriptTags: false });
  d.push(join(flvFileHeader(), serializeTag(18, 0, amfMetaData([['width', 640]]))));
  d.flush();
  assert.equal(got.metadata.length, 0);
});

test('非 onMetaData 的 script tag → metadata 只带 name', () => {
  const { d, got } = collectWith();
  d.push(join(flvFileHeader(), serializeTag(18, 0, Uint8Array.from([0x02, 0x00, 0x03, 0x66, 0x6f, 0x6f]))));
  d.flush();
  assert.equal(got.metadata.length, 1);
  assert.equal(got.metadata[0].name, 'foo');
  assert.equal(got.metadata[0].width, undefined);
});

test('metadata 宽高回填已建立的视频轨描述', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(9, 0, AVC_SEQ()),
      serializeTag(18, 0, amfMetaData([['width', 1280], ['height', 720]])),
    ),
  );
  d.flush();
  const video = got.tracks.find((t) => t.kind === 'video');
  assert.equal(video.width, 1280, 'metadata.width 应回填');
  assert.equal(video.height, 720);
});

test('时间戳扩展字节（>24bit）正确合成毫秒', () => {
  const { d, got } = collectWith();
  const bigTs = 0x01000000 + 7; // 需要 tsExt=1
  d.push(join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, bigTs, AVC_NALU())));
  d.flush();
  assert.equal(got.samples.length, 1);
  assert.equal(got.samples[0].dtsUs, bigTs * 1000, 'ts 应由低 24 位 + 扩展字节合成');
});

test('cts 为负（SI24 有符号）→ ptsUs 早于 dtsUs', () => {
  const { d, got } = collectWith();
  d.push(
    join(flvFileHeader(), serializeTag(9, 0, AVC_SEQ()), serializeTag(9, 100, AVC_NALU(0xffffff))),
  );
  d.flush();
  assert.equal(got.samples.length, 1);
  assert.equal(got.samples[0].dtsUs, 100_000);
  assert.equal(got.samples[0].ptsUs, 99_000, 'cts=-1ms 应换算为 -1000µs');
});

test('PreviousTagSize 不匹配 → 仅告警，不影响后续解析', () => {
  const { d, got } = collectWith();
  const tag = serializeTag(9, 0, AVC_SEQ()).slice();
  tag[tag.length - 1] ^= 0xff; // 破坏 PreviousTagSize 的末字节
  d.push(join(flvFileHeader(), tag, serializeTag(9, 33, AVC_NALU())));
  d.flush();
  assert.ok(
    got.warns.some((w) => /PreviousTagSize 不匹配/.test(w)),
    '应发出 warn',
  );
  assert.equal(got.errors.length, 0, '告警不应升级为错误');
  assert.equal(got.samples.length, 1, '后续 Tag 仍应正常解析');
});

test('魔数缺失（非 FLV 数据）→ PARSE_ERROR 且仅保留末尾 3 字节等待', () => {
  const { d, got } = collectWith();
  d.push(new Uint8Array(100).fill(0xaa));
  assert.ok(
    got.errors.some((e) => e.code === 'PARSE_ERROR' && /魔数缺失/.test(e.message)),
    '应报魔数缺失',
  );
  assert.ok(d.buffer.length <= 3, `应只保留末尾 3 字节等待，实际 ${d.buffer.length}`);
  assert.doesNotThrow(() => d.flush());
});

test('flush 时未识别到头但有残留 → PARSE_ERROR', () => {
  const { d, got } = collectWith();
  d.push(Uint8Array.from([0x01, 0x02, 0x03])); // 不足 4 字节，不触发魔数扫描报错
  d.flush();
  assert.ok(
    got.errors.some((e) => e.code === 'PARSE_ERROR' && /未识别到 FLV 头/.test(e.message)),
    'flush 应报未识别头',
  );
});

test('destroy 后 push → 抛 STATE_ERROR', () => {
  const d = new FlvDemuxer();
  d.destroy();
  assert.throws(
    () => d.push(flvFileHeader()),
    (err) => err.code === 'STATE_ERROR' && /已销毁/.test(err.message),
  );
});

test('avcCodecString：avcC 过短时回退默认值', () => {
  assert.equal(avcCodecString(new Uint8Array(0)), 'avc1.42e01e');
  assert.equal(avcCodecString(Uint8Array.from([1, 2, 3])), 'avc1.42e01e');
  assert.equal(avcCodecString(Uint8Array.from([1, 0x42, 0xc0, 0x1e])), 'avc1.42c01e');
});

test('parseAudioSpecificConfig：短输入/保留 freqIdx 的兜底', () => {
  assert.deepEqual(parseAudioSpecificConfig(new Uint8Array(0)), { sampleRate: 44100, channels: 2 });
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.from([0x12])), { sampleRate: 44100, channels: 2 });
  // freqIdx=15 表示显式采样率（本期不解析）→ 回退 44100；声道 2
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.from([0x17, 0x90])), {
    sampleRate: 44100,
    channels: 2,
  });
  // 48000Hz(freqIdx=3) / 单声道(1)
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.from([0x11, 0x88])), {
    sampleRate: 48000,
    channels: 1,
  });
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
