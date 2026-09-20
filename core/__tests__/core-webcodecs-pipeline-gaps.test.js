/**
 * core-webcodecs-pipeline-gaps.test.js —— WebCodecs 管线残余分支补测（wave 161）
 *
 * 覆盖：
 *   - defaultSchedule（21-25）：未注入 schedule 时走真实 setTimeout/unref/clearTimeout；
 *   - resync 重锚不可行（外部不可控钟：有 currentTimeUs 无 clearBuffer）→ break（380-381）；
 *   - _render 无渲染器 → _closeFrame 归还帧（465）；
 *   - _closeFrame 双重 close 抛错被吞（483-484）；
 *   - selectTrack 视频：新解码器配置期间 destroy → 回收新解码器早退（570-573）；
 *   - _setupAudio 输出复用路径代际过期：channels getter 内 destroy → 223 守卫（224/228/229）。
 *
 * 登记不可达：225-227（新输出路径中 217 守卫与 223 间无 await、条件完全包含，同步不可翻转）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeDecoder {
  constructor(init) {
    this.init = init ?? { output: () => {}, error: () => {} };
    this.config = null;
    this.closed = false;
    this.chunks = [];
    this.decodeQueueSize = 0;
  }
  configure(config) { this.config = config; }
  decode(chunk) { this.chunks.push(chunk); }
  close() { this.closed = true; }
  emit(frame) { this.init.output(frame); }
}

class FakeFrame {
  constructor(timestamp) { this.timestamp = timestamp; this.closed = false; }
  close() { this.closed = true; }
}

class ThrowingCloseFrame {
  close() { throw new Error('双重 close'); }
}

class FakeRenderer {
  constructor() { this.drawn = []; }
  draw(frame) { this.drawn.push(frame); frame.close(); }
  destroy() { this.destroyed = true; }
}

class FakeAudioOutput {
  constructor({ sampleRate = 48000, channels = 2, currentTimeUs = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this._currentTimeUs = currentTimeUs;
    this.destroyed = false;
  }
  async init() {}
  push() {}
  play() {}
  pause() {}
  clearBuffer() {}
  destroy() { this.destroyed = true; }
  get currentTimeUs() { return this._currentTimeUs; }
}

const DEFAULT_MEDIA = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E', width: 1920, height: 1080 },
    { id: 3, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
  durationUs: 1_000_000, seekable: true, live: false,
};

function build({ mediaInfo = DEFAULT_MEDIA, options = {}, audioOutput = new FakeAudioOutput(), renderer = new FakeRenderer() } = {}) {
  const videoDecoder = new FakeDecoder();
  const audioDecoder = new FakeDecoder();
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo,
    player: { volume: 0.5, statsValue: { markDecodeError() {}, markVideoDropped() {}, markVideoRendered() {} } },
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

test('defaultSchedule：未注入 schedule 时真实 setTimeout 排定 wait 重试，到点渲染', async () => {
  let nowSec = 0;
  const { pipeline, videoDecoder, renderer } = build({
    mediaInfo: { ...DEFAULT_MEDIA, tracks: [DEFAULT_MEDIA.tracks[0]] },
    options: { schedule: undefined, now: () => nowSec }, // 回落 defaultSchedule
  });
  await pipeline.init();
  pipeline.play();

  videoDecoder.emit(new FakeFrame(100_000)); // 超前 100ms → wait 100ms
  assert.equal(typeof pipeline._frameTimer, 'function', 'defaultSchedule 已返回取消句柄');
  assert.equal(renderer.drawn.length, 0, '等待期不渲染');

  nowSec = 0.1; // 定时器到点前主钟推进到 100ms
  await sleep(180);
  assert.equal(renderer.drawn.length, 1, '真实定时器触发重排并渲染');
});

test('resync：外部不可控钟（有 currentTimeUs 无 clearBuffer）重锚失败 → break 保帧等待', async () => {
  const external = {
    sampleRate: 48000, channels: 2, currentTimeUs: 0, // 数字 currentTimeUs 但无 clearBuffer
    pushed: [], async init() {}, push() {}, play() {}, pause() {}, destroy() {},
  };
  const { pipeline, videoDecoder, renderer } = build({ audioOutput: external });
  await pipeline.init();
  pipeline.play();
  const resyncs = [];
  pipeline.on('resynced', (e) => resyncs.push(e));

  const frame = new FakeFrame(1_000_000); // 超前 1s ≥ hardResync → resync
  videoDecoder.emit(frame);

  assert.deepEqual(resyncs, [], '重锚不可行不派发 resynced');
  assert.equal(renderer.drawn.length, 0, 'break 后不渲染');
  assert.equal(pipeline._frames.length, 1, '帧保留在队列等待后续泵动');
  assert.equal(frame.closed, false);
});

test('_render：无渲染器时直接归还帧，仍计数并派发 rendered/firstframe', async () => {
  const { pipeline, videoDecoder } = build();
  await pipeline.init();
  pipeline.renderer = null;
  pipeline.play();
  const events = [];
  pipeline.on('rendered', () => events.push('rendered'));
  pipeline.on('firstframe', () => events.push('firstframe'));

  const frame = new FakeFrame(0);
  videoDecoder.emit(frame);

  assert.equal(frame.closed, true);
  assert.equal(pipeline.counters.framesRendered, 1);
  assert.deepEqual(events, ['rendered', 'firstframe']);
});

test('_closeFrame：帧 close 抛错（双重 close）被吞，不影响渲染计数', async () => {
  const { pipeline } = build();
  await pipeline.init();
  pipeline.renderer = null;
  pipeline.play();
  pipeline._firstFrameEmitted = true; // 简化事件断言，只验证不抛

  assert.doesNotThrow(() => pipeline._render(new ThrowingCloseFrame(), 0));
  assert.equal(pipeline.counters.framesRendered, 1);
});

test('selectTrack(video)：新解码器配置期间 destroy → 回收新解码器、_videoDecoder 置空、早退', async () => {
  let pipeline;
  const created = [];
  pipeline = build({
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'video', codec: 'avc1.640028' },
      ],
      durationUs: 1_000_000, seekable: true, live: false,
    },
    options: {
      videoDecoderFactory: (init) => {
        const decoder = new FakeDecoder(init);
        const configure = decoder.configure.bind(decoder);
        const isNewTrackDecoder = created.length >= 1; // init 已建过首轨解码器
        decoder.configure = (config) => {
          if (isNewTrackDecoder) void pipeline.destroy(); // 新轨解码器配置时销毁
          configure(config);
        };
        created.push(decoder);
        return decoder;
      },
    },
  }).pipeline;
  await pipeline.init();

  await pipeline.selectTrack('video', 2); // 不 reject，早退

  assert.equal(created[1].closed, true, '迟到的新解码器被回收');
  assert.equal(pipeline._videoDecoder, null);
  assert.equal(pipeline.active.video, 1, '未提交轨切换');
  assert.equal(pipeline.state, 'destroyed');
});

test('_setupAudio：输出复用路径下 channels 读取时 destroy → 代际守卫回收新解码器（223-229）', async () => {
  let pipeline;
  const createdAudio = [];
  const audioOutput = new FakeAudioOutput();
  pipeline = build({
    mediaInfo: {
      container: 'mkv',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 3, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
        { id: 4, type: 'audio', codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2 },
      ],
      durationUs: 1_000_000, seekable: true, live: false,
    },
    audioOutput,
    options: {
      audioDecoderFactory: (init) => {
        const decoder = new FakeDecoder(init);
        createdAudio.push(decoder);
        return decoder;
      },
    },
  }).pipeline;
  await pipeline.init();

  // 同格式轨本应复用输出；在 channels 读取瞬间 destroy（代际翻转）
  Object.defineProperty(audioOutput, 'channels', {
    configurable: true,
    get() { void pipeline.destroy(); return 2; },
  });

  await pipeline.selectTrack('audio', 4);

  assert.equal(createdAudio[1].closed, true, '代际过期的新音频解码器被关闭');
  assert.equal(pipeline._audioDecoder, null);
  assert.equal(pipeline.active.audio, 3, '未提交轨切换');
  assert.equal(pipeline.state, 'destroyed');
});
