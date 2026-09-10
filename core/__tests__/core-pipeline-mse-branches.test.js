/**
 * pipeline-mse 分支补测：现有 pipeline-mse.test.js 已覆盖 init/成段/背压/seek/end/destroy，
 * 本文件补齐：活动轨切换与 SourceBuffer 增量建轨、非活动轨过滤、缓冲水位/区间换算、
 *            元素事件桥接（firstframe/stall/error）、播放态与参数透传、append 失败上报。
 * 全部依赖注入的 Fake，不触碰真实 MediaSource。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MsePipeline } from '../src/pipeline-mse.js';
import { createSample } from '../src/types.js';

class FakeMseHelper {
  constructor() {
    this.tracks = new Map();
    this.appends = [];
    this.resetCalls = [];
    this.duration = null;
    this.eos = 0;
    this.destroyed = false;
    this.aheadByKey = new Map();
    this.rangesByKey = new Map();
    this.appendError = null;
  }
  async open() { this.opened = true; }
  async addTrack(key, mime) {
    const ch = { key, mime };
    this.tracks.set(key, ch);
    return ch;
  }
  async append(key, data) {
    if (this.appendError) throw this.appendError;
    this.appends.push({ key, byteLength: data.byteLength });
  }
  bufferedAhead(key) { return this.aheadByKey.get(key) ?? 0; }
  buffered(key) { return this.rangesByKey.get(key) ?? null; }
  async setDuration(sec) { this.duration = sec; }
  async resetTrack(key, keepPosition) { this.resetCalls.push({ key, keepPosition }); }
  async endOfStream() { this.eos += 1; }
  destroy() { this.destroyed = true; }
}

class FakeRemuxer {
  constructor() { this.inits = []; }
  createInitSegment(track) { this.inits.push(track.id); return new Uint8Array([0xf0, track.id]); }
  createMediaSegment(track, samples) {
    return {
      data: new Uint8Array(samples.length),
      sequenceNumber: 0,
      sampleCount: samples.length,
      baseMediaDecodeTimeUs: samples[0]?.timestamp ?? 0,
      durationUs: samples.reduce((a, s) => a + (s.duration ?? 0), 0),
    };
  }
}

class FakeMediaElement {
  constructor() {
    this.currentTime = 0;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.listeners = new Map();
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.playThrows = false;
  }
  play() { this.playCalls += 1; if (this.playThrows) throw new Error('play 被拒'); }
  pause() { this.pauseCalls += 1; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({}); }
}

const info = {
  container: 'mp4',
  durationUs: 1_000_000,
  seekable: true,
  live: false,
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 5, type: 'video', codec: 'avc1.640028' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
};

function build({ mediaInfo = info, options = {}, mse = new FakeMseHelper() } = {}) {
  const element = new FakeMediaElement();
  const remuxer = new FakeRemuxer();
  const pipeline = new MsePipeline({
    route: 'mse',
    mediaInfo,
    player: null,
    options: { mediaElement: element, mse, remuxer, schedule: (fn) => { fn(); return () => {}; }, ...options },
  });
  return { pipeline, mse, remuxer, element };
}

const vsample = (trackId, over = {}) => createSample({
  trackId, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]), ...over,
});

/* ------------------------------ 活动轨选择 ------------------------------ */

test('构造：每类轨默认选中第一条（active 初始化）', () => {
  const { pipeline } = build();
  assert.deepEqual(pipeline.active, { video: 1, audio: 2, text: null });
});

test('pushSample：非活动同类轨的样本被丢弃（不进 SourceBuffer）', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  await pipeline.pushSample(vsample(5)); // 活动视频轨是 1
  assert.equal(pipeline.counters.samples, 0);
  assert.equal(mse.appends.length, 2, '仅 init（v1/a2），未追加非活动轨');
});

test('selectTrack：切到新视频轨 → 建 SourceBuffer + 写 init，并丢弃旧轨待封装样本', async () => {
  const { pipeline, mse, remuxer } = build();
  await pipeline.init();
  await pipeline.pushSample(vsample(1)); // 旧轨攒一个待封装样本
  assert.equal(pipeline._pending.get(1).length, 1);

  const changes = [];
  pipeline.on('trackchange', (e) => changes.push(e));
  await pipeline.selectTrack('video', 5);

  assert.equal(pipeline.active.video, 5);
  assert.equal(pipeline._pending.has(1), false, '旧轨待封装样本被丢弃，避免串时间轴');
  assert.ok(mse.tracks.has('v5'), '新轨 SourceBuffer 已建');
  assert.equal(mse.tracks.get('v5').mime, 'video/mp4; codecs="avc1.640028"');
  assert.deepEqual(remuxer.inits, [1, 2, 5], '新轨补写 init segment');
  assert.deepEqual(changes, [{ type: 'video', trackId: 5, codec: 'avc1.640028' }]);
});

test('selectTrack：同轨 no-op；未知轨/类型不匹配抛 STATE_ERROR', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  const before = mse.appends.length;
  await pipeline.selectTrack('video', 1); // 已是活动轨
  assert.equal(mse.appends.length, before);
  await assert.rejects(() => pipeline.selectTrack('video', 999), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => pipeline.selectTrack('audio', 1), (e) => e.code === 'STATE_ERROR');
});

test('selectTrack：已有 SourceBuffer 的目标轨只切活动、不重复建 init', async () => {
  const mse = new FakeMseHelper();
  mse.tracks.set('v5', { key: 'v5' }); // 预置：目标轨 SB 已存在
  const { pipeline, remuxer } = build({ mse });
  await pipeline.init();
  const initCountBefore = remuxer.inits.length;
  await pipeline.selectTrack('video', 5);
  assert.equal(pipeline.active.video, 5);
  assert.equal(remuxer.inits.length, initCountBefore, 'SB 已存在不再补写 init');
});

/* ------------------------------ 缓冲水位 / 区间 ------------------------------ */

test('bufferedAheadUs：取活动轨中最小水位（木桶效应）并转微秒；无能力返回 null', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  mse.aheadByKey.set('v1', 5.5);
  mse.aheadByKey.set('a2', 2.25);
  assert.equal(pipeline.bufferedAheadUs, 2_250_000);

  // 非活动轨不参与
  mse.aheadByKey.set('v5', 0.1);
  assert.equal(pipeline.bufferedAheadUs, 2_250_000);

  mse.aheadByKey.set('a2', Number.NaN);
  assert.equal(pipeline.bufferedAheadUs, 5_500_000, '非有限值跳过');

  const noBuf = build({ mse: { open: async () => {}, addTrack: async () => ({}), append: async () => {} } });
  await noBuf.pipeline.init();
  assert.equal(noBuf.pipeline.bufferedAheadUs, null, 'mse 无 bufferedAhead → null');
});

test('getBufferedRanges：逐活动轨取区间转微秒；无能力返回 null', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  mse.rangesByKey.set('v1', { length: 2, start: (i) => [0, 10][i], end: (i) => [4, 12][i] });
  mse.rangesByKey.set('a2', { length: 1, start: () => 1.5, end: () => 2.5 });
  assert.deepEqual(pipeline.getBufferedRanges(), [
    { startUs: 0, endUs: 4_000_000 },
    { startUs: 10_000_000, endUs: 12_000_000 },
    { startUs: 1_500_000, endUs: 2_500_000 },
  ]);

  const noBuf = build({ mse: { open: async () => {}, addTrack: async () => ({}), append: async () => {} } });
  await noBuf.pipeline.init();
  assert.equal(noBuf.pipeline.getBufferedRanges(), null);
});

test('bufferedAheadSec：指定 key 取该轨，缺省取全部轨最大值', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  mse.aheadByKey.set('v1', 3);
  mse.aheadByKey.set('a2', 7);
  assert.equal(pipeline.bufferedAheadSec(), 7);
  assert.equal(pipeline.bufferedAheadSec('v1'), 3);
  assert.equal(pipeline.bufferedAheadSec('missing'), 0);
});

test('stats：聚合计数器 + 缓冲水位 + underrunCount', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  mse.aheadByKey.set('v1', 4);
  const s = pipeline.stats;
  assert.equal(s.initSegments, 2);
  assert.equal(s.bufferedAheadSec, 4);
  assert.equal(s.underrunCount, 0);
  assert.equal(s.mediaSegments, 0);
});

/* ------------------------------ 元素事件桥接 ------------------------------ */

test('元素 loadeddata/canplay → firstframe 仅一次；waiting → stall；error → DECODE_ERROR', async () => {
  const { pipeline, element, mse } = build();
  await pipeline.init();
  mse.aheadByKey.set('v1', 1.5);
  const events = { firstframe: 0, stall: [], error: [] };
  pipeline.on('firstframe', () => (events.firstframe += 1));
  pipeline.on('stall', (e) => events.stall.push(e));
  pipeline.on('error', (e) => events.error.push(e));

  element.currentTime = 2;
  element.emit('loadeddata');
  element.emit('canplay');
  assert.equal(events.firstframe, 1, '首帧事件去重');
  assert.equal(pipeline._firstFrameEmitted, true);

  element.emit('waiting');
  assert.deepEqual(events.stall, [{ bufferedSec: 1.5 }]);

  element.error = { code: 4 };
  element.emit('error');
  assert.equal(events.error.length, 1);
  assert.equal(events.error[0].code, 'DECODE_ERROR');
});

/* ------------------------------ 生命周期与参数透传 ------------------------------ */

test('play/pause：状态机切换并透传元素；play 抛错上报 error', async () => {
  const { pipeline, element } = build();
  await pipeline.init();
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));

  pipeline.play();
  assert.equal(pipeline.state, 'playing');
  assert.equal(element.playCalls, 1);

  pipeline.pause();
  assert.equal(pipeline.state, 'paused');
  assert.equal(element.pauseCalls, 1);

  pipeline.pause(); // 非 playing 时 no-op
  assert.equal(element.pauseCalls, 1);

  element.playThrows = true;
  pipeline.play();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'DECODE_ERROR');
});

test('setVolume/setMuted/setPlaybackRate/currentTimeUs：透传元素并按微秒取整', async () => {
  const { pipeline, element } = build();
  await pipeline.init();
  pipeline.setVolume(0.3);
  pipeline.setMuted(1);
  pipeline.setPlaybackRate(1.5);
  assert.equal(element.volume, 0.3);
  assert.equal(element.muted, true);
  assert.equal(element.playbackRate, 1.5);

  element.currentTime = 2.5;
  assert.equal(pipeline.currentTimeSec(), 2.5);
  assert.equal(pipeline.currentTimeUs, 2_500_000);

  element.currentTime = Number.NaN;
  assert.equal(pipeline.currentTimeSec(), 0);
});

test('mimeFor：options.mimeFor 可完全接管 mime 组装', async () => {
  const { pipeline, mse } = build({ options: { mimeFor: (t) => `custom/${t.type}` } });
  await pipeline.init();
  assert.equal(mse.tracks.get('v1').mime, 'custom/video');
  assert.equal(mse.tracks.get('a2').mime, 'custom/audio');
});

test('text 样本：无 data 时 text 为空串，仍产 cue', async () => {
  const textInfo = {
    container: 'mkv',
    tracks: [{ id: 3, type: 'text', codec: 'x-srt' }],
    durationUs: 1000,
    seekable: true,
    live: false,
  };
  const { pipeline } = build({ mediaInfo: textInfo });
  await pipeline.init();
  const cues = [];
  pipeline.on('cue', (c) => cues.push(c));
  await pipeline.pushSample(createSample({
    trackId: 3, codec: 'x-srt', timestamp: 0, duration: 1000, keyframe: true, data: undefined,
  }));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '');
  assert.equal(pipeline.counters.cues, 1);
});

test('flush：空批次返回 null；append 失败时 emit error 并 reject', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  assert.equal(await pipeline.flush(1), null, '无待封装样本 → null');

  await pipeline.pushSample(vsample(1));
  mse.appendError = new Error('append 爆炸');
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));
  await assert.rejects(() => pipeline.flush(1), (e) => e.code === 'DECODE_ERROR');
  assert.equal(errors.length, 1, '失败同时广播 error 事件');
});

test('destroy 后 pushSample/flush 不再写入；mse.destroy 被调用', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  await pipeline.destroy();
  assert.equal(mse.destroyed, true);
  assert.equal(pipeline.mse, null);
  await pipeline.pushSample(vsample(1));
  assert.equal(await pipeline.flush(1), null);
});
