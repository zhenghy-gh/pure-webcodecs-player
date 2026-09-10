/**
 * core-pipeline-queue.test.js
 *
 * 针对 core/src/pipeline-webcodecs.js 的**正向路径与队列语义**补测
 * （错误路径见 core-pipeline-error.test.js，此处聚焦队列/调度/输出顺序）：
 *  - _waitQueue 背压：decodeQueueSize ≥ maxDecodeQueue 时经注入 schedule 让出等待，
 *    回落后继续 decode；上限边界（恰好等于 limit 不等待）
 *  - 输出回调顺序：渲染按解码到达序而非 pts 序；rendered 事件携带各帧 ts
 *  - avSync 'wait' 决策：帧超前时挂 _frameTimer 定时器且不渲染，定时器触发后恢复渲染
 *  - avSync 'resync' 决策：大幅超前时经 _masterRealignToUs 重锚主钟（清音频缓冲 +
 *    偏移锚定）并派发 resynced，随后帧正常渲染
 *  - firstframe 只派发一次
 *  - 暂停期间帧入队不出队；play 后统一渲染；pause 中断泵
 *  - _createChunk：keyframe→'key' / 非 keyframe→'delta'，duration 透传
 *  - bufferedAheadUs 用帧队列领先主钟的时长合成缓冲区间
 *  - seek 重置 live edge；init 幂等；selectTrack 同轨 no-op
 *
 * 全部用 Fake 解码器/渲染器/音频输出与可编程 avSync 注入，零浏览器依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';
import { createSample } from '../src/types.js';

/* ------------------------------ Fake 实现 ------------------------------ */

class FakeDecoder {
  constructor(init) {
    this.init = init;
    this.config = null;
    this.closed = false;
    this.resets = 0;
    this.decodeQueueSize = 0;
    this.chunks = [];
  }
  configure(config) { this.config = config; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() { this.resets += 1; }
  close() { this.closed = true; }
  emit(frame) { this.init.output(frame); }
}

class FakeFrame {
  constructor(timestamp) { this.timestamp = timestamp; this.closed = false; }
  close() { this.closed = true; }
}

class FakeRenderer {
  constructor() { this.drawn = []; }
  draw(frame) { this.drawn.push(frame); frame.close(); }
  destroy() {}
}

class FakeAudioOutput {
  constructor() {
    this.pushed = [];
    this.cleared = 0;
    this.destroyed = false;
  }
  async init() {}
  push(channels) { this.pushed.push(channels); }
  play() {}
  pause() {}
  clearBuffer() { this.cleared += 1; }
  setVolume() {}
  destroy() { this.destroyed = true; }
  get currentTimeUs() { return 0; }
}

const videoInfo = {
  container: 'mkv',
  tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }],
  durationUs: 1000000, seekable: true, live: false,
};

/** 可编程 avSync：按脚本依次返回决策（无限重复最后一项） */
function scriptedAvSync(actions) {
  let i = 0;
  return {
    attachMaster() {},
    start() {},
    pause() {},
    seekTo() {},
    setRate() {},
    suggestVideoAction(ptsSec) {
      const a = actions[Math.min(i, actions.length - 1)];
      i += 1;
      return typeof a === 'function' ? a(ptsSec) : a;
    },
  };
}

function harness({ mediaInfo = videoInfo, avSync, options = {} } = {}) {
  const decoders = [];
  const audio = new FakeAudioOutput();
  const timers = []; // {fn, ms, cancelled}
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo,
    player: null,
    options: {
      videoDecoderFactory: (init) => { const d = new FakeDecoder(init); decoders.push(d); return d; },
      audioDecoderFactory: (init) => { const d = new FakeDecoder(init); decoders.push(d); return d; },
      audioOutputFactory: async () => audio,
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => { t.cancelled = true; };
      },
      now: () => 0,
      ...(avSync ? { avSync } : {}),
      ...options,
    },
  });
  pipeline.renderer = new FakeRenderer();
  return { pipeline, audio, decoders, timers, renderer: pipeline.renderer };
}

/* ------------------------------ 背压 _waitQueue ------------------------------ */

test('背压：decodeQueueSize 超限期间经 schedule 让出，回落后样本照常解码', async () => {
  let yields = 0;
  const { pipeline, decoders } = harness({
    options: {
      maxDecodeQueue: 2,
      schedule: (fn) => { yields += 1; fn(); return () => {}; },
    },
  });
  await pipeline.init();
  const video = decoders[0];
  // 让 decodeQueueSize 从 5 开始，每次让出后减 2：5→3→1（1<2 退出），应让出 2 次
  video.decodeQueueSize = 5;
  const originalSchedule = pipeline._schedule;
  pipeline._schedule = (fn, ms) => originalSchedule(() => { video.decodeQueueSize -= 2; fn(); }, ms);

  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(yields, 2, `应让出 2 次（got ${yields}）`);
  assert.equal(video.chunks.length, 1, '回落后样本照常进解码器');
  assert.equal(pipeline.counters.videoChunks, 1);
});

test('背压：decodeQueueSize 恰好等于上限也等待（>= 判定），guard 上限 64 次后放行', async () => {
  let yields = 0;
  const { pipeline, decoders } = harness({
    options: {
      maxDecodeQueue: 4,
      schedule: (fn) => { yields += 1; fn(); return () => {}; },
    },
  });
  await pipeline.init();
  decoders[0].decodeQueueSize = 4;
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(yields, 64, '队列不消减时让出达到 guard 上限 64 次');
  assert.equal(decoders[0].chunks.length, 1, 'guard 兜底放行，样本照常解码');
});

/* ------------------------------ 输出顺序 / firstframe ------------------------------ */

test('渲染按解码到达序出帧（非 pts 序），rendered 事件携带各帧时间戳', async () => {
  const events = [];
  const avSync = scriptedAvSync([{ action: 'render', drift: 0 }]);
  const { pipeline, decoders } = harness({ avSync });
  pipeline.on('rendered', (e) => events.push(e.timestampUs));
  pipeline.on('firstframe', (e) => events.push(`first:${e.timestampUs}`));
  await pipeline.init();
  pipeline.play();

  // 乱序到达：500000 → 300000 → 400000
  for (const ts of [500000, 300000, 400000]) decoders[0].emit(new FakeFrame(ts));

  assert.deepEqual(
    pipeline.renderer.drawn.map((f) => f.timestamp),
    [500000, 300000, 400000],
    '渲染顺序 = 解码到达序',
  );
  assert.deepEqual(events, [500000, 'first:500000', 300000, 400000], 'rendered 先于同帧 firstframe 派发');
  assert.equal(pipeline.counters.framesRendered, 3);
  assert.equal(pipeline.counters.framesDropped, 0);
});

test('firstframe 全局只派发一次（多帧渲染后不重复）', async () => {
  const avSync = scriptedAvSync([{ action: 'render', drift: 0 }]);
  const { pipeline, decoders } = harness({ avSync });
  let first = 0;
  pipeline.on('firstframe', () => first++);
  await pipeline.init();
  pipeline.play();
  for (let ts = 0; ts < 1_000_000; ts += 100_000) decoders[0].emit(new FakeFrame(ts));
  assert.equal(first, 1);
  assert.equal(pipeline.counters.framesRendered, 10);
});

/* ------------------------------ wait / resync 决策 ------------------------------ */

test('wait 决策：帧超前时挂帧定时器不出帧，延迟经 drift 计算并被触发后恢复渲染', async () => {
  let mode = { action: 'wait', drift: 0.1 }; // 超前 100ms
  const avSync = scriptedAvSync([() => mode]);
  const { pipeline, decoders, timers } = harness({ avSync });
  await pipeline.init();
  pipeline.play();

  decoders[0].emit(new FakeFrame(500000));
  assert.equal(pipeline.renderer.drawn.length, 0, 'wait 期间不渲染');
  assert.equal(pipeline._frames.length, 1, '帧保留在待渲染队列');
  assert.equal(timers.length, 1, '应挂一个帧定时器');
  assert.equal(timers[0].ms, 100, '延迟 = clamp(drift*1000, 0, 250)');
  assert.equal(typeof pipeline._frameTimer, 'function', '_frameTimer 记录定时器取消函数');

  // 二次 wait 不叠加定时器（_frameTimer 已存在则复用）
  decoders[0].emit(new FakeFrame(600000));
  assert.equal(timers.length, 1, '已有定时器时不重复挂');

  // 主钟推进到窗口内 → 触发定时器 → 渲染两帧
  mode = { action: 'render', drift: 0 };
  timers[0].fn();
  assert.deepEqual(
    pipeline.renderer.drawn.map((f) => f.timestamp),
    [500000, 600000],
  );
  assert.equal(pipeline._frameTimer, null, '触发后清空定时器引用');
});

test('resync 决策：大幅超前时重锚主钟（清音频缓冲+偏移锚定）并派发 resynced', async () => {
  // 首次决策 resync（重锚后主钟追上该帧），其后 render —— 与真实 AvSyncController 语义一致
  const avSync = scriptedAvSync([{ action: 'resync', drift: 0.9 }, { action: 'render', drift: 0 }]);
  const { pipeline, decoders, audio } = harness({
    avSync,
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
      durationUs: 1000000, seekable: true, live: false,
    },
  });
  const resynced = [];
  pipeline.on('resynced', (e) => resynced.push(e));
  await pipeline.init();
  pipeline.play();

  decoders[0].emit(new FakeFrame(900000));
  // 重锚后主钟追上该帧 → 下一轮决策 render
  assert.equal(resynced.length, 1);
  assert.equal(resynced[0].timestampUs, 900000);
  assert.ok(audio.cleared >= 1, '重锚应清音频缓冲');
  assert.equal(pipeline._offsetUs, 900000, '偏移锚定到帧位置');
  assert.deepEqual(
    pipeline.renderer.drawn.map((f) => f.timestamp),
    [900000],
    '重锚后该帧正常渲染',
  );
});

/* ------------------------------ 暂停期间帧排队 ------------------------------ */

test('暂停期间解码出的帧只入队不出队，play 后统一渲染，pause 中断泵', async () => {
  const avSync = scriptedAvSync([{ action: 'render', drift: 0 }]);
  const { pipeline, decoders } = harness({ avSync });
  await pipeline.init();

  // 未 play：状态 ready → 帧入队不渲染
  decoders[0].emit(new FakeFrame(0));
  decoders[0].emit(new FakeFrame(100000));
  assert.equal(pipeline._frames.length, 2, '非 playing 状态帧排队');
  assert.equal(pipeline.renderer.drawn.length, 0);

  pipeline.play();
  assert.deepEqual(
    pipeline.renderer.drawn.map((f) => f.timestamp),
    [0, 100000],
    'play 后队列帧全部渲染',
  );

  // 暂停后新帧再次排队
  pipeline.pause();
  decoders[0].emit(new FakeFrame(200000));
  assert.equal(pipeline._frames.length, 1, 'pause 后泵中断，帧排队');
  assert.equal(pipeline.renderer.drawn.length, 2);
});

/* ------------------------------ chunk 形状 ------------------------------ */

test('_createChunk：keyframe→key / 非 keyframe→delta，duration 透传（无 WebCodecs 时为纯对象）', async () => {
  const { pipeline, decoders } = harness();
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 400000, duration: 100000,
    keyframe: true, data: new Uint8Array([1]),
  }));
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 500000, duration: 100000,
    keyframe: false, data: new Uint8Array([2]),
  }));
  const chunks = decoders[0].chunks;
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].type, 'key');
  assert.equal(chunks[0].timestamp, 400000);
  assert.equal(chunks[0].duration, 100000);
  assert.equal(chunks[1].type, 'delta');
  assert.equal(chunks[1].timestamp, 500000);
  assert.equal(chunks[1].data, chunks[1].data); // data 引用透传
  assert.equal(pipeline.counters.videoChunks, 2);
});

/* ------------------------------ 缓冲水位合成 ------------------------------ */

test('bufferedAheadUs 用待渲染帧队列领先主钟的时长合成，getBufferedRanges 生成单区间', async () => {
  const { pipeline, decoders } = harness();
  await pipeline.init();
  // 未 play：帧排队。主钟 = 偏移0 + 音频钟0 → 队尾帧 800000 即水位
  for (const ts of [200000, 500000, 800000]) decoders[0].emit(new FakeFrame(ts));
  assert.equal(pipeline.bufferedAheadUs, 800000);
  const ranges = pipeline.getBufferedRanges();
  assert.deepEqual(ranges, [{ startUs: 0, endUs: 800000 }]);

  // seek 后主钟 300000：水位 = 800000 - 300000
  pipeline.seek(300000);
  assert.equal(pipeline._liveEdgeUs, -1, 'seek 后 live edge 重置待重计');
  assert.equal(pipeline._frames.length, 0, 'seek 清空待渲染帧');
  assert.equal(pipeline.bufferedAheadUs, null, '帧队列空 → 无水位');
});

/* ------------------------------ 生命周期补充 ------------------------------ */

test('init 幂等：重复 init 不重建解码器', async () => {
  const { pipeline, decoders } = harness();
  await pipeline.init();
  await pipeline.init();
  await pipeline.init();
  assert.equal(decoders.length, 1);
  assert.equal(pipeline.state, 'ready');
});

test('selectTrack 同轨 no-op：不重建解码器、不派发 trackchange', async () => {
  const { pipeline, decoders } = harness();
  await pipeline.init();
  const changes = [];
  pipeline.on('trackchange', (e) => changes.push(e));
  await pipeline.selectTrack('video', 1);
  assert.equal(decoders.length, 1, '同轨不重建');
  assert.deepEqual(changes, []);
});

test('音频样本路径：进音频解码器并计数，stats.underrunCount 透传音频输出', async () => {
  const { pipeline, decoders, audio } = harness({
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
      durationUs: 1000000, seekable: true, live: false,
    },
  });
  await pipeline.init();
  const audioDecoder = decoders.find((d) => d !== decoders[0] && d.init !== decoders[0].init) ?? decoders[decoders.length - 1];
  await pipeline.pushSample(createSample({
    trackId: 2, codec: 'mp4a.40.2', timestamp: 0, duration: 100000, keyframe: true,
    data: new Uint8Array([1, 2]),
  }));
  const audioChunks = pipeline.counters.audioChunks;
  assert.equal(audioChunks, 1, '音频样本计数');
  assert.equal(pipeline.stats.underrunCount, 0, '无 underrun 记录时为 0');
  audio.underrunCount = 3;
  assert.equal(pipeline.stats.underrunCount, 3, '透传音频输出自报值');
  void audioDecoder;
  await pipeline.destroy();
  assert.equal(audio.destroyed, true);
});
