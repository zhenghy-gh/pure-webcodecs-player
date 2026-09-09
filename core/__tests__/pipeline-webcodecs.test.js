import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline, webcodecsPipelineFactory, audioDataToPlanar } from '../src/pipeline-webcodecs.js';
import { Player } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/** 假解码器：记录 configure/decode/close，decode 后同步回调 output */
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
  destroy() { this.destroyed = true; }
}

class FakeAudioOutput {
  constructor() { this.pushed = []; this.cleared = 0; this.playing = false; this._us = 0; }
  async init() {}
  push(channels) { this.pushed.push(channels); this._us += (channels[0]?.length ?? 0) / 48; }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  clearBuffer() { this.cleared += 1; this._us = 0; }
  setVolume() {}
  destroy() { this.destroyed = true; }
  get currentTimeUs() { return Math.round(this._us * 1000); }
}

const videoInfo = {
  container: 'mkv',
  tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', width: 1920, height: 1080 }],
  durationUs: 1000000,
  seekable: true,
  live: false,
};

const avInfo = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
  durationUs: 1000000,
  seekable: true,
  live: false,
};

function build(overrides = {}) {
  const videoDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const audioDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const renderer = overrides.renderer ?? new FakeRenderer();
  const audio = overrides.audioOutput ?? new FakeAudioOutput();
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: overrides.mediaInfo ?? videoInfo,
    player: overrides.player ?? null,
    options: {
      videoDecoderFactory: (init) => { videoDecoder.init = init; return videoDecoder; },
      audioDecoderFactory: (init) => { audioDecoder.init = init; return audioDecoder; },
      audioOutputFactory: async () => audio,
      schedule: (fn) => { fn(); return () => {}; },
      now: () => overrides.nowSeconds ?? 0,
      ...overrides.options,
    },
  });
  pipeline.renderer = renderer;
  return {
    pipeline,
    get videoDecoder() { return videoDecoder; },
    get audioDecoder() { return audioDecoder; },
    renderer,
    audio,
  };
}

test('init：按轨建解码器，缺解码器能力时报 NOT_SUPPORTED', async () => {
  const { pipeline, videoDecoder } = build();
  await pipeline.init();
  assert.equal(videoDecoder.config.codec, 'avc1.42E01E');
  assert.equal(videoDecoder.config.optimizeForLatency, true);

  const bare = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: videoInfo,
    player: null,
    options: { videoDecoderFactory: null, audioDecoderFactory: null },
  });
  await assert.rejects(() => bare.init(), (e) => e.code === 'NOT_SUPPORTED');
});

test('视频样本 → 解码 → 渲染，帧所有权由渲染器关闭', async () => {
  const { pipeline, videoDecoder, renderer } = build();
  await pipeline.init();
  pipeline.play();

  await pipeline.pushSample(createSample({ trackId: 1, codec: 'avc1.42E01E', timestamp: 0, keyframe: true, data: new Uint8Array([1]) }));
  const frame = new FakeFrame(0);
  videoDecoder.emit(frame);

  assert.equal(renderer.drawn.length, 1);
  assert.equal(frame.closed, true, '渲染后必须 close（finally 单一所有权）');
  assert.equal(pipeline.counters.framesRendered, 1);
  assert.equal(pipeline.counters.videoChunks, 1);
});

test('落后帧按 AvSync 决策丢弃并计入统计', async () => {
  const { pipeline, videoDecoder, renderer } = build({
    options: { syncOptions: { maxLateSec: 0.02, maxEarlySec: 0.02, hardResyncSec: 0.5 } },
  });
  await pipeline.init();
  // 主钟固定 100ms，帧 pts=0 → 迟到 100ms（>20ms 阈值且未到硬重同步）→ drop
  pipeline.avSync.attachMaster(() => 0.1);
  pipeline.play();

  const frame = new FakeFrame(0);
  videoDecoder.emit(frame);
  assert.equal(renderer.drawn.length, 0);
  assert.equal(frame.closed, true, '丢弃的帧也必须 close');
  assert.equal(pipeline.counters.framesDropped, 1);
});

test('音频 AudioData 转 f32-planar 后送音频输出', async () => {
  const { pipeline, audioDecoder, audio } = build({ mediaInfo: avInfo });
  await pipeline.init();
  const data = {
    numberOfChannels: 2,
    numberOfFrames: 4,
    close() { this.closed = true; },
    copyTo(dst, opts) { dst.fill(opts.planeIndex + 1); },
  };
  audioDecoder.emit(data);
  assert.equal(audio.pushed.length, 1);
  assert.equal(audio.pushed[0].length, 2);
  assert.equal(audio.pushed[0][0][0], 1);
  assert.equal(audio.pushed[0][1][0], 2);
  assert.equal(data.closed, true);
  assert.deepEqual(audioDataToPlanar({ numberOfChannels: 1, numberOfFrames: 2, planes: [new Float32Array([9, 8])] }), [new Float32Array([9, 8])]);
});

test('seek：清缓冲、重置解码器并叠加时间偏移', async () => {
  const { pipeline, videoDecoder, audioDecoder, audio } = build({ mediaInfo: avInfo });
  await pipeline.init();
  const pending = new FakeFrame(500000);
  videoDecoder.emit(pending); // 未播放 → 保留在队列
  pipeline.seek(900000);
  assert.equal(videoDecoder.resets, 1);
  assert.equal(audioDecoder.resets, 1);
  assert.equal(audio.cleared, 1);
  assert.equal(pending.closed, true, 'seek 必须释放待渲染帧');
  assert.ok(pipeline.currentTimeUs >= 900000);
});

test('字幕样本产出 cue 事件', async () => {
  const { pipeline } = build({
    mediaInfo: { container: 'mkv', tracks: [{ id: 3, type: 'text', codec: 'x-srt' }], durationUs: 1000, seekable: true, live: false },
  });
  await pipeline.init();
  const cues = [];
  pipeline.on('cue', (c) => cues.push(c));
  await pipeline.pushSample(createSample({
    trackId: 3, codec: 'x-srt', timestamp: 1000000, duration: 2000000, keyframe: true,
    data: new TextEncoder().encode('hello'),
  }));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'hello');
  assert.equal(cues[0].startUs, 1000000);
  assert.equal(cues[0].endUs, 3000000);
});

test('Player + WebCodecs 管线：load → play → 解码渲染闭环', async () => {
  class ToyAvDemuxer extends Demuxer {
    async _doOpen() {
      return {
        container: 'mkv',
        tracks: [
          { id: 1, type: 'video', codec: 'avc1.42E01E' },
          { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
        ],
        durationUs: 200000,
        seekable: true,
        live: false,
      };
    }
    _createTrackIterator(id) {
      const source = this.source;
      return (async function* () {
        yield createSample({ trackId: id, codec: id === 1 ? 'avc1.42E01E' : 'mp4a.40.2', timestamp: 0, duration: 100000, keyframe: true, data: await source.read(0, 1), size: 1 });
      })();
    }
  }
  const videoDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const audioDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const renderer = new FakeRenderer();
  const audio = new FakeAudioOutput();
  const caps = {
    webcodecs: { supported: true, video: { 'avc1.42E01E': true }, audio: { 'mp4a.40.2': true } },
    mse: { supported: false, mimeTypes: [] },
  };
  const player = new Player({
    demuxerFactory: () => new ToyAvDemuxer(new MemoryDataSource(new Uint8Array([1]))),
    capabilities: caps,
    pipelineFactory: webcodecsPipelineFactory({
      videoDecoderFactory: (init) => { videoDecoder.init = init; return videoDecoder; },
      audioDecoderFactory: (init) => { audioDecoder.init = init; return audioDecoder; },
      audioOutputFactory: async () => audio,
      schedule: (fn) => { fn(); return () => {}; },
    }),
  });

  await player.load(new Uint8Array([1]));
  player.pipeline.renderer = renderer;
  let firstframe = null;
  player.on('firstframe', (e) => (firstframe = e));

  await player.play();
  assert.equal(player.state, 'playing');
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(videoDecoder.chunks.length, 1, '视频样本已进解码器');
  assert.equal(audioDecoder.chunks.length, 1, '音频样本已进解码器');

  videoDecoder.emit(new FakeFrame(0));
  assert.equal(renderer.drawn.length, 1);
  assert.ok(firstframe, '首帧事件已上抛到 Player');
  assert.ok(player.currentTimeUs >= 0);

  await player.destroy();
  assert.equal(videoDecoder.closed, true);
  assert.equal(player.state, 'destroyed');
});

test('destroy：待渲染帧与解码器全部释放且幂等', async () => {
  const { pipeline, videoDecoder, audioDecoder, renderer, audio } = build({ mediaInfo: avInfo });
  await pipeline.init();
  const frame = new FakeFrame(0);
  videoDecoder.emit(frame);
  await pipeline.destroy();
  assert.equal(frame.closed, true);
  assert.equal(videoDecoder.closed, true);
  assert.equal(audioDecoder.closed, true);
  assert.equal(renderer.destroyed, true);
  assert.equal(audio.destroyed, true);
  await pipeline.destroy(); // 幂等
  assert.equal(pipeline.counters.framesRendered, 0);
});
