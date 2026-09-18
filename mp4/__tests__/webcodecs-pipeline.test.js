import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoConfig, buildAudioConfig, Mp4WebCodecsPipeline } from '../src/webcodecs-pipeline.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import {
  buildProgressiveVideoFixture,
  buildFragmentedFixture,
  makeAscFixture,
} from './fixtures.js';

function makeTrack(partial) {
  return { id: 1, type: 'video', codec: '', codecPrivate: null, sampleEntryType: '', timescale: 1000, duration: 0, language: 'und', ...partial };
}

test('buildVideoConfig：纯函数构造（Node 无 WebCodecs 也可测）', () => {
  const cfg = buildVideoConfig(makeTrack({
    type: 'video',
    codec: 'avc1.42001E',
    codecPrivate: new Uint8Array([1, 66, 0, 30]),
    width: 320,
    height: 240,
  }));
  assert.equal(cfg.codec, 'avc1.42001E');
  assert.equal(cfg.width, 320);
  assert.equal(cfg.height, 240);
  assert.ok(cfg.description instanceof Uint8Array);

  assert.throws(() => buildVideoConfig({ type: 'video' }), /codec/);
  assert.throws(() => buildVideoConfig({ type: 'audio' }), TypeError);
});

test('buildAudioConfig：AAC 配置带 AudioSpecificConfig', () => {
  const asc = makeAscFixture();
  const cfg = buildAudioConfig(makeTrack({
    type: 'audio',
    codec: 'mp4a.40.2',
    codecPrivate: asc,
    sampleRate: 44100,
    channelCount: 2,
  }));
  assert.equal(cfg.codec, 'mp4a.40.2');
  assert.equal(cfg.sampleRate, 44100);
  assert.equal(cfg.numberOfChannels, 2);
  assert.deepEqual([...cfg.description], [...asc]);
});

test('Node 环境无 WebCodecs：管线构造抛 STATE_ERROR', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  assert.throws(
    () => new Mp4WebCodecsPipeline(d, {}),
    (e) => e.code === 'STATE_ERROR',
  );
});

/* ==================================================================== */
/* 管线类可测化（env/浏览器依赖层）：Fake WebCodecs 全局 + 假 demuxer      */
/* ==================================================================== */

/** 临时改写 globalThis 若干属性，执行 fn（支持 async）后原样还原 */
async function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

class FakeVideoDecoder {
  static supported = true;
  static throws = false;
  static async isConfigSupported(config) {
    if (FakeVideoDecoder.throws) throw new Error('isConfigSupported exploded');
    return { supported: this.supported };
  }
  constructor(init) {
    this.init = init;
    this.configured = null;
    this.chunks = [];
    this.decodeQueueSize = 0;
    this.flushes = 0;
    this.resets = 0;
    this.closes = 0;
  }
  configure(c) { this.configured = c; }
  decode(chunk) { this.chunks.push(chunk); }
  async flush() { this.flushes += 1; }
  reset() { this.resets += 1; }
  close() { this.closes += 1; }
}

class FakeAudioDecoder extends FakeVideoDecoder {}
class FakeEncodedVideoChunk {
  constructor(init) { this.init = init; }
}
class FakeEncodedAudioChunk {
  constructor(init) { this.init = init; }
}

/** 假 demuxer：getMediaInfo/samples/readSampleData 最小面 */
function fakeDemuxer(tracks, samplesByTrack) {
  return {
    getMediaInfo: () => ({ container: 'mp4', tracks, durationUs: 0, seekable: false, live: false }),
    samples(trackId) {
      return (async function* () {
        for (const s of samplesByTrack[trackId] ?? []) yield s;
      })();
    },
    async readSampleData(sample) {
      sample.data = new Uint8Array([0xa0 + sample.index]);
      return sample.data;
    },
  };
}

/** 极简 stats 记录器 */
function makeStats() {
  return { demuxed: [], decodeErrors: [], decoded: 0, markDemuxed(size) { this.demuxed.push(size); }, markDecodeError(e) { this.decodeErrors.push(e); }, markSampleDecoded() { this.decoded += 1; } };
}

const V_TRACK = { id: 1, type: 'video', codec: 'avc1.42001E', width: 320, height: 240 };
const A_TRACK = { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 44100, channelCount: 2 };

function videoSamples(count, { withData = true } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    trackId: 1,
    timestamp: i * 33333,
    duration: 33333,
    size: 100 + i,
    keyframe: i === 0,
    ...(withData ? { data: new Uint8Array(100 + i) } : {}),
  }));
}

test('管线 supported()：isConfigSupported 三分支与配置缓存', async () => {
  const demuxer = fakeDemuxer([V_TRACK, A_TRACK], {});
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {});

    // 双支持
    const ok = await pipeline.supported();
    assert.deepEqual({ s: ok.supported, v: ok.video, a: ok.audio }, { s: true, v: true, a: true });
    assert.equal(pipeline.videoConfig.codec, 'avc1.42001E', 'videoConfig 已缓存');
    assert.equal(pipeline.audioConfig.sampleRate, 44100, 'audioConfig 已缓存');

    // 音频不支持 → supported 仍 true（视频或音频其一可解即可）
    FakeAudioDecoder.supported = false;
    const vOnly = await pipeline.supported();
    assert.equal(vOnly.supported, true);
    assert.equal(vOnly.audio, false);

    // 双不支持
    FakeVideoDecoder.supported = false;
    const none = await pipeline.supported();
    assert.equal(none.supported, false);
    assert.equal(none.reason, 'configs unsupported');
    FakeVideoDecoder.supported = true;
    FakeAudioDecoder.supported = true;

    // isConfigSupported 抛异常 → 显式 unsupported + reason
    FakeVideoDecoder.throws = true;
    const boom = await pipeline.supported();
    assert.equal(boom.supported, false);
    assert.match(boom.reason, /exploded/);
    FakeVideoDecoder.throws = false;
  });
});

test('管线 start()：双轨 pump、chunk 语义、stats 与 flush', async () => {
  const demuxer = fakeDemuxer(
    [V_TRACK, A_TRACK],
    {
      1: videoSamples(2),
      2: [{ index: 0, trackId: 2, timestamp: 0, duration: 23219, size: 8, keyframe: true, data: new Uint8Array(8) }],
    },
  );
  const stats = makeStats();
  const onVideoFrame = [];
  const errors = [];
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    EncodedAudioChunk: FakeEncodedAudioChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {
      stats,
      onVideoFrame: (f, meta) => onVideoFrame.push([f, meta]),
      onError: (e) => errors.push(e),
    });
    await pipeline.start();

    const vd = pipeline.videoDecoder;
    assert.equal(vd.chunks.length, 2);
    assert.deepEqual(vd.chunks.map((c) => c.init.type), ['key', 'delta']);
    assert.deepEqual(vd.chunks.map((c) => c.init.timestamp), [0, 33333]);
    assert.deepEqual(vd.chunks.map((c) => c.init.duration), [33333, 33333]);
    assert.ok(vd.chunks[0].init.data instanceof Uint8Array);
    assert.equal(vd.flushes, 1);
    assert.equal(vd.configured.codec, 'avc1.42001E');

    const ad = pipeline.audioDecoder;
    assert.equal(ad.chunks.length, 1);
    assert.equal(ad.chunks[0].init.type, 'key');
    assert.equal(ad.flushes, 1);

    // 双轨并发 pump，demuxed 顺序依赖微任务交错 → 按多重集比较
    assert.deepEqual([...stats.demuxed].sort((a, b) => a - b), [8, 100, 101]);
    assert.equal(pipeline._running, false, '结束后 _running 复位');

    // 解码器输出回调接线：output → stats + handlers
    vd.init.output('frame-x', { decoder: 'video' });
    assert.deepEqual(onVideoFrame[0], ['frame-x', { decoder: 'video' }]);
    assert.equal(stats.decoded, 1);
    const err = new Error('decode boom');
    vd.init.error(err);
    assert.deepEqual(errors, [err]);
    assert.deepEqual(stats.decodeErrors, [err]);
  });
});

test('管线 start()：fromSampleIndex 跳过、无 data 样本触发 readSampleData', async () => {
  const samples = videoSamples(3, { withData: false });
  const demuxer = fakeDemuxer([V_TRACK], { 1: samples });
  const readCalls = [];
  demuxer.readSampleData = async (sample) => {
    readCalls.push(sample.index);
    sample.data = new Uint8Array([sample.index]);
    return sample.data;
  };
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {});
    await pipeline.start({ fromSampleIndex: 1 });
    assert.deepEqual(readCalls, [1, 2], 'index<from 的样本被跳过且不读取');
    assert.deepEqual(pipeline.videoDecoder.chunks.map((c) => c.init.timestamp), [33333, 66666]);
  });
});

test('管线 start()：decode 抛错被捕获记 stats，pump 不中断', async () => {
  const demuxer = fakeDemuxer([V_TRACK], { 1: videoSamples(2) });
  const stats = makeStats();
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, { stats });
    const origDecode = FakeVideoDecoder.prototype.decode;
    FakeVideoDecoder.prototype.decode = function (chunk) {
      if (this.chunks.length === 1) throw new Error('bad chunk');
      origDecode.call(this, chunk);
    };
    try {
      await pipeline.start();
    } finally {
      FakeVideoDecoder.prototype.decode = origDecode;
    }
    assert.equal(stats.decodeErrors.length, 1);
    assert.match(stats.decodeErrors[0].message, /bad chunk/);
    assert.equal(pipeline.videoDecoder.chunks.length, 1, '第二个样本抛错被捕获，第一个已入队且 pump 不中断');
  });
});

test('管线背压：decodeQueueSize 超过 maxQueue 时让出，回落后继续', async () => {
  const demuxer = fakeDemuxer([V_TRACK], { 1: videoSamples(2) });
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, { maxQueue: 1 });
    await pipeline.start(); // 同步初始化完成后手工再压队列观察背压路径太脆，
    // 改为直接低层验证：重置状态后用可控队列驱动
    await pipeline.close();

    const vd = new FakeVideoDecoder();
    vd.decodeQueueSize = 3;
    const p2 = new Mp4WebCodecsPipeline(demuxer, { maxQueue: 1 });
    const origEnsure = p2._ensureDecoders.bind(p2);
    p2._ensureDecoders = async () => { await origEnsure(); p2.videoDecoder = vd; };
    const done = p2.start();
    // 让 pump 进入背压自旋（macrotask 让出），随后放行
    await new Promise((r) => setTimeout(r, 0));
    vd.decodeQueueSize = 0;
    await done;
    assert.equal(vd.chunks.length, 2);
  });
});

test('管线 reset()/close()：中止运行中的 pump、flush 不再调用、可重复 close', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const samples = videoSamples(3);
  const demuxer = fakeDemuxer([V_TRACK], { 1: samples });
  // 首个样本后挂起，模拟长跑 pump
  demuxer.samples = (trackId) => (async function* () {
    for (const s of samples) {
      yield s;
      await gate;
    }
  })();
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {});
    const running = pipeline.start();
    await new Promise((r) => setTimeout(r, 0)); // 等 pump 消费首个样本
    assert.equal(pipeline.videoDecoder.chunks.length, 1);

    const resetPromise = pipeline.reset();
    release(); // 解除挂起
    await resetPromise;
    await running; // pump 以 aborted 提前返回

    const vd = pipeline.videoDecoder;
    assert.equal(vd, null, 'reset 后解码器引用清空');
    assert.equal(pipeline._running, false);

    // close 幂等：无解码器也不抛
    await pipeline.close();
    await pipeline.close();
  });
});

test('管线 start()：运行中重复 start 抛 STATE_ERROR', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const samples = videoSamples(1);
  const demuxer = fakeDemuxer([V_TRACK], { 1: samples });
  demuxer.samples = (trackId) => (async function* () {
    for (const s of samples) {
      yield s;
      await gate;
    }
  })();
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
  }, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {});
    const running = pipeline.start();
    await new Promise((r) => setTimeout(r, 0));
    await assert.rejects(
      pipeline.start(),
      (e) => e.code === 'STATE_ERROR',
    );
    release();
    await running;
    await pipeline.close();
  });
});
