/**
 * core-pipeline-mse-gaps.test.js —— pipeline-mse.js 残余分支补测（wave 140）
 *
 * 覆盖：
 *   - defaultSchedule 默认调度路径（setTimeout + unref + clearTimeout，Node Timeout）；
 *   - defaultRemuxerFactory 默认工厂：动态 import mp4 Fmp4Remuxer；
 *   - defaultMseFactory 默认工厂：动态 import MseHelper 且 init 期赋值 this.mse（Node 无
 *     MediaSource → open 拒绝，恰好验证「工厂产物已被接管」）；
 *   - init() catch：生命周期已失效（destroy 先行）时吞错返回 this；
 *   - end() endOfStream 抛错 → emit error（未销毁分支）；
 *   - seek() resetTrack 抛错 → emit error；
 *   - selectTrack 残余守卫：destroy 后直调抛 STATE_ERROR、init 等待期 abort 抛出、
 *     addTrack 等待期 abort 抛出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MsePipeline } from '../src/pipeline-mse.js';
import { MseHelper } from '../src/mse-helper.js';
import { Fmp4Remuxer } from '../../mp4/src/remuxer.js';

class FakeMse {
  constructor() {
    this.tracks = new Map();
    this.appends = [];
    this.eos = 0;
    this._aheadSeq = null;
  }
  async open() {}
  async addTrack(key, mime) { this.tracks.set(key, { key, mime }); return this.tracks.get(key); }
  async append(key, data) { this.appends.push({ key, byteLength: data.byteLength }); }
  bufferedAhead() { return this._aheadSeq ? (this._aheadSeq.shift() ?? 0) : 0; }
  async setDuration() {}
  async resetTrack() {}
  async endOfStream() { this.eos += 1; }
  destroy() {}
}

class FakeElement {
  constructor() {
    this.currentTime = 0;
    this.listeners = new Map();
  }
  addEventListener(t, fn) { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)).push(fn); }
  removeEventListener() {}
  emit(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn({}); }
}

const info = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
  durationUs: 1_000_000,
  seekable: true,
  live: false,
};

const sample = (over = {}) => ({
  trackId: 1, timestamp: 0, duration: 40_000, data: new Uint8Array(4), keyframe: true, ...over,
});

test('defaultSchedule：缓冲超水位走默认 setTimeout 背压后成段', async () => {
  const mse = new FakeMse();
  // 前 2 次 100s（>30s 水位）→ 两个 50ms 默认定时轮询，之后归 0 放行
  mse._aheadSeq = [100, 100];
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement(), mse, remuxer: { createInitSegment: () => new Uint8Array(1), createMediaSegment: () => ({ data: new Uint8Array(8), sequenceNumber: 0, sampleCount: 1, baseMediaDecodeTimeUs: 0, durationUs: 40_000 }) } },
  });
  await pipeline.init();
  pipeline._pending.set(1, [sample()]);
  pipeline._pendingUs.set(1, 2_100_000);
  // defaultSchedule 的 timer 被 unref()：测试需自备 keep-alive 防 event loop 提前退出
  const keepAlive = setInterval(() => {}, 1_000);
  let seg;
  try {
    seg = await pipeline.flush(1);
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(seg, 'flush 应产出 segment');
  assert.equal(pipeline.counters.mediaSegments, 1);
});

test('defaultRemuxerFactory：动态 import mp4 Fmp4Remuxer', async () => {
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement(), mse: new FakeMse() },
  });
  try { await pipeline.init(); } catch { /* 真实 remuxer 对最小 track 可能拒绝，工厂已执行即可 */ }
  assert.ok(pipeline.remuxer instanceof Fmp4Remuxer, 'remuxer 应来自默认工厂的动态 import');
});

test('defaultMseFactory：动态 import MseHelper 并在 init 期接管 this.mse', async () => {
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement() }, // 不注入 mse/mseFactory
  });
  await assert.rejects(() => pipeline.init()); // Node 无 MediaSource → open 拒绝
  assert.ok(pipeline.mse instanceof MseHelper, 'this.mse 应为默认工厂产物（118-119 行）');
  assert.notEqual(pipeline.mse, null);
  pipeline.mse.destroyed = true; // 便于 destroy 幂等
  await pipeline.destroy();
});

test('init() 生命周期失效（destroy 先行）时吞错返回 this', async () => {
  let destroyRef;
  const mse = new FakeMse();
  mse.open = async () => { destroyRef(); throw new Error('boom after destroy'); };
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement(), mse, remuxer: { createInitSegment: () => new Uint8Array(1) } },
  });
  destroyRef = () => pipeline.destroy();
  const out = await pipeline.init(); // 不应抛
  assert.equal(out, pipeline);
  assert.equal(pipeline.state, 'destroyed');
});

test('end()：endOfStream 抛错 → emit error（未销毁分支）', async () => {
  const mse = new FakeMse();
  mse.endOfStream = () => { throw new Error('eos boom'); };
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement(), mse, remuxer: { createInitSegment: () => new Uint8Array(1) } },
  });
  await pipeline.init();
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));
  await pipeline.end();
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes('endOfStream 失败'));
});

test('seek()：resetTrack 抛错 → emit error', async () => {
  const mse = new FakeMse();
  mse.resetTrack = () => { throw new Error('reset boom'); };
  const element = new FakeElement();
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: element, mse, remuxer: { createInitSegment: () => new Uint8Array(1) } },
  });
  await pipeline.init();
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));
  await pipeline.seek(500_000);
  assert.equal(errors.length, 2, 'video+audio 两条活动轨各抛一次');
  for (const e of errors) assert.ok(e.message.includes('seek 清缓冲失败'));
});

test('selectTrack：destroy 后直调抛 STATE_ERROR（439-440）', async () => {
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: { mediaElement: new FakeElement(), mse: new FakeMse(), remuxer: { createInitSegment: () => new Uint8Array(1) } },
  });
  await pipeline.destroy();
  await assert.rejects(
    () => pipeline.selectTrack('video', 1),
    (e) => e.code === 'STATE_ERROR' && e.message.includes('pipeline destroyed'),
  );
});

test('selectTrack：init 等待期 destroy → abort 抛出（445-446）', async () => {
  let releaseFactory;
  const gate = new Promise((resolve) => { releaseFactory = resolve; });
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: info,
    options: {
      mediaElement: new FakeElement(),
      mseFactory: async () => gate.then(() => new FakeMse()),
      remuxer: { createInitSegment: () => new Uint8Array(1) },
    },
  });
  const pending = pipeline.selectTrack('audio', 2); // init 未完成 → 进入 race(init, abort.promise)
  await new Promise((r) => setImmediate(r)); // 让 run() 先挂入 race（否则 destroy 先置 aborted 走 420 守卫）
  await pipeline.destroy(); // resolve abort.promise
  await assert.rejects(
    () => pending,
    (e) => e.code === 'STATE_ERROR' && e.message.includes('pipeline destroyed'),
  );
  releaseFactory?.();
});

test('selectTrack：addTrack 等待期 destroy → abort 抛出（462-463）', async () => {
  // 第三条音频轨（非当前活动轨）才会走 addTrack 分支（active 轨在 449 提前 return）
  const threeAudioInfo = {
    ...info,
    tracks: [...info.tracks, { id: 3, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }],
  };
  const mse = new FakeMse();
  let releaseAdd;
  const gate = new Promise((resolve) => { releaseAdd = resolve; });
  const origAddTrack = mse.addTrack.bind(mse);
  let addCalls = 0;
  mse.addTrack = async (...args) => {
    addCalls += 1;
    if (addCalls <= 2) return origAddTrack(...args); // init 期 v1/a2 正常建轨
    return gate; // selectTrack('audio', 3) 挂起
  };
  const pipeline = new MsePipeline({
    route: 'mse', mediaInfo: threeAudioInfo,
    options: { mediaElement: new FakeElement(), mse, remuxer: { createInitSegment: () => new Uint8Array(1) } },
  });
  await pipeline.init();
  const pending = pipeline.selectTrack('audio', 3); // a3 未初始化 → addTrack 挂起
  await new Promise((r) => setImmediate(r)); // 让 run() 先挂入 addTrack race
  await pipeline.destroy();
  releaseAdd(); // 先解除 gate，避免底层 promise 永挂
  await assert.rejects(
    () => pending,
    (e) => e.code === 'STATE_ERROR' && e.message.includes('pipeline destroyed'),
  );
});
