/**
 * mkv-track.test.js —— 轨道解析与 CodecID 编解码标识映射
 *
 * 覆盖：TrackType 映射、publicView 形状差异（视频含宽高/音频含采样率）、
 * 默认 language=und、encrypted 标记、DefaultDuration→frameRate、bitstreamFormat；
 * 以及 codecs 模块：parseAacAsc(显式采样率)/parseOpusHead/parseFlacStreaminfo/
 * avccToCodecString/hevcToCodecString 与 normalizeCodec 多家族边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MkvDemuxer, BufferSource, EbmlWriter, ID, encodeId, encodeSize } from '../src/index.js';
import { makeAvcc, makeAacAsc, makeOpusHead, makeFlacPrivate } from './fixtures/make-fixture.mjs';
import {
  normalizeCodec, parseAacAsc, parseOpusHead, parseFlacStreaminfo,
  avccToCodecString, hevcToCodecString, CODEC_TABLE,
} from '../src/codecs.js';

const U8 = (arr) => Uint8Array.from(arr);

function buildTracks(trackBuilds) {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 10, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, (w) => { for (const b of trackBuilds) b(w); }).done();
  const cluster = new EbmlWriter().master(ID.Cluster, (w) => { w.u(ID.ClusterTimecode, 0); }).done();
  const root = new EbmlWriter();
  root.raw(header); root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cluster.length));
  root.raw(info); root.raw(tracks); root.raw(cluster);
  return root.done();
}

const trackVideo = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
  t.u(ID.DefaultDuration, 41_708_333); // ≈23.976fps
  t.master(ID.Video, (v) => { v.u(ID.PixelWidth, 1280); v.u(ID.PixelHeight, 720); });
});
const trackAudio = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 2); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_PCM/INT/LIT');
  t.master(ID.Audio, (a) => { a.f(ID.SamplingFrequency, 48000, 4); a.u(ID.Channels, 2); a.u(ID.BitDepth, 16); });
});
const trackText = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 3); t.u(ID.TrackType, 0x11); t.s(ID.CodecID, 'S_TEXT/UTF8');
});
const trackEnc = (w) => w.master(ID.TrackEntry, (t) => {
  t.u(ID.TrackNumber, 4); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_OPUS');
  t.b(ID.CodecPrivate, makeOpusHead({}));
  t.master(ID.ContentEncodings, () => {}); // 存在即加密
});

// ── 轨道解析：publicView 形状差异 ─────────────────────────
test('轨道：video/audio/text 类型映射与公开视图字段', async () => {
  const d = new MkvDemuxer(new BufferSource(buildTracks([trackVideo, trackAudio, trackText])));
  await d.open();
  const [v, a, t] = d.tracks;
  assert.equal(v.type, 'video');
  assert.equal(a.type, 'audio');
  assert.equal(t.type, 'text');

  // 视频含宽高与帧率；不含音频字段
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.ok(Math.abs(v.frameRate - 23.976) < 0.01);
  assert.equal('sampleRate' in v, false);
  assert.equal(v.bitstreamFormat, undefined, 'VP9 无 bitstreamFormat');

  // 音频含采样率/声道；不含宽高
  assert.equal(a.sampleRate, 48000);
  assert.equal(a.numberOfChannels, 2);
  assert.equal('width' in a, false);

  // 文本轨默认 language=und（无 TrackLanguage 写入）
  assert.equal(t.language, 'und');
});

test('轨道：默认 flagDefault=true；language 缺省 und；encrypted 标记', async () => {
  const d = new MkvDemuxer(new BufferSource(buildTracks([trackEnc])));
  await d.open();
  const enc = d.tracks[0];
  assert.equal(enc.flagDefault, true);
  assert.equal(enc.encrypted, true);
  assert.equal(enc.supported, false);
  assert.equal(enc.extensions.mkvCodecId, 'A_OPUS');
});

test('轨道：h264/hevc 带 CodecPrivate → bitstreamFormat=avc', async () => {
  const bytes = buildTracks([
    (w) => w.master(ID.TrackEntry, (t) => {
      t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_MPEG4/ISO/AVC');
      t.b(ID.CodecPrivate, makeAvcc({}));
    }),
  ]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.tracks[0].bitstreamFormat, 'avc');
  assert.equal(d.tracks[0].codec, 'avc1.64001F');
});

// ── codecs：AVC/HEVC 私有结构解析 ────────────────────────
test('avccToCodecString：avcC → avc1.PPCCLL', () => {
  assert.equal(avccToCodecString(makeAvcc({ profile: 0x64, level: 0x1f })), 'avc1.64001F');
  assert.equal(avccToCodecString(null), 'avc1', '无私有数据降级基础串');
});

test('hevcToCodecString：hvcC(≥23B) → hev1.x.y.Lzz', () => {
  const hvcC = new Uint8Array(23);
  hvcC[0] = 1; hvcC[1] = 1; hvcC[12] = 30; // profile=1, level=30
  assert.equal(hevcToCodecString(hvcC), 'hev1.1.0.L30');
  assert.equal(hevcToCodecString(null), 'hev1', '无私有数据降级基础串');
});

// ── codecs：AAC AudioSpecificConfig 解析 ─────────────────
function bitsToBytes(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 1 << (7 - (i & 7)); });
  return out;
}
const pushBits = (arr, v, n) => { for (let i = n - 1; i >= 0; i--) arr.push((v >> i) & 1); };

test('parseAacAsc：索引表查率 + 显式 24-bit 采样率', () => {
  // 索引 4 → 44100
  const asc = makeAacAsc({ samplingFreqIndex: 4, channels: 2 });
  assert.deepEqual(parseAacAsc(asc), { aot: 2, sampleRate: 44100, channels: 2 });

  // 显式 96000：sfi=15 + 24 位
  // 规范顺序：AOT(5) → sfi(4) → [sfi==15 时 24-bit 采样率] → channelConfiguration(4)
  const bits = [];
  pushBits(bits, 2, 5);      // AOT
  pushBits(bits, 15, 4);     // sfi=15 触发显式采样率
  pushBits(bits, 96000, 24); // 24-bit 显式采样率（在 channels 之前）
  pushBits(bits, 2, 4);      // channels
  assert.deepEqual(parseAacAsc(bitsToBytes(bits)), { aot: 2, sampleRate: 96000, channels: 2 });
});

test('parseAacAsc：截断/缺数据走 LC 兜底', () => {
  assert.deepEqual(parseAacAsc(Uint8Array.of()), { aot: 2, sampleRate: null, channels: null });
});

// ── codecs：OpusHead ────────────────────────────────────
test('parseOpusHead：合法解码 / 非法返回 null', () => {
  const good = parseOpusHead(makeOpusHead({ channels: 2, preSkip: 312, inputSampleRate: 48000 }));
  assert.equal(good.channels, 2);
  assert.equal(good.preSkip, 312);
  assert.equal(good.inputSampleRate, 48000);
  assert.equal(parseOpusHead(Uint8Array.of(1, 2, 3)), null, '过短 → null');
  assert.equal(parseOpusHead(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), null, 'magic 不符 → null');
});

// ── codecs：FLAC STREAMINFO（裸 / 带 fLaC 魔数）──────────
function buildStreaminfo({ sampleRate = 44100, channels = 2, bits = 16 } = {}) {
  const si = new Uint8Array(34);
  si[10] = (sampleRate >> 12) & 0xff;
  si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0xf) << 4) | (((channels - 1) & 0x7) << 1) | (((bits - 1) >> 4) & 0x1);
  si[13] = ((bits - 1) & 0xf) << 4;
  return si;
}

test('parseFlacStreaminfo：裸 STREAMINFO 与 fLaC 魔数形态均可解析', () => {
  const bare = buildStreaminfo({ sampleRate: 48000, channels: 6, bits: 24 });
  assert.deepEqual(parseFlacStreaminfo(bare), { sampleRate: 48000, channels: 6, bitsPerSample: 24, totalSamples: 0 });

  // 带 fLaC 魔数：head(8) + si(34)
  const flac = new Uint8Array(42);
  flac.set([0x66, 0x4c, 0x61, 0x43], 0);
  flac.set(bare, 8);
  assert.deepEqual(parseFlacStreaminfo(flac), { sampleRate: 48000, channels: 6, bitsPerSample: 24, totalSamples: 0 });
  assert.equal(parseFlacStreaminfo(null), null);
});

// ── normalizeCodec：多家族边界 ──────────────────────────
test('normalizeCodec：vp8/av1/vorbis/未知 家族映射', () => {
  assert.equal(normalizeCodec({ codecId: 'V_VP8' }, {}).codec, 'vp8');
  assert.equal(normalizeCodec({ codecId: 'V_AV1', codecPrivate: null }, {}).codec, 'av01');
  const vorbis = normalizeCodec({ codecId: 'A_VORBIS', codecPrivate: null }, {});
  assert.equal(vorbis.codec, 'vorbis');
  assert.equal(vorbis.supported, true);
  // 未知 CodecID → family 取小写、supported=false、kind 按前缀猜
  const unk = normalizeCodec({ codecId: 'X_FOO', codecPrivate: null }, {});
  assert.equal(unk.family, 'x_foo');
  assert.equal(unk.supported, false);
  assert.equal(unk.kind, 'unknown');
});

test('normalizeCodec：A_MPEG/L2 走 mp2 家族且不支持（非 mp3 特例）', () => {
  const r = normalizeCodec({ codecId: 'A_MPEG/L2', codecPrivate: null }, {});
  assert.equal(r.family, 'mp2');
  assert.equal(r.supported, false);
});

test('CODEC_TABLE 收录量：视频/音频/字幕家族齐全', () => {
  const ids = Object.keys(CODEC_TABLE);
  for (const id of ['V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC', 'A_AAC', 'A_OPUS', 'A_FLAC', 'S_TEXT/UTF8', 'S_TEXT/WEBVTT']) {
    assert.ok(ids.includes(id), `${id} 应在 CODEC_TABLE 中`);
  }
});
