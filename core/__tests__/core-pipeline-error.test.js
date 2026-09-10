/**
 * core-pipeline-error.test.js
 *
 * 针对 core/src/pipeline-webcodecs.js 的**错误分支与边界**补测：
 *  - 解码器 error 回调 → 上层 DECODE_ERROR 事件（视频/音频/渲染三类）
 *  - 音频输出不可用降级为静音并派发 audio-unavailable
 *  - 非选中轨 / 未知轨 / destroyed 后 pushSample 的早退路径
 *  - selectTrack 视频/音频重建解码链（关闭旧解码器、复用音频输出）
 *  - stats.decodeQueue 统计、bufferedAheadUs/getBufferedRanges 边界与优先级
 *  - 直播落后 catchup 重锚主钟、_masterRealignToUs 对不可控外部钟返回 false
 *  - annexb 轨在 pushSample 内转 AVCC、audioDataToPlanar 回退分支
 *
 * 全部用 Fake 解码器/渲染器/音频输出注入，零浏览器依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline, audioDataToPlanar } from '../src/pipeline-webcodecs.js';
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
    this.kind = null;
  }
  configure(config) { this.config = config; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() { this.resets += 1; }
  close() { this.closed = true; }
  /** 触发解码器 output 回调 */
  emit(frame) { this.init.output(frame); }
  /** 触发解码器 error 回调（错误传播入口） */
  fail(err) { this.init.error(err); }
}

class FakeFrame {
  constructor(timestamp) { this.timestamp = timestamp; this.closed = false; }
  close() { this.closed = true; }
}

class FakeRenderer {
  constructor() { this.drawn = []; this.destroyed = false; }
  draw(frame) { this.drawn.push(frame); frame.close(); }
  destroy() { this.destroyed = true; }
}

class FakeAudioOutput {
  constructor() {
    this.pushed = [];
    this.cleared = 0;
    this.playing = false;
    this.destroyed = false;
    this.bufferedAheadUs = undefined; // 不主动自报 → 走缓冲队列兜底
    this._us = 0;
  }
  async init() {}
  push(channels) { this.pushed.push(channels); }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  clearBuffer() { this.cleared += 1; this._us = 0; }
  setVolume() {}
  destroy() { this.destroyed = true; }
  get currentTimeUs() { return Math.round(this._us * 1000); }
}

/* ------------------------------ 测试夹具 ------------------------------ */

const videoInfo = {
  container: 'mkv',
  tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', width: 1920, height: 1080 }],
  durationUs: 1000000, seekable: true, live: false,
};

const avInfo = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
  durationUs: 1000000, seekable: true, live: false,
};

const twoVideoInfo = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 2, type: 'video', codec: 'avc1.640028' },
  ],
  durationUs: 1000000, seekable: true, live: false,
};

const twoAudioInfo = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    { id: 2, type: 'audio', codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
  ],
  durationUs: 1000000, seekable: true, live: false,
};

/**
 * 每次工厂调用新建一个 FakeDecoder（便于观察 selectTrack 重建）。
 * @param {object} mediaInfo
 * @param {object} [optionsOverrides]
 */
function harness(mediaInfo, optionsOverrides = {}) {
  const createdDecoders = [];
  const videoDecoderFactory = (init) => {
    const d = new FakeDecoder(init); d.kind = 'video'; createdDecoders.push(d); return d;
  };
  const audioDecoderFactory = (init) => {
    const d = new FakeDecoder(init); d.kind = 'audio'; createdDecoders.push(d); return d;
  };
  const audio = new FakeAudioOutput();
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo,
    player: null,
    options: {
      videoDecoderFactory,
      audioDecoderFactory,
      audioOutputFactory: async () => audio,
      schedule: (fn) => { fn(); return () => {}; },
      now: () => 0,
      ...optionsOverrides,
    },
  });
  pipeline.renderer = new FakeRenderer();
  return { pipeline, audio, createdDecoders };
}

const onlyVideo = (decoders) => decoders.find((d) => d.kind === 'video');
const onlyAudio = (decoders) => decoders.find((d) => d.kind === 'audio');

/* ------------------------------ 错误传播 ------------------------------ */

test('解码器 error 回调 → 派发 DECODE_ERROR 事件（视频）', async () => {
  const { pipeline, createdDecoders } = harness(videoInfo);
  await pipeline.init();
  let err = null;
  pipeline.on('error', (e) => (err = e));
  onlyVideo(createdDecoders).fail(new Error('boom'));
  assert.ok(err, '应派发 error 事件');
  assert.equal(err.code, 'DECODE_ERROR');
  assert.match(err.message, /video/);
});

test('音频输出 push 抛错 → 派发 DECODE_ERROR 事件（音频）', async () => {
  const { pipeline, createdDecoders } = harness(avInfo);
  await pipeline.init();
  pipeline.audioOutput.push = () => { throw new Error('sink full'); };
  let err = null;
  pipeline.on('error', (e) => (err = e));
  onlyAudio(createdDecoders).emit({
    numberOfChannels: 1, numberOfFrames: 2, close() {}, copyTo(dst) { dst.fill(1); },
  });
  assert.ok(err, '应派发 error 事件');
  assert.equal(err.code, 'DECODE_ERROR');
  assert.match(err.message, /audio/);
});

test('渲染器 draw 抛错 → 派发 DECODE_ERROR 事件（render）', async () => {
  const { pipeline, createdDecoders } = harness(videoInfo);
  await pipeline.init();
  pipeline.renderer.draw = () => { throw new Error('draw failed'); };
  let err = null;
  pipeline.on('error', (e) => (err = e));
  pipeline.play();
  onlyVideo(createdDecoders).emit(new FakeFrame(0));
  assert.ok(err, '应派发 error 事件');
  assert.equal(err.code, 'DECODE_ERROR');
  assert.match(err.message, /render/);
});

test('音频输出不可用 → 降级静音并派发 audio-unavailable', async () => {
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: avInfo,
    player: null,
    options: {
      videoDecoderFactory: () => new FakeDecoder({ output() {}, error() {} }),
      audioDecoderFactory: () => new FakeDecoder({ output() {}, error() {} }),
      audioOutputFactory: async () => { throw new Error('no audio ctx'); },
      schedule: (fn) => { fn(); return () => {}; },
      now: () => 0,
    },
  });
  let unavailable = null;
  pipeline.on('audio-unavailable', (e) => (unavailable = e));
  await pipeline.init();
  assert.equal(pipeline.audioOutput, null, '无音频输出应降级为 null');
  assert.ok(unavailable, '应派发 audio-unavailable');
});

/* ------------------------------ pushSample 早退路径 ------------------------------ */

test('非选中轨样本被丢弃（不进解码器）', async () => {
  const { pipeline, createdDecoders } = harness(avInfo);
  await pipeline.init();
  const audio = onlyAudio(createdDecoders);
  pipeline.active.audio = 999; // 选中了其它音频轨
  await pipeline.pushSample(createSample({
    trackId: 2, codec: 'mp4a.40.2', timestamp: 0, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(audio.chunks.length, 0, '非选中轨不应解码');
  assert.equal(pipeline.counters.audioChunks, 0);
});

test('未知 trackId 样本被忽略', async () => {
  const { pipeline, createdDecoders } = harness(videoInfo);
  await pipeline.init();
  const video = onlyVideo(createdDecoders);
  await pipeline.pushSample(createSample({ trackId: 999, codec: 'x', timestamp: 0 }));
  assert.equal(video.chunks.length, 0);
});

test('destroyed 后 pushSample 直接返回（不进解码器）', async () => {
  const { pipeline, createdDecoders } = harness(videoInfo);
  await pipeline.init();
  const video = onlyVideo(createdDecoders);
  await pipeline.destroy();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(video.chunks.length, 0);
});

/* ------------------------------ selectTrack 重建 ------------------------------ */

test('video selectTrack 关闭旧解码器并重建新解码链', async () => {
  const { pipeline, createdDecoders } = harness(twoVideoInfo);
  await pipeline.init();
  const first = pipeline._videoDecoder;
  await pipeline.selectTrack('video', 2);
  const second = pipeline._videoDecoder;
  assert.notEqual(first, second, '应新建解码器实例');
  assert.equal(first.closed, true, '旧解码器应被关闭');
  assert.equal(second.config.codec, 'avc1.640028', '新解码器按新轨 codec 配置');
  assert.equal(pipeline.active.video, 2);
  assert.equal(createdDecoders.filter((d) => d.kind === 'video').length, 2);
});

test('audio selectTrack 关闭旧解码器并重建，同格式复用音频输出', async () => {
  const { pipeline, createdDecoders, audio } = harness(twoAudioInfo);
  await pipeline.init();
  const first = pipeline._audioDecoder;
  await pipeline.selectTrack('audio', 2);
  const second = pipeline._audioDecoder;
  assert.notEqual(first, second, '应新建音频解码器');
  assert.equal(first.closed, true);
  assert.equal(second.config.codec, 'opus');
  assert.equal(pipeline.audioOutput, audio, '同格式轨应复用既有音频输出');
  assert.ok(audio.cleared >= 1, '切换时应清缓冲');
});

test('selectTrack 不存在的轨抛 STATE_ERROR', async () => {
  const { pipeline } = harness(twoVideoInfo);
  await pipeline.init();
  await assert.rejects(() => pipeline.selectTrack('video', 999), (e) => e.code === 'STATE_ERROR');
});

/* ------------------------------ 统计与缓冲边界 ------------------------------ */

test('stats.decodeQueue 为视频+音频队列之和', async () => {
  const { pipeline, createdDecoders } = harness(avInfo);
  await pipeline.init();
  onlyVideo(createdDecoders).decodeQueueSize = 3;
  onlyAudio(createdDecoders).decodeQueueSize = 5;
  assert.equal(pipeline.stats.decodeQueue, 8);
});

test('无音频输出且无待渲染帧时 bufferedAheadUs/getBufferedRanges 为 null', async () => {
  const { pipeline } = harness(videoInfo);
  await pipeline.init();
  assert.equal(pipeline.bufferedAheadUs, null);
  assert.equal(pipeline.getBufferedRanges(), null);
});

test('bufferedAheadUs 优先采用音频输出自报水位', async () => {
  const { pipeline, audio } = harness(avInfo);
  await pipeline.init();
  audio.bufferedAheadUs = 1234567;
  assert.equal(pipeline.bufferedAheadUs, 1234567);
  const ranges = pipeline.getBufferedRanges();
  assert.ok(Array.isArray(ranges) && ranges.length === 1);
  assert.equal(ranges[0].endUs - ranges[0].startUs, 1234567);
});

test('setVolume/setMuted 透传音频输出', async () => {
  const { pipeline, audio } = harness(avInfo);
  await pipeline.init();
  let vol = null;
  audio.setVolume = (v) => { vol = v; };
  pipeline.setVolume(0.5);
  assert.equal(vol, 0.5);
  pipeline.setMuted(true);
  assert.equal(vol, 0, 'muted 应透传音量 0');
});

/* ------------------------------ 直播 catchup / 重锚 ------------------------------ */

test('直播落后超过阈值触发 catchup 重锚主钟', async () => {
  const { pipeline, createdDecoders } = harness(
    {
      container: 'mkv', live: true, durationUs: null, seekable: false,
      tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }],
    },
    { liveLatencyUs: 1_000_000 },
  );
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 10_000_000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(pipeline._liveEdgeUs, 10_000_000);

  pipeline.play();
  let catchup = null;
  pipeline.on('catchup', (e) => (catchup = e));
  onlyVideo(createdDecoders).emit(new FakeFrame(10_000_000));

  assert.ok(catchup, '应触发 catchup 事件');
  assert.ok(catchup.behindUs > 0);
  assert.equal(pipeline.counters.catchups, 1);
  // 重锚后主钟应接近 target = liveEdge - latency = 9s
  assert.ok(pipeline.currentTimeUs >= 9_000_000, `currentTimeUs=${pipeline.currentTimeUs}`);
});

test('_masterRealignToUs 对不可控外部钟返回 false（不重锚偏移）', async () => {
  const { pipeline } = harness(videoInfo);
  await pipeline.init();
  pipeline.audioOutput = { currentTimeUs: 5 }; // 有 currentTimeUs 但无 clearBuffer
  const before = pipeline._offsetUs;
  const reanchored = pipeline._masterRealignToUs(1000);
  assert.equal(reanchored, false);
  assert.equal(pipeline._offsetUs, before, '不应改变偏移锚定');
});

/* ------------------------------ annexb 转换 / planar 回退 ------------------------------ */

test('annexb 轨样本在 pushSample 内转 AVCC 后喂解码器', async () => {
  const { pipeline, createdDecoders } = harness({
    container: 'ts',
    tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', bitstreamFormat: 'annexb' }],
    durationUs: 1000000, seekable: true, live: false,
  });
  await pipeline.init();
  const video = onlyVideo(createdDecoders);
  const annexb = new Uint8Array([0, 0, 0, 1, 0x65, 0x01]); // 起始码 + 1 个 NAL
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: annexb,
  }));
  assert.equal(video.chunks.length, 1);
  const out = video.chunks[0].data;
  // AVCC: 4 字节长度前缀 = NAL 大小 2
  assert.deepEqual([out[0], out[1], out[2], out[3]], [0, 0, 0, 2]);
  assert.deepEqual([...out.subarray(4)], [0x65, 0x01]);
});

test('audioDataToPlanar 无 copyTo 且无 planes 时退化为零填充', () => {
  const out = audioDataToPlanar({ numberOfChannels: 2, numberOfFrames: 4 });
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 4);
  assert.deepEqual([...out[0]], [0, 0, 0, 0]);
  assert.deepEqual([...out[1]], [0, 0, 0, 0]);
});

test('audioDataToPlanar 读取 channels/frames 别名与 planes 直读', () => {
  const out = audioDataToPlanar({ channels: 1, frames: 3, planes: [new Float32Array([7, 8, 9])] });
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0]], [7, 8, 9]);
});
