/**
 * 浏览器端到端验收暴露缺陷的 Node 防回归（第四十三波 M3）。
 *
 * 三条缺陷均为「Node 假实现不检查字节内容/原生绑定，只有真实 Chrome 才暴露」：
 *  1. capabilities.hasAudioWorklet 直读 prototype.audioWorklet（accessor）→ Chrome Illegal invocation；
 *     修复为 `'audioWorklet' in AudioContext.prototype`（不触发 getter）。
 *  2. WebCodecsPipeline 对 annexb 轨（TS/裸流）直接把起始码样本喂 VideoDecoder → 解码错误自动 closed；
 *     修复为 decode 前 annexbToAvcc（avcC length-prefixed）。
 *  3. pipeline.seek() 调 decoder.reset() 后未重新 configure → 后续 decode 报 "unconfigured codec"；
 *     修复为保存配置并在 reset 后重新 configure。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';
import { hasAudioWorklet } from '../src/capabilities.js';
import { createSample } from '../src/types.js';

class FakeDecoder {
  constructor(init) {
    this.init = init;
    this.config = null;
    this.closed = false;
    this.resets = 0;
    this.configureCount = 0;
    this.decodeQueueSize = 0;
    this.chunks = [];
  }
  configure(config) { this.config = config; this.configureCount += 1; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() { this.resets += 1; }
  close() { this.closed = true; }
}

class FakeAudioOutput {
  constructor() { this.cleared = 0; }
  async init() {}
  clearBuffer() { this.cleared += 1; }
  play() {}
  pause() {}
  setVolume() {}
  destroy() {}
  get currentTimeUs() { return 0; }
}

const annexbInfo = {
  container: 'ts',
  tracks: [{ id: 1, type: 'video', codec: 'avc1.64001F', bitstreamFormat: 'annexb' }],
  durationUs: 30_000_000,
  seekable: false,
  live: false,
};

const avInfo = {
  container: 'mp4',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E', description: new Uint8Array([1, 2, 3]) },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x12, 0x10]) },
  ],
  durationUs: 52_000_000,
  seekable: true,
  live: false,
};

function build(mediaInfo, overrides = {}) {
  const videoDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const audioDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const audio = overrides.audioOutput ?? new FakeAudioOutput();
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo,
    player: null,
    options: {
      videoDecoderFactory: (init) => { videoDecoder.init = init; return videoDecoder; },
      audioDecoderFactory: (init) => { audioDecoder.init = init; return audioDecoder; },
      audioOutputFactory: async () => audio,
      schedule: (fn) => { fn(); return () => {}; },
      now: () => 0,
      ...overrides.options,
    },
  });
  return { pipeline, videoDecoder, audioDecoder, audio };
}

test('hasAudioWorklet：原型上 audioWorklet 为 accessor 时用 `in` 探测、不触发 getter（防 Chrome Illegal invocation）', () => {
  const orig = globalThis.AudioContext;
  try {
    // 模拟真实 Chrome：audioWorklet 是原型 accessor，直读会因 this=prototype 抛错
    class StubAudioContext {}
    Object.defineProperty(StubAudioContext.prototype, 'audioWorklet', {
      get() { throw new Error('getter 不应被触发（直读 prototype.audioWorklet 会 Illegal invocation）'); },
      configurable: true,
    });
    globalThis.AudioContext = StubAudioContext;
    assert.equal(hasAudioWorklet(), true, 'in 探测只查存在性，不触发 getter');
  } finally {
    globalThis.AudioContext = orig;
  }
});

test('annexb 轨（TS）视频样本 decode 前转 avcC：chunk.data 为长度前缀格式', async () => {
  const { pipeline, videoDecoder } = build(annexbInfo);
  await pipeline.init();
  pipeline.play();

  // AnnexB：00 00 00 01 65 88 | 00 00 01 09 f0（两个 NAL）
  const annexb = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0, 0, 1, 0x09, 0xf0]);
  await pipeline.pushSample(createSample({ trackId: 1, codec: 'avc1.64001F', timestamp: 0, keyframe: true, data: annexb }));

  assert.equal(videoDecoder.chunks.length, 1);
  const data = videoDecoder.chunks[0].data;
  assert.ok(data instanceof Uint8Array);
  // 首 NAL 长度 2 → 00 00 00 02 65 88；次 NAL 长度 2 → 00 00 00 02 09 f0
  assert.deepEqual([...data], [0, 0, 0, 2, 0x65, 0x88, 0, 0, 0, 2, 0x09, 0xf0],
    'annexb 起始码样本必须转换为 avcC（长度前缀）后才能喂 VideoDecoder');
});

test('seek：decoder.reset() 后立即重新 configure 保存的配置（防 decode on unconfigured）', async () => {
  const { pipeline, videoDecoder, audioDecoder } = build(avInfo);
  await pipeline.init();

  const vCfg0 = videoDecoder.config;
  const aCfg0 = audioDecoder.config;
  pipeline.seek(10_000_000);

  assert.equal(videoDecoder.resets, 1);
  assert.equal(videoDecoder.configureCount, 2, 'reset 后必须重新 configure');
  assert.equal(videoDecoder.config, vCfg0, '沿用初次配置对象（含 description）');
  assert.equal(audioDecoder.resets, 1);
  assert.equal(audioDecoder.configureCount, 2);
  assert.equal(audioDecoder.config, aCfg0);

  // 重配后可正常 decode（不抛）
  await pipeline.pushSample(createSample({ trackId: 1, codec: 'avc1.42E01E', timestamp: 10_000_000, keyframe: true, data: new Uint8Array([1]) }));
  assert.equal(videoDecoder.chunks.length, 1);
});
