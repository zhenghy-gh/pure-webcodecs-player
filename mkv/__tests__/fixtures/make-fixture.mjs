/**
 * make-fixture.mjs —— 程序化生成「最小合法」MKV/WebM 测试夹具
 *
 * 全部用本模块 src 的 EBML/Lacing 编码器拼装，保证结构合法、字节确定、无外网无大文件。
 * 导出的 EXPECT_* 常量供测试断言使用。
 */

import {
  ID, EbmlWriter, encodeSize, encodeId, encodeUIntPayload,
} from '../../src/index.js';
import {
  encodeXiphHeader, encodeEbmlLacingHeader,
} from '../../src/lacing.js';

// ──────────────────────────────────────────────────────
// 基础积木
// ──────────────────────────────────────────────────────

/** int16 大端（含负数二补码） */
function int16be(v) {
  const u = v < 0 ? v + 0x10000 : v;
  return Uint8Array.of((u >> 8) & 0xff, u & 0xff);
}

/** 填充图案字节 */
function pattern(byte, len) {
  return new Uint8Array(len).fill(byte);
}

/**
 * 构造 SimpleBlock / Block 载荷：
 * [轨道号 VINT][relTimecode int16][flags][lacing头?][帧数据]
 */
export function makeBlock({
  trackNumber,
  relTimecode = 0,
  keyframe = false,
  discardable = false,
  lacing = 'none', // 'none' | 'xiph' | 'fixed' | 'ebml'
  frames, // Uint8Array[]
}) {
  const head = [
    encodeSize(trackNumber), // 轨道号：带标记位的普通 VINT
    int16be(relTimecode),
    Uint8Array.of(
      (keyframe ? 0x80 : 0)
      | (lacing === 'xiph' ? 0x02 : lacing === 'fixed' ? 0x04 : lacing === 'ebml' ? 0x06 : 0)
      | (discardable ? 0x01 : 0),
    ),
  ];
  const parts = [...head];
  if (lacing === 'none') {
    if (frames.length !== 1) throw new Error('none lacing 只允许单帧');
    parts.push(frames[0]);
  } else {
    // 帧数字节已包含在 xiph/ebml 头部助手内；fixed 需单独写
    if (lacing === 'xiph') {
      parts.push(encodeXiphHeader(frames.slice(0, -1).map((f) => f.length)));
    } else if (lacing === 'fixed') {
      parts.push(Uint8Array.of(frames.length - 1));
    } else if (lacing === 'ebml') {
      parts.push(encodeEbmlLacingHeader(frames.slice(0, -1).map((f) => f.length)));
    }
    for (const f of frames) parts.push(f);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** OpusHead（19 字节） */
export function makeOpusHead({ channels = 2, preSkip = 312, inputSampleRate = 48000 } = {}) {
  const w = new Uint8Array(19);
  w.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  w[8] = 1; // version
  w[9] = channels;
  new DataView(w.buffer).setUint16(10, preSkip, true);
  new DataView(w.buffer).setUint32(12, inputSampleRate, true);
  return w;
}

/** AAC AudioSpecificConfig：AOT=2, 采样率索引/显式, 声道 */
export function makeAacAsc({ aot = 2, samplingFreqIndex = 4, channels = 2 } = {}) {
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  if (aot >= 32) { push(31, 5); push(aot - 32, 6); } else push(aot, 5);
  push(samplingFreqIndex, 4);
  push(channels, 4);
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
  return out;
}

/** FLAC CodecPrivate："fLaC" + STREAMINFO 元数据块头 + STREAMINFO(34B) */
export function makeFlacPrivate({ sampleRate = 44100, channels = 2, bitsPerSample = 16 } = {}) {
  const si = new Uint8Array(34);
  si[10] = (sampleRate >> 12) & 0xff;
  si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0xf) << 4) | (((channels - 1) & 0x7) << 1) | (((bitsPerSample - 1) >> 4) & 0x1);
  si[13] = (((bitsPerSample - 1) & 0xf) << 4);
  const head = Uint8Array.of(0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34); // "fLaC" + LAST|STREAMINFO 头
  const out = new Uint8Array(head.length + si.length);
  out.set(head); out.set(si, head.length);
  return out;
}

/** AVCDecoderConfigurationRecord（AVCC）最小形 */
export function makeAvcc({ profile = 0x64, compat = 0x00, level = 0x1f } = {}) {
  const sps = Uint8Array.of(0x67, profile, compat, level, 0xac, 0xd9, 0x40, 0x50);
  const pps = Uint8Array.of(0x68, 0xeb, 0xec, 0xb2);
  const w = new Uint8Array(7 + 2 + sps.length + 1 + pps.length);
  w[0] = 1; w[1] = profile; w[2] = compat; w[3] = level;
  w[4] = 0xff; w[5] = 0xe1; // reserved + numSPS=1
  w[6] = sps.length;
  w.set(sps, 7);
  const o = 7 + sps.length;
  w[o] = 1; // numPPS
  w.set(pps, o + 1);
  return w;
}

// ──────────────────────────────────────────────────────
// 轨道与文件拼装
// ──────────────────────────────────────────────────────

export function ebmlHeader(docType) {
  return new EbmlWriter()
    .master(ID.EBML, (w) => {
      w.u(ID.EBMLVersion, 1);
      w.u(ID.EBMLReadVersion, 1);
      w.u(ID.EBMLMaxIDLength, 4);
      w.u(ID.EBMLMaxSizeLength, 8);
      w.s(ID.DocType, docType);
      w.u(ID.DocTypeVersion, 4);
      w.u(ID.DocTypeReadVersion, 2);
    })
    .done();
}

function trackVideoVP9(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1);
    t.u(ID.TrackUID, 0x12345678);
    t.u(ID.TrackType, 1);
    t.u(ID.FlagLacing, 1);
    t.u(ID.DefaultDuration, 41_708_333); // ≈23.976fps
    t.s(ID.CodecID, 'V_VP9');
    t.master(ID.Video, (v) => {
      v.u(ID.PixelWidth, 320);
      v.u(ID.PixelHeight, 240);
    });
  });
}

function trackAudioOpus(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 2);
    t.u(ID.TrackUID, 0x87654321);
    t.u(ID.TrackType, 2);
    t.u(ID.FlagLacing, 1);
    t.s(ID.CodecID, 'A_OPUS');
    t.b(ID.CodecPrivate, makeOpusHead({}));
    t.master(ID.Audio, (a) => {
      a.f(ID.SamplingFrequency, 48000, 4);
      a.u(ID.Channels, 2);
    });
  });
}

function trackVideoAVC(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1);
    t.u(ID.TrackUID, 0xa1);
    t.u(ID.TrackType, 1);
    t.s(ID.CodecID, 'V_MPEG4/ISO/AVC');
    t.b(ID.CodecPrivate, makeAvcc({}));
    t.master(ID.Video, (v) => {
      v.u(ID.PixelWidth, 1920);
      v.u(ID.PixelHeight, 1080);
    });
  });
}

function trackAudioAAC(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 2);
    t.u(ID.TrackUID, 0xa2);
    t.u(ID.TrackType, 2);
    t.s(ID.CodecID, 'A_AAC');
    t.b(ID.CodecPrivate, makeAacAsc({}));
    t.master(ID.Audio, (a) => {
      a.f(ID.SamplingFrequency, 44100, 4);
      a.u(ID.Channels, 2);
    });
  });
}

function trackAudioFLAC(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 3);
    t.u(ID.TrackUID, 0xa3);
    t.u(ID.TrackType, 2);
    t.s(ID.CodecID, 'A_FLAC');
    t.b(ID.CodecPrivate, makeFlacPrivate({}));
    t.master(ID.Audio, (a) => {
      a.f(ID.SamplingFrequency, 44100, 4);
      a.u(ID.Channels, 2);
      a.u(ID.BitDepth, 16);
    });
  });
}

/** Segment 内容构建器返回各部分，便于计算 Cues 的相对偏移 */
function infoWriter(durationMs, { dateUTCms = null } = {}) {
  return new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000);
    if (durationMs != null) w.f(ID.Duration, durationMs, 4); // 单位 = TimecodeScale（此处毫秒）
    if (dateUTCms != null) {
      // DateUTC：自 2001-01-01 起的纳秒（int64）
      const EPOCH = Date.UTC(2001, 0, 1);
      const ns = BigInt(dateUTCms - EPOCH) * 1000000n;
      const b = new Uint8Array(8);
      let v = ns;
      for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
      w.leaf(0x4461, b); // ID.DateUTC
    }
    w.u8str(ID.MuxingApp, 'player-mkv fixture');
    w.u8str(ID.WritingApp, 'make-fixture.mjs');
  }).done();
}

function tracksWriter(build) {
  const w = new EbmlWriter();
  w.master(ID.Tracks, build);
  return w.done();
}

function clusterWriter(timecodeMs, childrenBytesList) {
  return new EbmlWriter()
    .master(ID.Cluster, (w) => {
      w.u(ID.ClusterTimecode, timecodeMs);
      for (const b of childrenBytesList) w.raw(b);
    })
    .done();
}

/** SimpleBlock/BlockGroup 字节 */
function simpleBlockBytes(opts) {
  return new EbmlWriter().leaf(ID.SimpleBlock, makeBlock(opts)).done();
}
function blockGroupBytes(blockOpts, { reference = true, durationMs = null } = {}) {
  return new EbmlWriter()
    .master(ID.BlockGroup, (g) => {
      g.leaf(ID.Block, makeBlock(blockOpts));
      if (reference) g.i(ID.ReferenceBlock, -1);
      if (durationMs !== null) g.u(ID.BlockDuration, durationMs);
    })
    .done();
}

function trackTextUtf8(w, number = 3) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, number);
    t.u(ID.TrackUID, 0x511);
    t.u(ID.TrackType, 0x11); // 字幕 → 契约 'text'
    t.s(ID.CodecID, 'S_TEXT/UTF8');
  });
}

function trackAudioOpusEncrypted(w) {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 2);
    t.u(ID.TrackUID, 0xe01);
    t.u(ID.TrackType, 2);
    t.s(ID.CodecID, 'A_OPUS');
    t.b(ID.CodecPrivate, makeOpusHead({}));
    t.master(ID.ContentEncodings, () => {}); // 存在即视为加密/压缩轨
    t.master(ID.Audio, (a) => {
      a.f(ID.SamplingFrequency, 48000, 4);
      a.u(ID.Channels, 2);
    });
  });
}

/**
 * 文本轨变体：VP9 视频 + S_TEXT/UTF8 字幕轨，两簇两条字幕。
 */
export function makeWebmWithTextTrack() {
  const header = ebmlHeader('webm');
  const info = infoWriter(2000);
  const tracks = tracksWriter((w) => { trackVideoVP9(w); trackTextUtf8(w); });
  const c0 = clusterWriter(0, [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0xA0, 4)] }),
    simpleBlockBytes({ trackNumber: 3, relTimecode: 0, keyframe: true, frames: [new TextEncoder().encode('Hello')] }),
  ]);
  const c1 = clusterWriter(1000, [
    simpleBlockBytes({ trackNumber: 3, relTimecode: 0, keyframe: true, frames: [new TextEncoder().encode('世界')] }),
  ]);
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + c0.length + c1.length));
  root.raw(info); root.raw(tracks); root.raw(c0); root.raw(c1);
  return { bytes: root.done() };
}

/**
 * 加密轨变体：音轨带 ContentEncodings → open 正常、readSample 报 NOT_SUPPORTED。
 */
export function makeWebmWithEncryptedAudio() {
  const header = ebmlHeader('webm');
  const info = infoWriter(1000);
  const tracks = tracksWriter((w) => { trackVideoVP9(w); trackAudioOpusEncrypted(w); });
  const c0 = clusterWriter(0, [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0xA0, 4)] }),
    simpleBlockBytes({ trackNumber: 2, relTimecode: 0, keyframe: true, frames: [pattern(0x77, 6)] }),
  ]);
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + c0.length));
  root.raw(info); root.raw(tracks); root.raw(c0);
  return { bytes: root.done() };
}

/**
 * 无 Duration 变体：durationUs 应为 null（直播/未知时长形态）。
 */
export function makeWebmNoDuration() {
  const header = ebmlHeader('webm');
  const info = infoWriter(null, { dateUTCms: Date.UTC(2025, 7, 25, 12, 0, 0) });
  const tracks = tracksWriter((w) => { trackVideoVP9(w); });
  const c0 = clusterWriter(0, [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0xA0, 4)] }),
  ]);
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + c0.length));
  root.raw(info); root.raw(tracks); root.raw(c0);
  return { bytes: root.done() };
}

/**
 * 最小 WebM：
 *   轨道：#1 VP9 视频 / #2 Opus 音频
 *   时间线（scale=1e6，簇时间码单位 ms）：
 *     Cluster0 @0     : v#1 KF@0；a#2 Xiph 三帧 @0（10/20/30B）
 *     Cluster1 @1500  : v#1 增量帧(BlockGroup+Ref+Dur40ms)@1500；
 *                       a#2 Fixed 两帧 @1500（25B×2）；v#1 KF@2000
 *     Cues            : t=0→Cluster0；t=2000→Cluster1
 */
export function makeMinimalWebm() {
  const header = ebmlHeader('webm');

  const info = infoWriter(4000);
  const tracks = tracksWriter((w) => { trackVideoVP9(w); trackAudioOpus(w); });

  const c0Body = [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0xA0, 4)] }),
    simpleBlockBytes({
      trackNumber: 2, relTimecode: 0, lacing: 'xiph',
      frames: [pattern(1, 10), pattern(2, 20), pattern(3, 30)],
    }),
  ];
  const c0 = clusterWriter(0, c0Body);

  const c1Body = [
    blockGroupBytes(
      { trackNumber: 1, relTimecode: 0, frames: [pattern(0xB0, 6)] },
      { reference: true, durationMs: 40 },
    ),
    simpleBlockBytes({
      trackNumber: 2, relTimecode: 0, lacing: 'fixed',
      frames: [pattern(4, 25), pattern(5, 25)],
    }),
    simpleBlockBytes({ trackNumber: 1, relTimecode: 500, keyframe: true, frames: [pattern(0xC0, 8)] }),
  ];
  const c1 = clusterWriter(1500, c1Body);

  // Cues 相对位置：Segment 数据区内 Info+Tracks+Cluster0 之后
  const cluster1PosInSegment = info.length + tracks.length + c0.length;
  const cues = new EbmlWriter()
    .master(ID.Cues, (cw) => {
      cw.master(ID.CuePoint, (p) => {
        p.u(ID.CueTime, 0);
        p.master(ID.CueTrackPositions, (tp) => {
          tp.u(ID.CueTrack, 1);
          tp.u(ID.CueClusterPosition, 0);
        });
      });
      cw.master(ID.CuePoint, (p) => {
        p.u(ID.CueTime, 2000);
        p.master(ID.CueTrackPositions, (tp) => {
          tp.u(ID.CueTrack, 1);
          tp.u(ID.CueClusterPosition, cluster1PosInSegment);
        });
      });
    })
    .done();

  const segPayloadLen = info.length + tracks.length + c0.length + c1.length + cues.length;

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(segPayloadLen));
  root.raw(info); root.raw(tracks); root.raw(c0); root.raw(c1); root.raw(cues);
  return { bytes: root.done(), cuesOffsetInSegmentForCluster1: cluster1PosInSegment };
}

/**
 * 未知长度变体：Segment 与 Cluster0 尺寸未知（流式封装形态），并在
 * EBML 头与 Segment 之间插入 Void 检验跳过逻辑。样本内容与 makeMinimalWebm 一致。
 */
export function makeUnknownSizeWebm() {
  const header = ebmlHeader('webm');
  const voidEl = new EbmlWriter().leaf(ID.Void, pattern(0, 16)).done();

  const info = infoWriter(4000);
  const tracks = tracksWriter((w) => { trackVideoVP9(w); trackAudioOpus(w); });

  const c0Body = [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0xA0, 4)] }),
    simpleBlockBytes({
      trackNumber: 2, relTimecode: 0, lacing: 'xiph',
      frames: [pattern(1, 10), pattern(2, 20), pattern(3, 30)],
    }),
  ];
  // Cluster0 用未知长度
  const c0 = (() => {
    const inner = new EbmlWriter();
    inner.u(ID.ClusterTimecode, 0);
    for (const b of c0Body) inner.raw(b);
    const body = inner.done();
    const out = new EbmlWriter();
    out.raw(encodeId(ID.Cluster));
    out.raw(new Uint8Array([0xff])); // 未知长度标记
    out.raw(body);
    return out.done();
  })();

  const c1Body = [
    blockGroupBytes(
      { trackNumber: 1, relTimecode: 0, frames: [pattern(0xB0, 6)] },
      { reference: true, durationMs: 40 },
    ),
    simpleBlockBytes({
      trackNumber: 2, relTimecode: 0, lacing: 'fixed',
      frames: [pattern(4, 25), pattern(5, 25)],
    }),
    simpleBlockBytes({ trackNumber: 1, relTimecode: 500, keyframe: true, frames: [pattern(0xC0, 8)] }),
  ];
  const c1 = clusterWriter(1500, c1Body);

  // Void 在 Segment 之外，不计入段内相对偏移
  const cluster1PosInSegment = info.length + tracks.length + c0.length;
  const cues = new EbmlWriter()
    .master(ID.Cues, (cw) => {
      cw.master(ID.CuePoint, (p) => {
        p.u(ID.CueTime, 0);
        p.master(ID.CueTrackPositions, (tp) => {
          tp.u(ID.CueTrack, 1);
          tp.u(ID.CueClusterPosition, 0);
        });
      });
      cw.master(ID.CuePoint, (p) => {
        p.u(ID.CueTime, 2000);
        p.master(ID.CueTrackPositions, (tp) => {
          tp.u(ID.CueTrack, 1);
          tp.u(ID.CueClusterPosition, cluster1PosInSegment);
        });
      });
    })
    .done();

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(voidEl);
  root.raw(encodeId(ID.Segment));
  root.raw(new Uint8Array([0xff])); // Segment 未知长度
  root.raw(info); root.raw(tracks); root.raw(c0); root.raw(c1); root.raw(cues);
  return { bytes: root.done() };
}

/**
 * Matroska 变体：AVC+AAC+FLAC 三轨（验证 Codec 映射与私有数据解析），
 * 无 Cues（验证定位兜底路径）。
 */
export function makeMkvWithAvcAacFlac() {
  const header = ebmlHeader('matroska');
  const info = infoWriter(1000);
  const tracks = tracksWriter((w) => {
    trackVideoAVC(w);
    trackAudioAAC(w);
    trackAudioFLAC(w);
  });

  const c0 = clusterWriter(0, [
    simpleBlockBytes({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [pattern(0x11, 12)] }),
    simpleBlockBytes({ trackNumber: 2, relTimecode: 0, keyframe: true, frames: [pattern(0x22, 8)] }),
    simpleBlockBytes({ trackNumber: 3, relTimecode: 0, keyframe: true, frames: [pattern(0x33, 16)] }),
  ]);

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + c0.length));
  root.raw(info); root.raw(tracks); root.raw(c0);
  return { bytes: root.done() };
}

/** 断言用的期望值常量表 */
export const EXPECT_WEBM = Object.freeze({
  container: 'webm',
  durationUs: 4_000_000,
  timecodeScaleNs: 1_000_000,
  muxingApp: 'player-mkv fixture',
  tracks: [
    { id: 1, type: 'video', codec: 'vp09', family: 'vp9', supported: true, width: 320, height: 240 },
    { id: 2, type: 'audio', codec: 'opus', family: 'opus', supported: true, channels: 2, sampleRate: 48000 },
  ],
  /** 文件序样本概览：[trackId, timestampUs, keyframe, 帧长, durationUs|null] */
  samplesInOrder: [
    [1, 0, true, 4, null],
    [2, 0, true, 10, null],
    [2, 0, true, 20, null],
    [2, 0, true, 30, null],
    [1, 1_500_000, false, 6, 40_000],
    [2, 1_500_000, true, 25, null],
    [2, 1_500_000, true, 25, null],
    [1, 2_000_000, true, 8, null],
  ],
  cueCount: 2,
});

export const EXPECT_MKV_AVC = Object.freeze({
  container: 'matroska',
  durationUs: 1_000_000,
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.64001F', family: 'h264', supported: true, width: 1920, height: 1080 },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', family: 'aac', supported: true },
    { id: 3, type: 'audio', codec: 'flac', family: 'flac', supported: true },
  ],
});
