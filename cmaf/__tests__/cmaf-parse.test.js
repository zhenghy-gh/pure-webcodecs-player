/**
 * CMAF 模块单测：chunk 解析 / init 推导 / WebCodecs 配置 / LL-HLS part 策略
 *
 * fixture 策略：复用 hls 模块的 fMP4 构造器程序化生成合法字节流（零外网、零大文件）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import {
  probe,
  splitChunks,
  parseInitSegment,
} from '../src/chunk-parser.js';
import {
  decoderConfigsFromInit,
  codecStringFromAvcC,
  codecStringFromAsc,
  CmafWebCodecsPlayer,
} from '../src/webcodecs.js';
import {
  PartTimeline,
  PartState,
  buildBlockingReloadUrl,
  nextPollTarget,
  shouldPrefetchPreloadHint,
} from '../src/llhls-parts.js';

/* ---------------- 合成 fixture ---------------- */

const FAKE_AVC_C = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50,
  0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
]);
const ASC = new Uint8Array([0x12, 0x10]); // AOT=2(LC) 44.1kHz 双声道

function makeVideoTrak() {
  return {
    id: 1,
    type: 'video',
    codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: FAKE_AVC_C },
    width: 640,
    height: 360,
    timescale: 90000,
  };
}
function makeAudioInit() {
  return fmp4.buildInit([
    {
      id: 2,
      type: 'audio',
      codec: 'mp4a.40.2',
      description: { tag: 'esds', bytes: ASC },
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    },
  ]);
}
function makeVideoFrames(baseDts, count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      dts: baseDts + i * 3003,
      pts: baseDts + i * 3003,
      duration: 3003,
      keyframe: i === 0,
      data: new Uint8Array(48 + i).fill(i + 1),
    });
  }
  return frames;
}

/** 组装一条完整 CMAF 轨：init + N 个 chunk */
function buildTrackBytes(chunkCount = 3) {
  const init = fmp4.buildInit([makeVideoTrak()]);
  const parts = [init];
  for (let c = 0; c < chunkCount; c++) {
    const frag = fmp4.buildFragment({ trackId: 1, samples: makeVideoFrames(c * 9009, 3), hasCts: true });
    parts.push(frag);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return { buf, init };
}

/* ---------------- probe / splitChunks ---------------- */

test('probe：styp 高置信 / ftyp 中置信 / 随机字节不命中', () => {
  const { buf, init } = buildTrackBytes(1);
  // 完整轨以 init(ftyp) 开头 → 中置信（可能是普通 mp4）
  assert.deepEqual(probe(buf), { confidence: 0.6, container: 'cmaf' });
  // 纯 chunk 流（styp 开头）→ 高置信
  assert.deepEqual(probe(init.subarray(0, 0).length ? buf : makeChunkOnlyStream()), {
    confidence: 0.95,
    container: 'cmaf',
  });
  assert.equal(probe(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99])), null);
});

/** 只含 styp 分片的流（无 init 前缀），用于验证 styp 探测 */
function makeChunkOnlyStream() {
  return fmp4.buildFragment({ trackId: 1, samples: makeVideoFrames(0, 2), hasCts: true });
}

test('splitChunks：init 段单独识别、chunk 按 styp 切分且样本表正确', () => {
  const { buf } = buildTrackBytes(3); // init + 3 chunks，每 chunk 3 帧
  const { chunks, initRange } = splitChunks(buf);

  assert.ok(initRange, 'init 段应被单独识别（ftyp 起始且不含 moof）');
  assert.equal(chunks.length, 3, '应切出 3 个 chunk');
  chunks.forEach((c, i) => {
    assert.equal(c.styp, true);
    assert.equal(c.tracks.length, 1);
    const t = c.tracks[0];
    assert.equal(t.trackId, 1);
    assert.equal(t.samples.length, 3, `chunk${i} 应含 3 样本`);
    // baseTime 随 chunk 递增：c*9009 ticks
    assert.equal(t.baseTime, i * 9009);
    // 关键帧仅首样本
    assert.equal(t.samples[0].keyframe, true);
    assert.equal(t.samples[1].keyframe || t.samples[2].keyframe, false);
    // 数据区指针落在缓冲内且互不重叠、顺序推进
    if (i > 0) {
      assert.ok(
        t.samples[0].dataStart > chunks[i - 1].tracks[0].samples[2].dataStart,
        'chunk 边界后样本数据地址应推进'
      );
    }
  });

  // 尺寸守恒：所有样本 size 与 trun 声明一致（48+i）
  const allSizes = chunks.flatMap((c) => c.tracks[0].samples.map((s) => s.size));
  assert.deepEqual(allSizes, [48, 49, 50, 48, 49, 50, 48, 49, 50]);
});

test('splitChunks：无 styp 的裸 fragment 流也能切（容错）', () => {
  const fragOnly = fmp4.buildFragment({ trackId: 1, samples: makeVideoFrames(0, 2), hasCts: true });
  // 剥掉首个 styp box，模拟无 styp 的裸流
  const dv = new DataView(fragOnly.buffer, fragOnly.byteOffset, fragOnly.byteLength);
  const stypSize = dv.getUint32(0);
  const bare = fragOnly.subarray(stypSize);
  const { chunks } = splitChunks(bare);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].styp, false);
});

/* ---------------- parseInitSegment / WebCodecs 配置推导 ---------------- */

test('parseInitSegment：提取 avcC 与 AudioSpecificConfig', () => {
  const init = fmp4.buildInit([
    makeVideoTrak(),
    {
      id: 2,
      type: 'audio',
      codec: 'mp4a.40.2',
      description: { tag: 'esds', bytes: ASC },
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    },
  ]);
  const info = parseInitSegment(init);
  assert.ok(info.video, '应有视频轨');
  assert.equal(info.video.entryType, 'avc1');
  assert.ok(info.video.description, '应提取到 avcC 字节');
  assert.deepEqual(Array.from(info.video.description.slice(0, 4)), [0x01, 0x64, 0x00, 0x1f]);
  assert.equal(info.video.timescale, 90000, 'mdhd timescale 应解析为 90000');

  assert.ok(info.audio, '应有音频轨');
  assert.equal(info.audio.codecAot, 2);
  assert.equal(info.audio.timescale, 44100);
});

test('codec 串推导符合契约 §3（avc1.PPCCLL / mp4a.40.AOT）', () => {
  assert.equal(codecStringFromAvcC(FAKE_AVC_C), 'avc1.64001f'); // High@3.1
  assert.equal(codecStringFromAsc(ASC), 'mp4a.40.2');
  // 契约 §3：禁止编造 profile——无法解析返回 null，调用方跳过该轨
  assert.equal(codecStringFromAvcC(null), null);
  assert.equal(codecStringFromAvcC(new Uint8Array(2)), null);
});

test('decoderConfigsFromInit：产出 WebCodecs 可用配置', () => {
  const init = fmp4.buildInit([makeVideoTrak()]);
  const cfg = decoderConfigsFromInit(init);
  assert.equal(cfg.video.codec, 'avc1.64001f');
  assert.ok(cfg.video.optimizeForLatency, 'LL 方向应开启 optimizeForLatency');
  assert.ok(cfg.video.description instanceof Uint8Array);
  assert.equal(cfg.videoTrack.timescale, 90000);
});

test('Node 下 CmafWebCodecsPlayer 抛 NOT_SUPPORTED（契约 §0.3）', () => {
  assert.throws(() => new CmafWebCodecsPlayer(), (e) => e.code === 'NOT_SUPPORTED');
});

/* ---------------- LL-HLS part 加载策略骨架 ---------------- */

const PLAYLIST_SEGMENTS = [
  {
    sn: 100,
    parts: [
      { uri: 'p1.mp4', duration: 0.5, independent: false, gap: false },
      { uri: 'p2.mp4', duration: 0.5, independent: true, gap: false },
    ],
  },
  {
    sn: 101,
    parts: [
      { uri: 'p3.mp4', duration: 0.5, independent: false, gap: false },
      { uri: 'p4.mp4', duration: 0.5, independent: true, gap: false },
    ],
  },
];

test('PartTimeline：合并清单、状态不回退、gap 标记', () => {
  const tl = new PartTimeline({ partTargetDuration: 0.5 });
  tl.updateFromPlaylist(PLAYLIST_SEGMENTS);
  assert.equal(tl.parts.size, 4);
  assert.equal(tl.lastMsn, 101);

  tl.markLoading('p3.mp4');
  tl.updateFromPlaylist(PLAYLIST_SEGMENTS); // 重复合并不得把 loading 回退为 pending
  assert.equal([...tl.parts.values()].find((p) => p.uri === 'p3.mp4').state, PartState.LOADING);

  const gapPlaylist = [
    { sn: 102, parts: [{ uri: 'p5.mp4', duration: 0.5, independent: true, gap: true }] },
  ];
  tl.updateFromPlaylist(gapPlaylist);
  assert.equal([...tl.parts.values()].find((p) => p.uri === 'p5.mp4').state, PartState.GAP);
});

test('pickNext：起播时优先最近的 INDEPENDENT part', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist(PLAYLIST_SEGMENTS);
  const startup = tl.pickNext({ startup: true });
  assert.equal(startup.length, 1);
  assert.equal(startup[0].uri, 'p4.mp4');

  const normal = tl.pickNext({ maxAhead: 2 });
  assert.equal(normal.length, 2);
  assert.deepEqual(normal.map((p) => p.uri), ['p3.mp4', 'p4.mp4']);
});

test('canStartPlayback：全部就绪才允许起播', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist([{ sn: 1, parts: [{ uri: 'a.mp4', duration: 0.5, independent: true }] }]);
  assert.equal(tl.canStartPlayback(), false, '尚无 READY part');
  tl.markReady('a.mp4');
  assert.equal(tl.canStartPlayback(), true);
  tl.markLoading('a.mp4');
  assert.equal(tl.canStartPlayback(), false, 'loading 中不允许');
});

test('阻塞式重载 URL 与轮询目标', () => {
  const url = buildBlockingReloadUrl('https://cdn/live/1080p.m3u8', { msn: 102, part: 3 });
  assert.equal(url, 'https://cdn/live/1080p.m3u8?_HLS_msn=102&_HLS_part=3');

  const target = nextPollTarget({
    lastMsn: 100,
    lastPart: 2,
    serverControl: { canBlockReload: true },
  });
  assert.deepEqual(target, { msn: 101, part: 2 });

  const nonBlock = nextPollTarget({ lastMsn: 100, lastPart: 2, serverControl: null });
  assert.deepEqual(nonBlock, { msn: 101, part: null });
});

test('PRELOAD-HINT 预取决策与去重', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist(PLAYLIST_SEGMENTS);
  const hint = { type: 'PART', uri: 'p5.mp4' };
  assert.equal(shouldPrefetchPreloadHint(hint, tl), true, '未知 part 应预取');
  assert.equal(
    shouldPrefetchPreloadHint({ type: 'PART', uri: 'p4.mp4' }, tl),
    false,
    '时间线已有的 part 不重复取'
  );
  assert.equal(shouldPrefetchPreloadHint(hint, tl, { inFlight: 2 }), false, '并发上限内不再取');
  assert.equal(shouldPrefetchPreloadHint({ type: 'MAP', uri: 'init.mp4' }, tl), false, '非 PART 类型不预取');
});
