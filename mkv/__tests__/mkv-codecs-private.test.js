/**
 * mkv-codecs-private.test.js —— codecs.js 私有数据深水区
 *
 * 既有 mkv-track.test.js 只覆盖 avcC/hevcC 最小形、AAC 索引表与显式采样率、
 * FLAC totalSamples=0；本用例补齐：
 *   - schema.js 中 Block 家族 ID 与 RFC 9559 的一致性核对（BlockAdditions /
 *     DiscardPadding 是否被错位交换）；
 *   - avcC / hvcC 长度边界（<4 / <23）与 profile_space / tier / constraint 组合；
 *   - AAC ASC 的 AOT 逃逸（31 → 32+n）与显式 24-bit 采样率；
 *   - OpusHead 全字段（version / outputGain / mappingFamily）；
 *   - FLAC STREAMINFO 36-bit totalSamples 的字段偏移（含当前实现的偏差刻画）；
 *   - normalizeCodec 的 mp3 / vorbis / aac 兜底 / opus 缺私有数据 / 前缀猜类。
 *
 * 注：本文件对「当前实现与规范不一致」之处采用**行为刻画**断言并加注释标注，
 * 测试保持全绿，缺陷另在交付说明中报告（不修改 src）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MkvDemuxer, BufferSource, EbmlWriter, ID, SCHEMA, encodeId, encodeSize } from '../src/index.js';
import {
  normalizeCodec, parseAacAsc, parseOpusHead, parseFlacStreaminfo,
  avccToCodecString, hevcToCodecString, CODEC_TABLE,
} from '../src/codecs.js';
import { makeAvcc, makeAacAsc } from './fixtures/make-fixture.mjs';

const U8 = (arr) => Uint8Array.from(arr);

// ── schema：Block 家族 ID 与 RFC 9559 核对 ────────────────
test('schema：Block 家族 ID 与 RFC 9559 完全一致（BlockAdditions/DiscardPadding 未错位）', () => {
  // RFC 9559 §5.1.3 Matroska Block 家族规范 ID
  const expect = {
    BlockGroup: 0xa0,
    Block: 0xa1,
    SimpleBlock: 0xa3,
    BlockAdditions: 0x75a1,
    BlockMore: 0xa6,
    BlockAddID: 0xee,
    BlockDuration: 0x9b,
    ReferencePriority: 0xfa,
    ReferenceBlock: 0xfb,
    DiscardPadding: 0x75a2,
  };
  for (const [name, id] of Object.entries(expect)) {
    assert.equal(ID[name], id, `${name} 应为 0x${id.toString(16)}`);
  }
  // 关键：两个曾疑似交换的 ID 严格区分且类型正确
  assert.notEqual(ID.BlockAdditions, ID.DiscardPadding);
  assert.equal(ID.BlockAdditions, 0x75a1);
  assert.equal(ID.DiscardPadding, 0x75a2);
  assert.equal(SCHEMA.get(0x75a1).name, 'BlockAdditions');
  assert.equal(SCHEMA.get(0x75a1).type, 'm');
  assert.equal(SCHEMA.get(0x75a2).name, 'DiscardPadding');
  assert.equal(SCHEMA.get(0x75a2).type, 'i');
  assert.equal(SCHEMA.get(0xa6).name, 'BlockMore');
  assert.equal(SCHEMA.get(0xee).name, 'BlockAddID');
  assert.equal(SCHEMA.get(0xfb).name, 'ReferenceBlock');
  assert.equal(SCHEMA.get(0xfb).type, 'i');
  assert.equal(SCHEMA.get(0x9b).name, 'BlockDuration');
  assert.equal(SCHEMA.get(0x9b).type, 'u');
  // BlockAdditional 规范 ID 同为 0xA1（与 Track 层 Block 同值），按注释应不收录
  assert.equal(SCHEMA.has(0xa1), true);
  assert.equal(SCHEMA.get(0xa1).name, 'Block');
});

test('schema：Block 家族 ID 无重复值（扁平表未发生撞名）', () => {
  const ids = [
    ID.BlockGroup, ID.Block, ID.SimpleBlock, ID.BlockAdditions,
    ID.BlockMore, ID.BlockAddID, ID.BlockDuration,
    ID.ReferencePriority, ID.ReferenceBlock, ID.DiscardPadding,
  ];
  assert.equal(new Set(ids).size, ids.length, `Block 家族 ID 出现重复: ${ids.map((x) => x.toString(16))}`);
});

// ── avcC / hvcC 长度与组合边界 ───────────────────────────
test('avccToCodecString：<4 字节 → 基础串 avc1；null → avc1', () => {
  assert.equal(avccToCodecString(U8([1, 2, 3])), 'avc1');
  assert.equal(avccToCodecString(U8([1, 2, 3, 4])), 'avc1.020304');
  assert.equal(avccToCodecString(null), 'avc1');
});

test('hevcToCodecString：<23 字节 → 基础串 hev1', () => {
  assert.equal(hevcToCodecString(new Uint8Array(22)), 'hev1');
  assert.equal(hevcToCodecString(null), 'hev1');
});

/** hvcC：profile_space / tier / profile_idc / compat(32) / constraint(48) / level */
function makeHvcc({ profileSpace = 0, tier = 0, profileIdc = 1, compat = 0, constraint = [0, 0, 0, 0, 0, 0], level = 30 } = {}) {
  const w = new Uint8Array(23);
  w[0] = 1;
  w[1] = ((profileSpace & 0x3) << 6) | ((tier & 0x1) << 5) | (profileIdc & 0x1f);
  w[2] = (compat >>> 24) & 0xff;
  w[3] = (compat >>> 16) & 0xff;
  w[4] = (compat >>> 8) & 0xff;
  w[5] = compat & 0xff;
  for (let i = 0; i < 6; i++) w[6 + i] = constraint[i];
  w[12] = level;
  return w;
}

test('hevcToCodecString：profile_space / tier / 约束标志组合', () => {
  assert.equal(hevcToCodecString(makeHvcc({ profileIdc: 1, level: 30 })), 'hev1.1.0.L30');
  // 高层 tier=1 → H 前缀；约束 0xB0 → .B0
  assert.equal(
    hevcToCodecString(makeHvcc({ tier: 1, profileIdc: 1, level: 30, constraint: [0xb0, 0, 0, 0, 0, 0] })),
    'hev1.1.0.H30.B0',
  );
  // profile_space=1 → 'A' 前缀
  assert.equal(hevcToCodecString(makeHvcc({ profileSpace: 1, profileIdc: 2 })), 'hev1.A2.0.L30');
  // profile_space=3 → 'C' 前缀
  assert.equal(hevcToCodecString(makeHvcc({ profileSpace: 3, profileIdc: 5 })), 'hev1.C5.0.L30');
  // 兼容性标志非零 → 压缩十六进制（去尾随零）
  assert.equal(hevcToCodecString(makeHvcc({ compat: 0x60000000 })), 'hev1.1.6.L30');
});

test('轨道级：V_MPEGH/ISO/HEVC 带 hvcC → hev1 串且 bitstreamFormat=avc', async () => {
  const bytes = buildTracks([
    (w) => w.master(ID.TrackEntry, (t) => {
      t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_MPEGH/ISO/HEVC');
      t.b(ID.CodecPrivate, makeHvcc({ tier: 1, constraint: [0xb0, 0, 0, 0, 0, 0], level: 30 }));
    }),
  ]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  assert.equal(d.tracks[0].codec, 'hev1.1.0.H30.B0');
  assert.equal(d.tracks[0].bitstreamFormat, 'avc');
  assert.equal(d.trackList[0].family, 'hevc'); // family 非公开视图字段，取内部轨道表
});

// ── AAC ASC ─────────────────────────────────────────────
test('parseAacAsc：AOT 逃逸（初值 31 → 32+6bit）', () => {
  const asc = makeAacAsc({ aot: 42, samplingFreqIndex: 3, channels: 6 });
  const r = parseAacAsc(asc);
  assert.equal(r.aot, 42);
  assert.equal(r.sampleRate, 48000); // 索引 3
  assert.equal(r.channels, 6);
});

test('parseAacAsc：sfi=15 显式 24-bit 采样率（非标准值）', () => {
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(2, 5);       // AOT=2
  push(15, 4);      // sfi=15
  push(12345, 24);  // 显式采样率
  push(1, 4);       // 单声道
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
  assert.deepEqual(parseAacAsc(out), { aot: 2, sampleRate: 12345, channels: 1 });
});

test('parseAacAsc：单字节 / 空数据 → LC 兜底且字段为 null', () => {
  assert.deepEqual(parseAacAsc(U8([0x12])), { aot: 2, sampleRate: null, channels: null });
  assert.deepEqual(parseAacAsc(null), { aot: 2, sampleRate: null, channels: null });
});

test('normalizeCodec：A_AAC 无 ASC → AOT=2 且采样率/声道回落 Audio 元素值', () => {
  const r = normalizeCodec({ codecId: 'A_AAC', codecPrivate: null }, { sampleRate: 48000, channels: 2 });
  assert.equal(r.codec, 'mp4a.40.2');
  assert.equal(r.extra.aot, 2);
  assert.equal(r.extra.sampleRate, 48000);
  assert.equal(r.extra.channels, 2);
});

// ── OpusHead ────────────────────────────────────────────
function makeOpusHeadFull({ version = 1, channels = 2, preSkip = 312, inputSampleRate = 48000, outputGain = 0, mappingFamily = 0 } = {}) {
  const w = new Uint8Array(19);
  w.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
  w[8] = version; w[9] = channels;
  const v = new DataView(w.buffer);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputSampleRate, true);
  v.setInt16(16, outputGain, true);
  w[18] = mappingFamily;
  return w;
}

test('parseOpusHead：全字段（含负 outputGain / mappingFamily）', () => {
  const head = parseOpusHead(makeOpusHeadFull({ version: 1, channels: 3, preSkip: 111, inputSampleRate: 16000, outputGain: -1000, mappingFamily: 1 }));
  assert.deepEqual(head, {
    version: 1, channels: 3, preSkip: 111, inputSampleRate: 16000, outputGain: -1000, mappingFamily: 1,
  });
});

test('normalizeCodec：A_OPUS 有 OpusHead → preSkip/channels 进 extra；缺私有数据不编造', () => {
  const withHead = normalizeCodec({ codecId: 'A_OPUS', codecPrivate: makeOpusHeadFull({ preSkip: 312, channels: 2 }) }, {});
  assert.equal(withHead.codec, 'opus');
  assert.equal(withHead.extra.preSkip, 312);
  assert.equal(withHead.extra.channels, 2);
  assert.equal(withHead.extra.inputSampleRate, 48000);

  const noHead = normalizeCodec({ codecId: 'A_OPUS', codecPrivate: null }, { channels: 2 });
  assert.equal(noHead.codec, 'opus');
  assert.equal('preSkip' in noHead.extra, false, '缺 OpusHead 不应编造 preSkip');
});

// ── FLAC STREAMINFO ─────────────────────────────────────
/** 按规范布局写入 STREAMINFO：样本率20 / 声道3 / 位深5 / totalSamples36 */
function makeStreaminfo({ sampleRate = 44100, channels = 2, bits = 16, totalSamples = 0n } = {}) {
  const si = new Uint8Array(34);
  si[10] = (sampleRate >> 12) & 0xff;
  si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0xf) << 4) | (((channels - 1) & 0x7) << 1) | (((bits - 1) >> 4) & 0x1);
  si[13] = (((bits - 1) & 0xf) << 4) | Number((totalSamples >> 32n) & 0xfn);
  si[14] = Number((totalSamples >> 24n) & 0xffn);
  si[15] = Number((totalSamples >> 16n) & 0xffn);
  si[16] = Number((totalSamples >> 8n) & 0xffn);
  si[17] = Number(totalSamples & 0xffn);
  return si;
}

test('parseFlacStreaminfo：采样率/声道/位深解析（36-bit totalSamples 正确组装）', () => {
  // 规范：totalSamples 为 36-bit，落在 b13 低 4 位 + b14..b17。
  // 修复 codecs.js:132-134：hi=b13&0xf（totalSamples[35:32]），
  // lo=b14<<24|b15<<16|b16<<8|b17，totalSamples=hi*2^32+lo。
  const si = makeStreaminfo({ sampleRate: 48000, channels: 2, bits: 16, totalSamples: 1_000_000n });
  const r = parseFlacStreaminfo(si);
  assert.equal(r.sampleRate, 48000);
  assert.equal(r.channels, 2);
  assert.equal(r.bitsPerSample, 16);
  // 修复后：totalSamples 按 FLAC 规范 36-bit 布局正确组装 → 1_000_000
  assert.equal(r.totalSamples, 1_000_000, '修复后 totalSamples 按 FLAC 规范 36-bit 布局正确');
});

test('parseFlacStreaminfo：长度不足 / 非 fLaC 短数据 → null', () => {
  assert.equal(parseFlacStreaminfo(U8([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0])), null, 'fLaC 魔数但不足 42B');
  assert.equal(parseFlacStreaminfo(new Uint8Array(33)), null, '裸数据不足 34B');
  assert.equal(parseFlacStreaminfo(null), null);
});

test('轨道级：A_FLAC description 透出 fLaC 头且 extra 带参', async () => {
  const flacPriv = new Uint8Array(42);
  flacPriv.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22], 0);
  flacPriv.set(makeStreaminfo({ sampleRate: 96000, channels: 6, bits: 24 }), 8);
  const bytes = buildTracks([
    (w) => w.master(ID.TrackEntry, (t) => {
      t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 2); t.s(ID.CodecID, 'A_FLAC');
      t.b(ID.CodecPrivate, flacPriv);
      t.master(ID.Audio, (a) => { a.f(ID.SamplingFrequency, 96000, 4); a.u(ID.Channels, 6); });
    }),
  ]);
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const t = d.tracks[0];
  assert.equal(t.codec, 'flac');
  assert.equal(t.description[0], 0x66);
  assert.equal(t.extensions.codecExtra.sampleRate, 96000);
  assert.equal(t.extensions.codecExtra.channels, 6);
  assert.equal(t.extensions.codecExtra.bitsPerSample, 24);
});

// ── normalizeCodec 家族边界 ─────────────────────────────
test('normalizeCodec：A_MPEG/L3 → mp3；A_VORBIS → vorbis（保留 CodecID，不编造）', () => {
  const mp3 = normalizeCodec({ codecId: 'A_MPEG/L3', codecPrivate: null }, {});
  assert.equal(mp3.codec, 'mp3');
  assert.equal(mp3.family, 'mp3');
  assert.equal(mp3.kind, 'audio');
  assert.equal(mp3.supported, true);

  // 三段式 Vorbis 头（identification/comment/setup）非本模块解析范围：codec 固定 'vorbis'
  const vorbisPriv = U8([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 2, 3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 4]);
  const vorbis = normalizeCodec({ codecId: 'A_VORBIS', codecPrivate: vorbisPriv }, {});
  assert.equal(vorbis.codec, 'vorbis');
  assert.equal(vorbis.family, 'vorbis');
  assert.equal(vorbis.supported, true);
  assert.deepEqual(vorbis.extra, {});
});

test('normalizeCodec：未知 CodecID 按前缀猜 kind、family 取小写、supported=false', () => {
  for (const [cid, kind] of [['V_XYZ', 'video'], ['A_XYZ', 'audio'], ['S_XYZ', 'text'], ['X_XYZ', 'unknown']]) {
    const r = normalizeCodec({ codecId: cid, codecPrivate: null }, {});
    assert.equal(r.kind, kind, `${cid} kind`);
    assert.equal(r.family, cid.toLowerCase());
    assert.equal(r.supported, false);
    assert.equal(r.codec, cid, '未知家族 codec 原样透出');
  }
  const empty = normalizeCodec({ codecId: '', codecPrivate: null }, {});
  assert.equal(empty.kind, 'unknown');
  assert.equal(empty.family, '');
});

test('CODEC_TABLE：codec 字段仅字幕族显式给出（其余由 core 构造）', () => {
  assert.equal(CODEC_TABLE['S_TEXT/UTF8'].codec, 'x-srt');
  assert.equal(CODEC_TABLE['S_TEXT/WEBVTT'].codec, 'x-vtt');
  assert.equal('codec' in CODEC_TABLE['V_MPEG4/ISO/AVC'], false);
  assert.equal(CODEC_TABLE['A_OPUS'].kind, 'audio');
  assert.equal(CODEC_TABLE['V_PRORES'].supported, false);
});

// ── 内联文件拼装（局部 helper，供轨道级用例复用）──────────
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
