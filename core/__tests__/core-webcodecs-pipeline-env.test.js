/**
 * WebCodecs 管线可测化（env/浏览器依赖层）：解码器/渲染器/音频输出/时钟全部可注入，
 * 因此 Node 下用假实现覆盖纯逻辑与分支，不触碰真实 VideoDecoder/AudioDecoder/EncodedVideoChunk。
 *
 * 本文件补齐 pipeline-webcodecs.test.js 未覆盖的 Node 可测分支；
 * 真实 WebCodecs 解码/Worklet 音频线程语义不在此处（见豁免清单）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline, audioDataToPlanar } from '../src/pipeline-webcodecs.js';
import { createSample } from '../src/types.js';

class FakeDecoder {
  constructor(init) {
    this.init = init ?? { output: () => {}, error: () => {} };
    this.config = null;
    this.closed = false;
    this.resets = 0;
    this.chunks = [];
    this.decodeQueueSize = 0; // _waitQueue 读取；背压用例在调度回调中直接调小
  }
  configure(config) { this.config = config; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() { this.resets += 1; }
  close() { this.closed = true; }
  emit(frame) { this.init.output(frame); }
  emitError(err) { this.init.error?.(err); }
}

class FakeFrame {
  constructor(timestamp) { this.timestamp = timestamp; this.closed = false; }
  close() { this.closed = true; }
}

class FakeRenderer {
  constructor() { this.drawn = []; this._throws = false; }
  draw(frame) { if (this._throws) throw new Error('renderer draw 失败'); this.drawn.push(frame); frame.close(); }
  destroy() { this.destroyed = true; }
}

class FakeAudioOutput {
  constructor({ sampleRate = 48000, channels = 2, currentTimeUs = 0, bufferedAheadUs = null, underrunCount = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this._currentTimeUs = currentTimeUs;
    this.bufferedAheadUs = bufferedAheadUs;
    this.underrunCount = underrunCount;
    this.pushed = [];
    this.cleared = 0;
    this.volume = 1;
    this.playing = false;
  }
  async init() {}
  push(ch) { this.pushed.push(ch); }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  clearBuffer() { this.cleared += 1; }
  setVolume(v) { this.volume = v; }
  destroy() { this.destroyed = true; }
  get currentTimeUs() { return this._currentTimeUs; }
}

function build({ mediaInfo, options = {}, audioOutput = new FakeAudioOutput(), renderer = new FakeRenderer(), player = null } = {}) {
  const videoDecoder = new FakeDecoder();
  const audioDecoder = new FakeDecoder();
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: mediaInfo ?? {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E', width: 1920, height: 1080 },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
      durationUs: 1_000_000,
      seekable: true,
      live: false,
    },
    player: player ?? { volume: 0.5, statsValue: { markDecodeError() {}, markVideoDropped() {}, markVideoRendered() {} } },
    options: {
      videoDecoderFactory: (init) => { videoDecoder.init = init; return videoDecoder; },
      audioDecoderFactory: (init) => { audioDecoder.init = init; return audioDecoder; },
      audioOutputFactory: async () => audioOutput,
      schedule: (fn) => { fn(); return () => {}; },
      now: () => 0,
      ...options,
    },
  });
  pipeline.renderer = renderer;
  return { pipeline, videoDecoder, audioDecoder, audioOutput, renderer };
}

/* ------------------------------ audioDataToPlanar ------------------------------ */

test('audioDataToPlanar：copyTo / planes / 兜底零填充 与通道数回落', () => {
  const copy = audioDataToPlanar({
    numberOfChannels: 2, numberOfFrames: 3,
    copyTo(dst, opts) { dst.fill(opts.planeIndex + 1); },
  });
  assert.deepEqual(copy.map((p) => [...p]), [[1, 1, 1], [2, 2, 2]]);

  assert.deepEqual(
    audioDataToPlanar({ numberOfChannels: 1, numberOfFrames: 2, planes: [new Float32Array([9, 8])] }),
    [new Float32Array([9, 8])],
  );

  // 无 copyTo、无 planes → 零填充兜底，绝不静默丢帧
  const zeroed = audioDataToPlanar({ numberOfChannels: 2, numberOfFrames: 4 });
  assert.equal(zeroed.length, 2);
  assert.ok(zeroed.every((p) => p instanceof Float32Array && p.length === 4 && p.every((v) => v === 0)));

  // 通道数回落：仅 channels 别名、二者皆无 → 默认 1
  assert.equal(audioDataToPlanar({ channels: 3, numberOfFrames: 2 }).length, 3);
  assert.equal(audioDataToPlanar({ numberOfFrames: 2 }).length, 1);
});

/* ------------------------------ _createChunk ------------------------------ */

test('_createChunk：key/delta 判定、duration 条件带、createChunk 覆盖与降级纯对象', async () => {
  const { pipeline } = build();
  await pipeline.init();
  const key = pipeline._createChunk('video', { keyframe: true, timestamp: 5, data: new Uint8Array([1]), duration: 100 });
  assert.equal(key.type, 'key');
  assert.equal(key.timestamp, 5);
  assert.equal(key.duration, 100);
  assert.equal(typeof key, 'object');
  assert.ok(key.data instanceof Uint8Array);

  const delta = pipeline._createChunk('audio', { keyframe: false, timestamp: 9, data: new Uint8Array([2]) });
  assert.equal(delta.type, 'delta');
  assert.equal(delta.duration, undefined);

  const override = build({ options: { createChunk: (k, s) => ({ injected: k, t: s.timestamp }) } });
  await override.pipeline.init();
  assert.deepEqual(override.pipeline._createChunk('video', { timestamp: 7 }), { injected: 'video', t: 7 });
});

/* ------------------------------ pushSample 分支 ------------------------------ */

test('pushSample：非活动同类轨样本被丢弃（不进解码器）', async () => {
  const { pipeline, videoDecoder } = build({
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'video', codec: 'avc1.640028' },
      ],
      durationUs: 1_000_000, seekable: true, live: false,
    },
  });
  await pipeline.init();
  assert.equal(pipeline.active.video, 1);
  await pipeline.pushSample(createSample({ trackId: 2, codec: 'avc1.640028', timestamp: 0, keyframe: true, data: new Uint8Array([1]) }));
  assert.equal(videoDecoder.chunks.length, 0, '非活动视频轨样本被丢弃');
  assert.equal(pipeline.counters.videoChunks, 0);
});

test('pushSample：annexb 轨在进解码器前转 AVCC（length-prefixed），原始数据不被直接喂入', async () => {
  const { pipeline, videoDecoder } = build({
    mediaInfo: {
      container: 'mkv',
      tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', bitstreamFormat: 'annexb' }],
      durationUs: 1_000_000, seekable: true, live: false,
    },
  });
  await pipeline.init();
  const raw = new Uint8Array([4, 5, 6]);
  await pipeline.pushSample(createSample({ trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: raw }));
  assert.equal(videoDecoder.chunks.length, 1);
  assert.notEqual(videoDecoder.chunks[0].data, raw, 'annexbToAvcc 产出新缓冲，不共享引用');
  assert.ok(videoDecoder.chunks[0].data instanceof Uint8Array);
});

test('pushSample：背压 _waitQueue 在解码队列超阈值时按调度器让出后再 decode', async () => {
  const scheduler = [];
  const { pipeline, videoDecoder } = build({
    options: {
      maxDecodeQueue: 8,
      schedule: (fn) => { videoDecoder.decodeQueueSize = Math.max(0, videoDecoder.decodeQueueSize - 1); scheduler.push(1); fn(); return () => {}; },
    },
  });
  await pipeline.init();
  videoDecoder.decodeQueueSize = 10; // >= 8 → 需让出
  assert.equal(pipeline.options.maxDecodeQueue, 8);
  await pipeline.pushSample(createSample({ trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: new Uint8Array([1]) }));
  assert.equal(videoDecoder.chunks.length, 1);
  assert.ok(scheduler.length >= 2 && scheduler.length <= 3, `队列从 10 降到 <8 应让出约 2~3 次（实得 ${scheduler.length}）`);
});

/* ------------------------------ 解码错误与渲染错误 ------------------------------ */

test('_onDecodeError：emit error(DECODE_ERROR) 并上报 player.statsValue', async () => {
  let captured = null;
  let mark = null;
  const { pipeline } = build({
    player: { statsValue: { markDecodeError(m) { mark = m; }, markVideoDropped() {}, markVideoRendered() {} } },
  });
  pipeline.on('error', (e) => (captured = e));
  pipeline._onDecodeError(new Error('boom'), 'video');
  assert.equal(captured.code, 'DECODE_ERROR');
  assert.deepEqual(mark, { kind: 'video', message: 'boom' });
});

test('_render：渲染器抛错 → close 帧、emit error，且不计入 framesRendered', async () => {
  const renderer = new FakeRenderer();
  renderer._throws = true;
  const { pipeline } = build({ renderer });
  await pipeline.init();
  pipeline.play();
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));
  const frame = new FakeFrame(0);
  pipeline._render(frame, 0);
  assert.equal(frame.closed, true, '异常路径仍归还帧所有权');
  assert.equal(errors.length, 1);
  assert.equal(pipeline.counters.framesRendered, 0);
});

/* ------------------------------ pump：render/drop/resync/wait ------------------------------ */

test('_pumpFrames：render 正常出帧并记首帧；drop 丢弃迟到帧', async () => {
  const { pipeline, videoDecoder, renderer } = build({
    options: { syncOptions: { maxLateSec: 0.02, maxEarlySec: 0.02, hardResyncSec: 0.5 } },
  });
  await pipeline.init();
  pipeline.avSync.attachMaster(() => 0.1); // 主钟固定 100ms
  pipeline.play();

  const onTime = new FakeFrame(100_000); // dt=0 → render
  videoDecoder.emit(onTime);
  assert.equal(renderer.drawn.length, 1);
  assert.equal(pipeline.counters.framesRendered, 1);
  assert.equal(pipeline._firstFrameEmitted, true);

  const late = new FakeFrame(0); // 落后 100ms > 20ms → drop
  videoDecoder.emit(late);
  assert.equal(renderer.drawn.length, 1);
  assert.equal(late.closed, true);
  assert.equal(pipeline.counters.framesDropped, 1);
});

test('_pumpFrames：resync（视频大幅超前）→ 重锚主钟后继续渲染', async () => {
  const audioOutput = new FakeAudioOutput({ currentTimeUs: 0 });
  const { pipeline, videoDecoder, renderer } = build({ audioOutput });
  await pipeline.init();
  // 复用构造期默认主钟 (() => currentTimeSec)：重锚后 offset 反映到主钟，否则会 resync 死循环
  pipeline.play();

  const resyncs = [];
  pipeline.on('resynced', (e) => resyncs.push(e));
  const frame = new FakeFrame(1_000_000); // 超前 1s > hardResyncSec(0.5)
  videoDecoder.emit(frame);
  assert.ok(resyncs.length >= 1, 'resync 分支触发');
  assert.equal(renderer.drawn.length, 1, '重锚后帧被渲染');
  assert.equal(pipeline._offsetUs, 1_000_000, '主钟已重锚到该帧');
});

test('_pumpFrames：wait（视频超前未达硬重同步）→ 排定定时器后中断，不下发渲染', async () => {
  const scheduled = [];
  const { pipeline, videoDecoder, renderer } = build({
    options: {
      syncOptions: { maxLateSec: 0.02, maxEarlySec: 0.02, hardResyncSec: 0.5 },
      schedule: (fn) => { scheduled.push(fn); return () => {}; }, // 延后执行，避免递归
    },
  });
  await pipeline.init();
  pipeline.avSync.attachMaster(() => 0);
  pipeline.play();
  const frame = new FakeFrame(100_000); // 超前 100ms，介于 early(20ms) 与 hardResync(500ms)
  videoDecoder.emit(frame);
  assert.equal(renderer.drawn.length, 0, 'wait 时不渲染');
  assert.equal(scheduled.length, 1, '已排定一次渲染重试');
  assert.equal(pipeline._frameTimer !== null, true);
});

/* ------------------------------ 直播落后追赶 ------------------------------ */

test('直播落后追赶：_maybeLiveCatchUp 把主钟重锚到 live 边缘目标点', async () => {
  const audioOutput = new FakeAudioOutput({ currentTimeUs: 0 });
  const { pipeline, videoDecoder } = build({
    mediaInfo: {
      container: 'mkv', live: true, durationUs: 0, seekable: false,
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
    options: { liveLatencyUs: 4_000_000 },
    audioOutput,
  });
  await pipeline.init();
  pipeline.play();

  const catchups = [];
  pipeline.on('catchup', (e) => catchups.push(e));
  pipeline._liveEdgeUs = 10_000_000;
  pipeline._maybeLiveCatchUp();

  assert.equal(catchups.length, 1, '落后 liveLatency 目标超过阈值 → 触发追赶');
  assert.equal(pipeline._offsetUs, 6_000_000, '重锚到 liveEdge - liveLatency = 6s');
  assert.equal(pipeline.counters.catchups, 1);
});

test('_catchUpThresholdUs：显式覆盖优先，否则取 liveLatency/2（下限 500ms）', async () => {
  const { pipeline } = build({ options: { catchUpThresholdUs: 1234, liveLatencyUs: 4_000_000 } });
  await pipeline.init();
  assert.equal(pipeline._catchUpThresholdUs(), 1234);

  const def = build({ options: { liveLatencyUs: 4_000_000 } });
  await def.pipeline.init();
  assert.equal(def.pipeline._catchUpThresholdUs(), 2_000_000, '4s/2');

  const noLive = build({});
  await noLive.pipeline.init();
  assert.equal(noLive.pipeline._catchUpThresholdUs(), 1_500_000, '无 liveLatency 使用默认 3s 的一半');
});

/* ------------------------------ 时钟 / 缓冲 / 统计 ------------------------------ */

test('currentTimeSec：音频主钟优先（offset + audioOutput），否则单调钟', async () => {
  const audioOutput = new FakeAudioOutput({ currentTimeUs: 2_000_000 });
  const { pipeline } = build({
    audioOutput,
    mediaInfo: {
      container: 'mkv', durationUs: 1_000_000, seekable: true, live: false,
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
  });
  await pipeline.init();
  pipeline._offsetUs = 1_000_000;
  assert.equal(pipeline.currentTimeUs, 3_000_000, 'offset(1s) + audio(2s)');

  const noAudio = build({ audioOutput: null, options: { now: () => 0 } });
  await noAudio.pipeline.init();
  noAudio.pipeline._clock.seekTo(0.5);
  assert.ok(Math.abs(noAudio.pipeline.currentTimeSec() - 0.5) < 1e-6, '无音频退化为单调钟');
});

test('bufferedAheadUs / getBufferedRanges：音频优先 → 帧队列 → null', async () => {
  // 分支1：音频输出自报优先
  const audioOutput = new FakeAudioOutput({ bufferedAheadUs: 8000 });
  const { pipeline } = build({
    audioOutput,
    mediaInfo: {
      container: 'mkv', durationUs: 1_000_000, seekable: true, live: false,
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
  });
  await pipeline.init();
  assert.equal(pipeline.bufferedAheadUs, 8000, '音频自报优先');

  // 分支2/3：无音频 → 退化为帧队列；无帧则 null
  const noAudio = build({});
  await noAudio.pipeline.init();
  assert.equal(noAudio.pipeline.bufferedAheadUs, null, '无音频无帧 → null');
  assert.equal(noAudio.pipeline.getBufferedRanges(), null);
  noAudio.pipeline.play();
  noAudio.pipeline._frames.push({ frame: new FakeFrame(5_000_000), ts: 5_000_000 });
  assert.equal(noAudio.pipeline.bufferedAheadUs, 5_000_000);
  assert.deepEqual(noAudio.pipeline.getBufferedRanges(), [{ startUs: 0, endUs: 5_000_000 }]);
});

test('stats：聚合计数器 + decodeQueue + underrunCount', async () => {
  const audioOutput = new FakeAudioOutput({ underrunCount: 3 });
  const { pipeline } = build({
    audioOutput,
    mediaInfo: {
      container: 'mkv', durationUs: 1_000_000, seekable: true, live: false,
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
  });
  await pipeline.init();
  pipeline._videoDecoder.decodeQueueSize = 2;
  pipeline._audioDecoder.decodeQueueSize = 3;
  const s = pipeline.stats;
  assert.equal(s.underrunCount, 3);
  assert.equal(s.decodeQueue, 5);
  assert.equal(s.framesRendered, 0);
  assert.equal(s.cues, 0);
});

/* ------------------------------ 播放控制与参数透传 ------------------------------ */

test('setVolume/setMuted/setPlaybackRate 透传音频输出与时钟', async () => {
  const audioOutput = new FakeAudioOutput();
  const clockRate = [];
  const avSyncRate = [];
  const { pipeline } = build({
    audioOutput,
    mediaInfo: {
      container: 'mkv', durationUs: 1_000_000, seekable: true, live: false,
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
    options: {
      clock: { setRate: (r) => clockRate.push(r), getTimeSec: () => 0 },
      avSync: { setRate: (r) => avSyncRate.push(r), start() {}, pause() {}, seekTo() {}, attachMaster() {} },
    },
  });
  await pipeline.init();
  pipeline.setVolume(0.8);
  assert.equal(audioOutput.volume, 0.8);
  pipeline.setMuted(true);
  assert.equal(audioOutput.volume, 0);
  pipeline.setMuted(false);
  assert.equal(audioOutput.volume, 0.5, '非静音回落 player.volume');
  pipeline.setPlaybackRate(2);
  assert.deepEqual(clockRate, [2]);
  assert.deepEqual(avSyncRate, [2]);
});

test('selectTrack：视频轨重建解码链并丢弃待渲染帧；音频轨重建并清缓冲', async () => {
  const audioOutput = new FakeAudioOutput();
  const { pipeline } = build({
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'video', codec: 'avc1.640028' },
        { id: 3, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
        { id: 4, type: 'audio', codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      ],
      durationUs: 1_000_000, seekable: true, live: false,
    },
    audioOutput,
  });
  await pipeline.init();
  pipeline.play();
  const pending = new FakeFrame(0);
  pipeline._frames.push({ frame: pending, ts: 0 });
  const oldVideo = pipeline._videoDecoder;

  const changes = [];
  pipeline.on('trackchange', (e) => changes.push(e));
  await pipeline.selectTrack('video', 2);
  assert.equal(pipeline.active.video, 2);
  assert.equal(pending.closed, true, '旧轨待渲染帧随切换丢弃');
  assert.equal(oldVideo.closed, true, '旧解码器已关闭');
  assert.equal(pipeline._videoDecoder.config.codec, 'avc1.640028', '新解码器已建且按新轨配置');
  assert.equal(pipeline._liveEdgeUs, -1, '视频轨重建后 live edge 重置');
  assert.deepEqual(changes, [{ type: 'video', trackId: 2, codec: 'avc1.640028' }]);

  const oldAudio = pipeline._audioDecoder;
  await pipeline.selectTrack('audio', 4); // 切到第二条音频轨（id3 已是默认激活轨，直接选 id3 会早退）
  assert.equal(oldAudio.closed, true);
  assert.equal(audioOutput.cleared, 1, '切音频轨清缓冲避免可闻断点');
  assert.deepEqual(changes.at(-1), { type: 'audio', trackId: 4, codec: 'opus' });
});

test('selectTrack：未知轨/类型不匹配抛 STATE_ERROR', async () => {
  const { pipeline } = build();
  await pipeline.init();
  await assert.rejects(() => pipeline.selectTrack('video', 999), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => pipeline.selectTrack('audio', 1), (e) => e.code === 'STATE_ERROR');
});
