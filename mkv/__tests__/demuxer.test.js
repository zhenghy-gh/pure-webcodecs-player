/**
 * demuxer.test.js —— MkvDemuxer 契约面单测（CONTRACTS v0.2 §1/§2/§10）
 *
 * 覆盖：probe 矩阵 / open→MediaInfo / Track 形状(description/text/und) /
 * readSample pull + EOS / STATE_ERROR / seek(Cues 与线性索引) / 事件 /
 * 未知长度变体 / 文本轨 / 加密轨 NOT_SUPPORTED / BlobSource / FetchSource 双模式 /
 * createDemuxer 工厂。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MkvDemuxer, createDemuxer, probe as mkvProbe,
  BufferSource, BlobSource, FetchSource,
  EbmlWriter, ID, encodeId, encodeSize,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';
import {
  makeMinimalWebm, makeUnknownSizeWebm, makeMkvWithAvcAacFlac,
  makeWebmWithTextTrack, makeWebmWithEncryptedAudio, makeWebmNoDuration,
  EXPECT_WEBM, EXPECT_MKV_AVC,
} from './fixtures/make-fixture.mjs';

const U8 = (arr) => new Uint8Array(arr);

// ── probe（§2.2 静态嗅探）────────────────────────────────

test('probe：webm/matroska 命中 confidence≥0.9；垃圾字节 null；截断安全', () => {
  const { bytes } = makeMinimalWebm();
  const hit = mkvProbe(bytes);
  assert.equal(hit.container, 'webm');
  assert.ok(hit.confidence >= 0.9);

  const mk = makeMkvWithAvcAacFlac().bytes;
  assert.equal(mkvProbe(mk).container, 'mkv');

  assert.equal(mkvProbe(U8([0, 1, 2, 3, 4, 5])), null);
  assert.equal(mkvProbe(new Uint8Array(0)), null);
  // 只有魔数前 3 字节 → 不命中
  assert.equal(mkvProbe(bytes.subarray(0, 3)), null);
  // 只有魔数 4 字节 → 保守命中
  const onlyMagic = mkvProbe(bytes.subarray(0, 4));
  assert.ok(onlyMagic && onlyMagic.confidence >= 0.8);
});

// ── open → MediaInfo / Track ────────────────────────────

async function readyWebm() {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  return d;
}

test('open：MediaInfo 容器/时长/seekable/metadata', async () => {
  const d = await readyWebm();
  const mi = d.mediaInfo;
  assert.equal(mi.container, 'webm');
  assert.equal(mi.durationUs, EXPECT_WEBM.durationUs);
  assert.equal(mi.live, false);
  assert.equal(mi.seekable, true);
  assert.equal(mi.metadata.title, undefined); // 夹具未写 Title
  assert.equal(mi.metadata.muxingApp, 'player-mkv fixture');
  assert.deepEqual(d.metadata.durationUs, EXPECT_WEBM.durationUs);
});

test('open：tracks 排序(video>audio) 与契约字段', async () => {
  const d = await readyWebm();
  assert.equal(d.tracks.length, 2);
  const [v, a] = d.tracks;
  assert.equal(v.type, 'video');
  assert.equal(a.type, 'audio');
  assert.equal(v.codec, 'vp09'); // 无参数集 → 家族基础串，不编造 profile
  assert.equal(a.codec, 'opus');
  assert.ok(v.description === null || v.description instanceof Uint8Array);
  assert.equal(a.description?.length, 19); // OpusHead
  assert.equal(a.numberOfChannels, 2);
  assert.equal(a.sampleRate, 48000);
  assert.equal(a.language, 'und');
  assert.equal(v.timescale, 1000); // 诊断用
  assert.equal(d.tracks[0].extensions.mkvCodecId, 'V_VP9');
  // 排序：video 在前
  assert.ok(['audio', 'text'].includes(d.tracks[1].type));
});

test('readSample：pull 主通道、EOS null、Sample 形状与关键帧规则', async () => {
  const d = await readyWebm();
  const rows = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    rows.push([s.trackId, s.timestamp, s.keyframe, s.size, s.duration]);
    assert.equal(s.dts, s.timestamp);       // MKV 无独立 DTS
    assert.equal(s.codec, 'vp09');
    assert.ok(s.data instanceof Uint8Array);
    assert.ok(Number.isInteger(s.index));
  }
  assert.deepEqual(rows, [
    [1, 0, true, 4, 0],
    [1, 1_500_000, false, 6, 40_000],
    [1, 2_000_000, true, 8, 0],
  ]);

  // 音频轨关键帧恒 true（契约 §1.1）
  let audioAllKf = true;
  let count = 0;
  for (;;) {
    const s = await d.readSample(2);
    if (s === null) break;
    count++;
    if (!s.keyframe) audioAllKf = false;
  }
  assert.equal(count, 5);
  assert.equal(audioAllKf, true);
});

test('samples()：糖层等价 readSample 循环', async () => {
  const d = await readyWebm();
  const rows = [];
  for await (const s of d.samples(2)) rows.push(s.timestamp);
  assert.deepEqual(rows, [0, 0, 0, 1_500_000, 1_500_000]);
});

test('STATE_ERROR：未 open 访问 tracks/readSample；销毁后访问', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  assert.throws(() => d.tracks, (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');

  await d.open();
  await d.destroy();
  assert.throws(() => d.mediaInfo, (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');
  await d.destroy(); // 幂等
});

test('readSample：未知轨道 PARSE_ERROR', async () => {
  const d = await readyWebm();
  await assert.rejects(() => d.readSample(99), (e) => e.code === 'PARSE_ERROR');
});

test('事件：media-info 恰一次；两轨 EOS 后 end(eos)', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  let mediaInfoCount = 0;
  let endPayload = null;
  d.on('media-info', () => mediaInfoCount++);
  d.on('end', (p) => { endPayload = p; });
  await d.open();
  for await (const s of d.samples(1)) void s;
  for await (const s of d.samples(2)) void s;
  assert.equal(mediaInfoCount, 1);
  assert.deepEqual(endPayload, { reason: 'eos' });
});

// ── seek ────────────────────────────────────────────────

test('seek：Cues 定位 + actualTimestampUs + 迭代窗口重置', async () => {
  const { bytes, cuesOffsetInSegmentForCluster1 } = makeMinimalWebm();
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();

  const r = await d.seek(1_600_000);
  assert.equal(r.actualTimestampUs, 2_000_000);
  assert.equal(await d.locate(1_600_000), d.segmentDataStart + cuesOffsetInSegmentForCluster1);

  // 视频轨从新窗口拉取：首样本即落点关键帧
  const s1 = await d.readSample(1);
  assert.equal(s1.timestamp, 2_000_000);
  assert.equal(s1.keyframe, true);
  // 音频轨在 1.6s 后无样本 → EOS
  assert.equal(await d.readSample(2), null);
});

test('seek：无 Cues 时线性扫簇建索引后可定位（matroska 变体）', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMkvWithAvcAacFlac().bytes));
  await d.open();
  assert.equal(d.cues.length, 0);
  assert.equal(d.clusterIndex.length, 0);

  const r = await d.seek(500_000); // 唯一簇 @0ms，500ms 之后无样本
  assert.equal(r.actualTimestampUs, 1_000_000); // 回退钳制到时长
  assert.equal(d.clusterIndex.length, 1);
});

test('seek：负数/非数值目标拒绝；空簇段 SEEK_UNSUPPORTED', async () => {
  const d = await readyWebm();
  await assert.rejects(() => d.seek(-1), (e) => e.code === 'PARSE_ERROR');
  await assert.rejects(() => d.seek(Number.NaN), (e) => e.code === 'PARSE_ERROR');
});

// ── 变体矩阵 ────────────────────────────────────────────

test('未知长度 Segment/Cluster 变体：open+全量拉取与常规版一致', async () => {
  const d = new MkvDemuxer(new BufferSource(makeUnknownSizeWebm().bytes));
  const mi = await d.open();
  assert.equal(mi.durationUs, EXPECT_WEBM.durationUs);
  const all = [];
  for await (const s of d.samples(1)) all.push([s.trackId ?? 1, s.timestamp, s.keyframe, s.size]);
  assert.equal(all.length, 3);
});

test('文本轨：type=text、codec=x-srt、UTF-8 数据透出、keyframe 恒 true', async () => {
  const d = new MkvDemuxer(new BufferSource(makeWebmWithTextTrack().bytes));
  await d.open();
  const textTrack = d.tracks.find((t) => t.type === 'text');
  assert.equal(textTrack.codec, 'x-srt');
  assert.equal(textTrack.language, 'und');

  const cues = [];
  for await (const s of d.samples(3)) {
    cues.push({ ts: s.timestamp, text: new TextDecoder().decode(s.data), kf: s.keyframe });
  }
  assert.deepEqual(cues, [
    { ts: 0, text: 'Hello', kf: true },
    { ts: 1_000_000, text: '世界', kf: true },
  ]);
});

test('加密轨：open 正常（标红不崩），readSample 报 NOT_SUPPORTED', async () => {
  const d = new MkvDemuxer(new BufferSource(makeWebmWithEncryptedAudio().bytes));
  const mi = await d.open();
  assert.equal(mi.tracks.length, 2);
  const audio = mi.tracks.find((t) => t.id === 2);
  assert.equal(audio.encrypted, true);
  assert.equal(audio.supported, false);

  const v = await d.readSample(1); // 视频轨不受影响
  assert.equal(v.timestamp, 0);
  await assert.rejects(() => d.readSample(2), (e) => e.code === 'NOT_SUPPORTED');
});

test('无 Duration 变体：durationUs=null、DateUTC 进 metadata', async () => {
  const d = new MkvDemuxer(new BufferSource(makeWebmNoDuration().bytes));
  const mi = await d.open();
  assert.equal(mi.durationUs, null);
  assert.equal(mi.seekable, true);
  assert.match(mi.metadata.dateUTC, /^2025-08-25T12:00/);
});

test('matroska 三编码变体：avc1/mp4a.40.2/flac 映射与 description', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMkvWithAvcAacFlac().bytes));
  const mi = await d.open();
  const [v, a, f] = mi.tracks;
  assert.equal(v.codec, 'avc1.64001F');
  assert.equal(v.bitstreamFormat, 'avc');      // 有 avcC description
  assert.equal(v.width, 1920);
  assert.equal(a.codec, 'mp4a.40.2');          // core aacCodecString 构造
  assert.equal(f.codec, 'flac');
  assert.equal(f.description?.[0], 0x66);      // "fLaC" magic 开头
});

// ── 数据源与工厂 ────────────────────────────────────────

test('BlobSource：File/Blob 输入走 createDemuxer 全流程', async () => {
  const blob = new Blob([makeMinimalWebm().bytes], { type: 'video/webm' });
  const d = await createDemuxer(blob);
  assert.equal(d.state, 'ready');
  assert.equal(d.mediaInfo.container, 'webm');
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0);
  await d.destroy();
});

test('createDemuxer：非 Matroska 内容 reject PROBE_FAILED', async () => {
  await assert.rejects(
    () => createDemuxer(U8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    (e) => e.code === 'PROBE_FAILED',
  );
});

/** 构造可控 fetch 桩 */
function stubFetch({ acceptRanges, totalLen, chunkBytes = 64 }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init);
    const rangeHeader = init.headers?.Range;
    const makeBody = (start, end) => new ReadableStream({
      start(controller) {
        let pos = start;
        const push = () => {
          if (pos >= end) { controller.close(); return; }
          const n = Math.min(chunkBytes, end - pos);
          controller.enqueue(fullBytes.subarray(pos, pos + n));
          pos += n;
        };
        // 同步推完即可（测试数据很小）
        while (pos < end) push();
        if (start >= end) controller.close();
      },
    });
    if (init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) => (k.toLowerCase() === 'accept-ranges'
            ? (acceptRanges ? 'bytes' : 'none')
            : k.toLowerCase() === 'content-length' ? String(totalLen) : null),
        },
        body: null,
      };
    }
    if (rangeHeader && acceptRanges) {
      const m = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, fullBytes.length);
      return {
        ok: true, status: 206,
        headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${start}-${end - 1}/${fullBytes.length}` : null) },
        arrayBuffer: async () => fullBytes.slice(start, end).buffer,
        body: makeBody(start, end),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      body: makeBody(0, fullBytes.length),
    };
  };
  return { fetchImpl, calls };
}

const fullBytes = makeMinimalWebm().bytes;

test('FetchSource：Range 随机读模式（HEAD 探测 + Range 读取）', async () => {
  const { fetchImpl } = stubFetch({ acceptRanges: true, totalLen: fullBytes.length });
  const src = await FetchSource.open('https://fake.example/a.webm', { fetchImpl });
  assert.equal(src.acceptRanges, true);
  assert.equal(src.size, fullBytes.length);

  const d = new MkvDemuxer(src);
  await d.open();
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0);
  await src.close();
});

test('FetchSource：无 Range 服务退化为顺序流且可完整解析', async () => {
  const { fetchImpl } = stubFetch({ acceptRanges: false, totalLen: fullBytes.length });
  const src = await FetchSource.open('https://fake.example/b.webm', { fetchImpl });
  assert.equal(src.acceptRanges, false);

  const d = new MkvDemuxer(src);
  await d.open(); // open 的头部扫描全部向前 → 顺序流可用
  let n = 0;
  for await (const s of d.samples(1)) n++;
  assert.ok(n >= 3);
  await src.close();
});

test('getBufferedRanges：点播整段范围', async () => {
  const d = await readyWebm();
  assert.deepEqual(d.getBufferedRanges(1), [{ startUs: 0, endUs: 4_000_000 }]);
});

test('pause/resume/start：点播容器下为安全空操作', async () => {
  const d = await readyWebm();
  assert.doesNotThrow(() => { d.pause(); d.resume(); d.start(); });
});


// ── 评审修复回归（round-1）──────────────────────────────

/** 内联拼装：自定义簇内容的最小 webm（供畸形块/负 relTc 用例） */
function buildMiniWebm({ trackBuilds, clusterChildren }) {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000);
    w.f(ID.Duration, 5000, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, (w) => {
    for (const b of trackBuilds) b(w);
  }).done();
  const cluster = new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, 1000);
    for (const c of clusterChildren) w.raw(c);
  }).done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cluster.length));
  root.raw(info); root.raw(tracks); root.raw(cluster);
  return root.done();
}

const vp9Track = (w) => {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 1); t.s(ID.CodecID, 'V_VP9');
    t.master(ID.Video, (v) => { v.u(ID.PixelWidth, 64); v.u(ID.PixelHeight, 64); });
  });
};

test('评审回归：畸形块头 → readSample reject PARSE_ERROR 且 error 双通道', async () => {
  // SimpleBlock 载荷仅 2 字节：块头必然不可解析
  const badBlock = new EbmlWriter().leaf(ID.SimpleBlock, Uint8Array.of(0x82, 0x00)).done();
  const bytes = buildMiniWebm({ trackBuilds: [vp9Track], clusterChildren: [badBlock] });

  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  let errEvents = 0;
  d.on('error', () => errEvents++);
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'PARSE_ERROR');
  assert.equal(errEvents, 1); // 双通道：reject 与事件各一次
});

test('评审回归：Xiph 锁存链截断 → 块级跳过（不再 NaN 出垃圾帧），流不中断', async () => {
  // 块头[track=1][rel=0][flags=0x02(Xiph)] 后接截断的锁存链：帧数1 + 锁存 255 即断。
  // 语义：块边界已知可安全跳过 → 单块丢弃 + warn，不打断整条流（区别于块头损坏的致命 PARSE_ERROR）。
  const body = Uint8Array.of(0x81, 0x00, 0x00, 0x02, 0x01, 0xff);
  const badBlock = new EbmlWriter().leaf(ID.SimpleBlock, body).done();
  const goodBlock = new EbmlWriter().leaf(ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: 100, keyframe: true, frames: [new Uint8Array(3)] })).done();
  const bytes = buildMiniWebm({ trackBuilds: [vp9Track], clusterChildren: [badBlock, goodBlock] });

  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  let errEvents = 0;
  d.on('error', () => { errEvents++; });

  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const stamps = [];
    for (;;) {
      const s = await d.readSample(1);
      if (s === null) break;
      stamps.push(s.timestamp);
    }
    assert.deepEqual(stamps, [1_100_000]); // 坏块被跳过，后续好块正常产出
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warned, true, '应有 warn 级告警');
  assert.equal(errEvents, 0); // 非致命：不发 'error'
});

test('评审回归：负相对时间码（簇内回看）正确换算 µs', async () => {
  const block = new EbmlWriter().leaf(
    ID.SimpleBlock,
    makeBlock({ trackNumber: 1, relTimecode: -500, keyframe: true, frames: [new Uint8Array(4)] }),
  ).done();
  const bytes = buildMiniWebm({ trackBuilds: [vp9Track], clusterChildren: [block] });

  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 500_000); // 簇 tc=1000ms + rel=-500ms
});

test('评审回归：SeekHead→Cues 定位路径覆盖', async () => {
  // 结构顺序：EBML / Segment[ SeekHead(指向 Cues), Info, Tracks, Cluster, Cues ]
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1); w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000); w.f(ID.Duration, 3000, 4);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, vp9Track).done();
  const cluster = new EbmlWriter().master(ID.Cluster, (w) => {
    w.u(ID.ClusterTimecode, 0);
    w.raw(new EbmlWriter().leaf(ID.SimpleBlock,
      makeBlock({ trackNumber: 1, relTimecode: 0, keyframe: true, frames: [new Uint8Array(4)] })).done());
  }).done();
  // SeekPosition 用定宽 8 字节叶子 → SeekHead 长度与取值无关，可两趟构造：
  // 先以 0 建一次得长度 L，再以真实偏移(含 L 自身)重建，长度不变。
  const seekHeadBytes = (cuesOffset) => {
    const pos = new Uint8Array(8);
    const hi = Math.floor(cuesOffset / 0x100000000);
    const lo = cuesOffset >>> 0;
    for (let i = 0; i < 4; i++) pos[3 - i] = (hi >>> (8 * i)) & 0xff;
    for (let i = 0; i < 4; i++) pos[7 - i] = (lo >>> (8 * i)) & 0xff;
    return new EbmlWriter().master(ID.SeekHead, (w) => {
      w.master(ID.Seek, (sk) => {
        sk.b(ID.SeekID, encodeId(ID.Cues));
        sk.raw(encodeId(ID.SeekPosition));
        sk.raw(encodeSize(pos.length));
        sk.raw(pos);
      });
    }).done();
  };
  const seekHeadL0 = seekHeadBytes(0).length;
  const cuesOffset = seekHeadL0 + info.length + tracks.length + cluster.length;
  const seekHead = seekHeadBytes(cuesOffset); // 真实 SeekPosition（相对 Segment 数据起点）
  assert.equal(seekHead.length, seekHeadL0, '定宽编码下 SeekHead 长度应稳定');
  const cuesBase = seekHead.length + info.length + tracks.length; // 簇在段内偏移
  const cues = new EbmlWriter().master(ID.Cues, (cw) => {
    cw.master(ID.CuePoint, (pt) => {
      pt.u(ID.CueTime, 0);
      pt.master(ID.CueTrackPositions, (tp) => {
        tp.u(ID.CueTrack, 1);
        tp.u(ID.CueClusterPosition, cuesBase);
      });
    });
  }).done();

  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(seekHead.length + info.length + tracks.length + cluster.length + cues.length));
  root.raw(seekHead); root.raw(info); root.raw(tracks); root.raw(cluster); root.raw(cues);

  const d = new MkvDemuxer(new BufferSource(root.done()));
  await d.open();
  assert.equal(d.cues.length, 1, 'SeekHead 应把 Cues 路径接通（open 惰性停止于首簇后仍须命中）');
  assert.equal(await d.locate(0), d.segmentDataStart + cuesBase);
});

test('评审回归：PCM 按 bitDepth 映射契约家族串', async () => {
  const pcmTrack = (codecId, bitDepth) => (w) => {
    w.master(ID.TrackEntry, (t) => {
      t.u(ID.TrackNumber, 1); t.u(ID.TrackType, 2);
      t.s(ID.CodecID, codecId);
      t.master(ID.Audio, (a) => { a.f(ID.SamplingFrequency, 48000, 4); a.u(ID.Channels, 2); a.u(0x62a4 /* BitDepth */, bitDepth); });
    });
  };
  for (const [cid, depth, want] of [
    ['A_PCM/INT/LIT', 8, 'pcm-u8'],
    ['A_PCM/INT/LIT', 16, 'pcm-s16'],
    ['A_PCM/INT/LIT', 24, 'pcm-s24'],
    ['A_PCM/INT/LIT', 32, 'pcm-s32'],
    ['A_PCM/FLOAT/IEEE', 32, 'pcm-f32'],
    ['A_PCM/INT/BIG', 16, 'pcm-s16be'],
  ]) {
    const bytes = buildMiniWebm({ trackBuilds: [pcmTrack(cid, depth)], clusterChildren: [] });
    const d = new MkvDemuxer(new BufferSource(bytes));
    await d.open();
    assert.equal(d.tracks[0].codec, want, `${cid}@${depth}`);
  }
});

test('评审回归：Range GET 被服务器以 200 整文件应答 → reject SOURCE_ERROR', async () => {
  const fullBytes = makeMinimalWebm().bytes;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'accept-ranges' ? 'bytes'
          : k.toLowerCase() === 'content-length' ? String(fullBytes.length) : null) },
        body: null,
      };
    }
    if (init.headers?.Range) {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => fullBytes.slice().buffer };
    }
    throw new Error('unexpected');
  };
  const src = await FetchSource.open('https://fake.example/liar.webm', { fetchImpl });
  await assert.rejects(() => src.read(10, 4), (e) => e.code === 'SOURCE_ERROR');
});
