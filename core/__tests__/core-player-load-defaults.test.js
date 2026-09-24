/**
 * core-player-load-defaults.test.js
 *
 * 针对 core/src/player.js 的**默认管线选择 / 输入形态分发 / load 中止竞态 /
 * 泵错误路径**补测（既有测试已覆盖注入式 factory 的正向路径，此处聚焦此前
 * 零覆盖的分支）：
 *  - detectForMedia：默认 codec 清单 ∪ 媒体实际 codec 后深探测（含无 codec 轨跳过）
 *  - 默认管线工厂三态：hasWebCodecsCtor 命中 → WebCodecsPipeline；
 *    hasMseCtor 命中 → MsePipeline；两者皆无 → pipeline=null 仍可 load
 *  - load 输入形态：字符串 URL 走 demuxerFactory(String(input))、
 *    Blob 走 BlobDataSource、不支持的 input 类型抛 STATE_ERROR
 *  - load 重入：飞行中二次 load 返回同一 promise
 *  - load 中止竞态：capabilities 探测期间销毁（demuxer 被回收）、
 *    管线工厂迟到成功（管线被回收）、管线工厂当前代失败（demuxer 一并清理）
 *  - 切轨：playing 中成功切轨 → trackchange + 新样本泵继续
 *  - 错误路径：预缓冲 readSample 抛错、泵循环 readSample 抛错、
 *    seeking 中 play 拒绝
 *  - buffered 合成区间（仅 bufferedAheadUs 时）与 durationUs=null
 *
 * Fake WebCodecs 注入 globalThis（withGlobals try/finally 还原），零浏览器依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';
import { MsePipeline } from '../src/pipeline-mse.js';
import { BlobDataSource } from '../src/data-source.js';
import { registerDemuxer, unregisterDemuxer } from '../src/registry.js';

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

/* ------------------------------ Fake WebCodecs ------------------------------ */

class FakeVideoDecoder {
  static probed = [];
  static reset() { this.probed = []; FakeVideoDecoder.instances = []; }
  static isConfigSupported(config) {
    this.probed.push(config.codec);
    return Promise.resolve({ supported: true });
  }
  constructor(init) { this.init = init; this.configured = null; FakeVideoDecoder.instances.push(this); }
  configure(config) { this.configured = config; }
  decode() {}
  close() {}
}

class FakeAudioDecoder {
  static isConfigSupported() { return Promise.resolve({ supported: true }); }
  constructor(init) { this.init = init; this.configured = null; }
  configure(config) { this.configured = config; }
  decode() {}
  close() {}
}

/** 三媒体轨（含无 codec 的 text 轨），探测合并逻辑的全分支输入 */
const mediaInfo = {
  container: 'mp4',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.64001f' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    { id: 3, type: 'text', format: 'webvtt' },
  ],
  durationUs: 1000000,
  seekable: true,
  live: false,
};

/* ------------------------------ Fake MSE 部件 ------------------------------ */

class FakeMseHelper {
  constructor() { this.opened = false; this.tracks = new Map(); this.appends = []; this.duration = null; }
  async open() { this.opened = true; }
  async addTrack(key, mime) { const ch = { key, mime }; this.tracks.set(key, ch); return ch; }
  async append(key, data) { this.appends.push({ key, byteLength: data.byteLength }); }
  async setDuration(sec) { this.duration = sec; }
  async destroy() {}
}

class FakeRemuxer {
  constructor() { this.inits = []; }
  createInitSegment(track) { this.inits.push(track.id); return new Uint8Array([0xf0, track.id]); }
}

class FakeMediaElement {
  constructor() { this.currentTime = 0; this.listeners = new Map(); }
  play() {} pause() {}
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener() {}
}

/** 注入式能力表（Node 无真实 WebCodecs；chooseRoute 需要非 none 裁决） */
const caps = {
  webcodecs: { supported: true, video: { 'avc1.42E01E': true, 'avc1.64001f': true }, audio: { 'mp4a.40.2': true } },
  mse: { supported: false, mimeTypes: [] },
};

/* ------------------------------ 默认管线工厂选择 ------------------------------ */

test('默认 WC 管线：detectForMedia 合并媒体 codec 深探测后裁决 webcodecs 并建 WebCodecsPipeline', async () => {
  await withGlobals({
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: class {},
  }, async () => {
    FakeVideoDecoder.reset();
    // 不注入 capabilities / pipelineFactory：走 detectForMedia + DEFAULT_WC_PIPELINE
    const p = new Player({ demuxerFactory: async () => ({ open: async () => mediaInfo, destroy: async () => {} }) });
    await p.load({ read: async () => new Uint8Array([1]) });
    assert.equal(p.route, 'webcodecs');
    assert.ok(p.pipeline instanceof WebCodecsPipeline, '应使用默认 WebCodecs 管线工厂');
    // 探测清单 = 默认视频清单 ∪ 媒体实际 codec（avc1.64001f 不在默认清单内）
    assert.ok(FakeVideoDecoder.probed.includes('avc1.64001f'), '媒体实际 codec 应并入探测');
    assert.ok(FakeVideoDecoder.probed.includes('avc1.42E01E'), '默认清单 codec 应保留');
    assert.ok(p.pipeline._videoConfig.codec === 'avc1.64001f');
    // 音轨在 Node 无 AudioContext：audioOutput 缺席但解码器已配置（audio-unavailable 语义）
    assert.equal(p.pipeline._audioConfig.codec, 'mp4a.40.2');
    assert.equal(p.pipeline.audioOutput, null);
    await p.destroy();
  });
});

test('默认 MSE 管线：注入 MediaSource 全局 + 宿主级 mse/element/remuxer 时建 MsePipeline', async () => {
  await withGlobals({ MediaSource: function FakeMediaSource() {} }, async () => {
    const mse = new FakeMseHelper();
    const remuxer = new FakeRemuxer();
    const element = new FakeMediaElement();
    const p = new Player({
      route: 'mse',
      demuxerFactory: async () => ({ open: async () => mediaInfo, destroy: async () => {} }),
      mediaElement: element,
      mse,
      remuxer,
    });
    await p.load({ read: async () => new Uint8Array([1]) });
    assert.equal(p.route, 'mse');
    assert.ok(p.pipeline instanceof MsePipeline, '应使用默认 MSE 管线工厂');
    assert.equal(mse.opened, true);
    assert.equal(mse.tracks.get('v1').mime, 'video/mp4; codecs="avc1.64001f"');
    assert.equal(mse.tracks.get('a2').mime, 'audio/mp4; codecs="mp4a.40.2"');
    assert.deepEqual(remuxer.inits, [1, 2]);
    assert.equal(element.listeners.has('error'), true, '应已挂接 element 事件');
    await p.destroy();
  });
});

test('默认 WC 工厂：复合轨缺少任一所需 decoder 时不初始化不完整管线', async () => {
  await withGlobals({ VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: class {} }, async () => {
    const p = new Player({
      route: 'webcodecs',
      demuxerFactory: async () => ({ open: async () => mediaInfo, destroy: async () => {} }),
    });
    await p.load({ read: async () => new Uint8Array([1]) });
    assert.equal(p.route, 'webcodecs');
    assert.equal(p.pipeline, null);
    await p.destroy();
  });
});

test('默认 WC 工厂：纯音频只要求 AudioDecoder', async () => {
  const audioOnly = { ...mediaInfo, tracks: [mediaInfo.tracks[1]] };
  await withGlobals({ AudioDecoder: FakeAudioDecoder }, async () => {
    const p = new Player({
      route: 'webcodecs',
      demuxerFactory: async () => ({ open: async () => audioOnly, destroy: async () => {} }),
    });
    await p.load({ read: async () => new Uint8Array([1]) });
    assert.ok(p.pipeline instanceof WebCodecsPipeline);
    await p.destroy();
  });
});

test('默认工厂皆无：pipeline=null 仍可 load 成功（仅编排层）', async () => {
  const p = new Player({
    route: 'webcodecs', // Node 无 VideoDecoder：hasWebCodecsCtor() false → factory null
    demuxerFactory: async () => ({ open: async () => mediaInfo, destroy: async () => {} }),
  });
  await p.load({ read: async () => new Uint8Array([1]) });
  assert.equal(p.state, 'ready');
  assert.equal(p.route, 'webcodecs');
  assert.equal(p.pipeline, null);
  await p.destroy();
});

/* ------------------------------ 输入形态分发 ------------------------------ */

test('load：字符串 URL 透传 demuxerFactory（String 化）、Blob 包成 BlobDataSource', async () => {
  const seen = [];
  const factory = async (input) => { seen.push(input); return { open: async () => mediaInfo, destroy: async () => {} }; };
  const p1 = new Player({ capabilities: caps, demuxerFactory: factory });
  await p1.load('https://example.com/v.mp4');
  assert.equal(seen[0], 'https://example.com/v.mp4');
  await p1.destroy();
  const p2 = new Player({ capabilities: caps, demuxerFactory: factory });
  await p2.load(new Blob([new Uint8Array([1, 2, 3])]));
  assert.ok(seen[1] instanceof BlobDataSource);
  await p2.destroy();
});

test('load：不支持的 input 类型抛 STATE_ERROR', async () => {
  const p = new Player();
  await assert.rejects(() => p.load(42), (e) => e.code === 'STATE_ERROR');
  assert.equal(p.state, 'error');
});

test('load 重入：飞行中二次 load 复用同一次装载（demuxer 工厂只调用一次）', async () => {
  let calls = 0;
  let resolveOpen;
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => {
      calls += 1;
      return { open: () => new Promise((r) => { resolveOpen = r; }), destroy: async () => {} };
    },
  });
  const first = p.load({ read: async () => new Uint8Array([1]) });
  await new Promise((r) => setImmediate(r)); // open 挂起（resolveOpen 已就绪），state 仍 idle
  const second = p.load({ read: async () => new Uint8Array([1]) });
  resolveOpen(mediaInfo);
  await Promise.all([first, second]);
  assert.equal(calls, 1, '重入应返回同一 _loadPromise，不重复建 demuxer');
  await p.destroy();
});

/* ------------------------------ load 中止竞态 ------------------------------ */

test('load：capabilities 深探测期间销毁 → ABORTED 且 demuxer 被回收', async () => {
  // destroy 由 isConfigSupported 探测回调内触发，保证落在 caps await 的竞态窗口
  const hooks = { destroy: null };
  await withGlobals({
    VideoDecoder: class {
      static async isConfigSupported() { if (hooks.destroy) await hooks.destroy(); return { supported: true }; }
    },
    AudioDecoder: class {
      static isConfigSupported() { return Promise.resolve({ supported: true }); }
    },
    EncodedVideoChunk: class {},
  }, async () => {
    let demuxer;
    const p = new Player({
      demuxerFactory: async () => (demuxer = { open: async () => mediaInfo, destroy: async () => { demuxer.destroyedByPlayer = true; } }),
    });
    hooks.destroy = () => p.destroy();
    await assert.rejects(() => p.load({ read: async () => new Uint8Array([1]) }), (e) => e.code === 'ABORTED');
    assert.equal(demuxer.destroyedByPlayer, true);
  });
});

test('load：管线工厂迟到成功 → ABORTED 且迟到的管线被回收', async () => {
  let pipeline;
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => ({ open: async () => mediaInfo, destroy: async () => {} }),
    pipelineFactory: async () => {
      await p.destroy();
      return (pipeline = { destroy: async () => { pipeline.destroyed = true; } });
    },
  });
  await assert.rejects(() => p.load({ read: async () => new Uint8Array([1]) }), (e) => e.code === 'ABORTED');
  assert.equal(pipeline.destroyed, true, '迟到的管线应被 destroyLate 回收');
});

test('load：管线工厂当前代失败 → load 拒绝 SOURCE_ERROR 且 demuxer 一并清理', async () => {
  let demuxer;
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => (demuxer = { open: async () => mediaInfo, destroy: async () => { demuxer.destroyedByPlayer = true; } }),
    pipelineFactory: async () => { throw new Error('pipeline boom'); },
  });
  await assert.rejects(
    () => p.load({ read: async () => new Uint8Array([1]) }),
    (e) => e.name === 'PlayerError' && e.code === 'SOURCE_ERROR',
  );
  assert.equal(p.state, 'error');
  assert.equal(demuxer.destroyedByPlayer, true);
  assert.equal(p.demuxer, null);
});

/* ------------------------------ 切轨与泵错误路径 ------------------------------ */

/** 永续供样的多轨假 demuxer（plain object，配合 bufferTargetUs=0 走常规泵） */
function makeStreamDemuxer(trackIds = [1, 2, 3]) {
  let nextTs = 0;
  return {
    open: async () => ({
      container: 'mkv',
      tracks: trackIds.map((id) => ({ id, type: 'video', codec: 'avc1.42E01E' })),
      durationUs: 800000,
      seekable: true,
      live: false,
    }),
    readSample: async (id) => {
      await new Promise((r) => setImmediate(r));
      return { trackId: id, codec: 'avc1.42E01E', timestamp: nextTs, duration: 100000, keyframe: true, data: new Uint8Array([1]), size: 1, ts: nextTs++ };
    },
    seek: async (ts) => ({ actualTimestampUs: ts }),
    destroy: async () => {},
  };
}

test('selectTrack：playing 中成功切轨 → trackchange 派发且新轨样本泵继续', async () => {
  const calls = [];
  const changes = [];
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => makeStreamDemuxer([1, 2]),
    bufferTargetUs: 0,
    pipelineFactory: async () => ({
      pushSample: async () => { calls.push('push'); },
      selectTrack: async () => { calls.push('switch'); },
      destroy: async () => {},
    }),
  });
  await p.load({ read: async () => new Uint8Array([1]) });
  p.on('trackchange', (e) => changes.push(e));
  await p.play();
  const before = calls.filter((c) => c === 'push').length;
  await p.selectTrack('video', 2);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(changes, [{ type: 'video', trackId: 2 }]);
  assert.equal(p.selectedTracks.video, 2);
  assert.ok(calls.filter((c) => c === 'push').length > before, '切轨后新样本泵应继续拉流');
  p.pause();
  await p.destroy();
});

test('play：seeking 中调用拒绝（STATE_ERROR）', async () => {
  let releaseSeek;
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => {
      const d = makeStreamDemuxer([1]);
      d.seek = () => new Promise((r) => { releaseSeek = r; });
      return d;
    },
    bufferTargetUs: 0,
    pipelineFactory: async () => ({ destroy: async () => {} }),
  });
  await p.load({ read: async () => new Uint8Array([1]) });
  const seeking = p.seek(100000);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(() => p.play(), (e) => e.code === 'STATE_ERROR');
  releaseSeek({ actualTimestampUs: 100000 });
  await seeking;
  await p.destroy();
});

test('预缓冲：readSample 抛错 → play 拒绝、error 态、buffering(false) 收尾', async () => {
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => ({
      open: async () => ({ container: 'mkv', tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }], durationUs: 800000, seekable: true, live: false }),
      readSample: async () => { throw new Error('io boom'); },
      seek: async (ts) => ({ actualTimestampUs: ts }),
      destroy: async () => {},
    }),
    pipelineFactory: async () => ({ destroy: async () => {} }),
    // 默认 bufferTargetUs=3s → play() 进入预缓冲循环
  });
  const errors = [];
  const buffering = [];
  p.on('error', (e) => errors.push(e));
  p.on('buffering', (e) => buffering.push(e));
  await p.load({ read: async () => new Uint8Array([1]) });
  await assert.rejects(() => p.play(), (e) => e.name === 'PlayerError' && e.code === 'SOURCE_ERROR');
  assert.equal(p.state, 'error');
  assert.equal(errors.length, 1);
  assert.equal(buffering[buffering.length - 1].active, false, 'finally 应退出缓冲中');
  await p.destroy();
});

test('泵循环：readSample 抛错 → error 态、error 事件、不派发 ended', async () => {
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => ({
      open: async () => ({ container: 'mkv', tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }], durationUs: 800000, seekable: true, live: false }),
      readSample: async () => { throw new Error('pump boom'); },
      seek: async (ts) => ({ actualTimestampUs: ts }),
      destroy: async () => {},
    }),
    bufferTargetUs: 0, // 跳过预缓冲，让错误落在常规泵
    pipelineFactory: async () => ({ destroy: async () => {} }),
  });
  const errors = [];
  let ended = 0;
  p.on('error', (e) => errors.push(e));
  p.on('ended', () => ended++);
  await p.load({ read: async () => new Uint8Array([1]) });
  await p.play(); // 泵为 void 调用，play 本身不拒绝
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(p.state, 'error');
  assert.equal(errors.length, 1);
  assert.equal(ended, 0);
  await p.destroy();
});

/* ------------------------------ buffered / durationUs ------------------------------ */

test('buffered：demuxer/pipeline 均无区间时按 bufferedAheadUs 合成；无 duration 时为 null', async () => {
  const p = new Player({
    capabilities: caps,
    demuxerFactory: async () => ({
      open: async () => ({ container: 'mkv', tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }], seekable: true, live: false }),
      readSample: async () => null,
      seek: async (ts) => ({ actualTimestampUs: ts }),
      destroy: async () => {},
    }),
    pipelineFactory: async () => ({ get bufferedAheadUs() { return 5000000; }, destroy: async () => {} }),
  });
  await p.load({ read: async () => new Uint8Array([1]) });
  assert.equal(p.durationUs, null, 'mediaInfo 无 durationUs → durationUs null');
  const ranges = p.buffered;
  assert.deepEqual(ranges, [{ startUs: 0, endUs: 5000000 }]);
  await p.destroy();
});

test('player：管线主时钟优先、无缓冲时返回空区间、默认调度器可取消', async () => {
  let scheduled = false;
  const p = new Player({
    route: 'webcodecs',
    capabilities: caps,
    demuxerFactory: async () => ({
      open: async () => ({ container: 'mkv', tracks: [], seekable: true, live: false }),
      readSample: async () => null,
      destroy: async () => {},
    }),
    pipelineFactory: async () => ({ currentTimeUs: 123456, destroy: async () => {} }),
  });
  await p.load({ read: async () => new Uint8Array([1]) });
  assert.equal(p.currentTimeUs, 123456, '有管线主时钟时应优先使用管线时间');
  assert.deepEqual(p.buffered, [], '无 demuxer/pipeline 缓冲且无水位时返回空数组');
  const cancel = p._schedule(() => { scheduled = true; }, 60_000);
  assert.equal(typeof cancel, 'function');
  cancel();
  assert.equal(scheduled, false, '取消默认调度后回调不应执行');
  await p.destroy();
});

test('load：URL 输入走 detectFromUrl，透传 Range 请求并创建探测到的 demuxer', async () => {
  const name = 'player-url-test';
  const bytes = new Uint8Array([0xaa, 0xbb]);
  let request = null;
  let sourceSeen = null;
  registerDemuxer({
    containerName: name,
    extensions: ['.purl'],
    probe: (head) => (head[0] === 0xaa ? { container: name, confidence: 0.99 } : null),
    createDemuxer: (source) => {
      sourceSeen = source;
      return {
        open: async () => ({ container: name, tracks: [], seekable: false, live: true }),
        readSample: async () => null,
        destroy: async () => {},
      };
    },
  });
  try {
    const p = new Player({
      route: 'webcodecs',
      capabilities: caps,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 206, body: null, arrayBuffer: async () => bytes.buffer };
      },
      pipelineFactory: async () => ({ destroy: async () => {} }),
    });
    await p.load('https://example.com/video.purl');
    assert.equal(request.url, 'https://example.com/video.purl');
    assert.equal(request.options.headers.Range, 'bytes=0-4095');
    assert.ok(sourceSeen, '应使用探测结果创建 DataSource/demuxer');
    await p.destroy();
  } finally {
    unregisterDemuxer(name);
  }
});
