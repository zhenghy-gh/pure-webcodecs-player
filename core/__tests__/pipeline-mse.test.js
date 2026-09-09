import test from 'node:test';
import assert from 'node:assert/strict';
import { MsePipeline, msePipelineFactory } from '../src/pipeline-mse.js';
import { Player } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/** 假 MediaSource 封装：记录 addTrack/append/reset/endOfStream */
class FakeMseHelper {
  constructor() {
    this.opened = false;
    this.tracks = new Map();
    this.appends = [];
    this.resetCalls = [];
    this.duration = null;
    this.eos = 0;
    this.destroyed = false;
    this._aheadCalls = 0;
    this._ahead = 0;
  }
  async open() { this.opened = true; }
  async addTrack(key, mime) {
    const channel = { key, mime };
    this.tracks.set(key, channel);
    return channel;
  }
  async append(key, data) { this.appends.push({ key, byteLength: data.byteLength }); }
  bufferedAhead() {
    this._aheadCalls += 1;
    return this._aheadCalls <= 2 ? this._ahead : 0;
  }
  async setDuration(sec) { this.duration = sec; }
  async resetTrack(key, keepPosition) { this.resetCalls.push({ key, keepPosition }); }
  async endOfStream() { this.eos += 1; }
  destroy() { this.destroyed = true; }
}

/** 假 fMP4 重封装器：init/media 都产出可校验的占位段 */
class FakeRemuxer {
  constructor() { this.seq = 0; this.inits = []; this.segments = []; }
  createInitSegment(track) {
    this.inits.push(track.id);
    return new Uint8Array([0xf0, track.id]);
  }
  createMediaSegment(track, samples) {
    this.segments.push({ trackId: track.id, count: samples.length });
    return {
      data: new Uint8Array(samples.length),
      sequenceNumber: this.seq++,
      sampleCount: samples.length,
      baseMediaDecodeTimeUs: samples[0].timestamp,
      durationUs: samples.reduce((a, s) => a + (s.duration ?? 0), 0),
    };
  }
}

/** 假 mediaElement：只需 currentTime/play/pause/事件 */
class FakeMediaElement {
  constructor() {
    this.currentTime = 0;
    this.playing = false;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.listeners = new Map();
  }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }
  emit(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({}); }
}

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
  const mse = overrides.mse ?? new FakeMseHelper();
  const element = overrides.element ?? new FakeMediaElement();
  const remuxer = overrides.remuxer ?? new FakeRemuxer();
  const scheduleCalls = { n: 0 };
  const pipeline = new MsePipeline({
    route: 'mse',
    mediaInfo: overrides.mediaInfo ?? avInfo,
    player: overrides.player ?? null,
    options: {
      mediaElement: element,
      mse,
      remuxer,
      schedule: (fn) => { scheduleCalls.n += 1; fn(); return () => {}; },
      ...overrides.options,
    },
  });
  return { pipeline, mse, element, remuxer, scheduleCalls };
}

test('init：双轨建 SourceBuffer 并写 init segment，mime 按轨类型组装', async () => {
  const { pipeline, mse, remuxer } = build();
  await pipeline.init();
  assert.equal(mse.opened, true);
  assert.equal(mse.tracks.get('v1').mime, 'video/mp4; codecs="avc1.42E01E"');
  assert.equal(mse.tracks.get('a2').mime, 'audio/mp4; codecs="mp4a.40.2"');
  assert.deepEqual(remuxer.inits, [1, 2], '每条媒体轨各写一次 init');
  assert.equal(mse.duration, 1, 'durationUs → 秒');
  assert.equal(pipeline.counters.initSegments, 2);
});

test('缺少 mediaElement：init 报 NOT_SUPPORTED', async () => {
  const pipeline = new MsePipeline({
    route: 'mse',
    mediaInfo: avInfo,
    player: null,
    options: { mse: new FakeMseHelper(), remuxer: new FakeRemuxer() },
  });
  await assert.rejects(() => pipeline.init(), (e) => e.code === 'NOT_SUPPORTED');
});

test('样本按 GOP 边界 + 目标时长成段，段首为关键帧', async () => {
  const { pipeline, mse, remuxer } = build({ options: { segmentDurationUs: 200000 } });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(mse.appends.length, 2, '未达目标时长不成段');
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 100000, duration: 150000, keyframe: true, data: new Uint8Array([2]),
  }));
  assert.equal(remuxer.segments.length, 1);
  assert.equal(remuxer.segments[0].count, 2, '两段合一段：段首是关键帧');
  assert.equal(mse.appends.length, 3);
  assert.equal(mse.appends[2].key, 'v1');
  assert.equal(pipeline.counters.mediaSegments, 1);
  assert.equal(pipeline.counters.samples, 2);
});

test('背压：缓冲水位超阈值时让出事件循环再 append', async () => {
  const mse = new FakeMseHelper();
  mse._ahead = 60; // > 默认 30s 水位
  const { pipeline, scheduleCalls } = build({ mse, options: { segmentDurationUs: 200000 } });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 300000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.ok(scheduleCalls.n >= 2, '超水位时应等待而非无条件 append');
  assert.equal(mse.appends.length, 3, '水位回落后完成 append');
});

test('seek：丢弃待封装样本、逐轨清缓冲、对齐元素时间轴', async () => {
  const { pipeline, mse, element } = build();
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  await pipeline.seek(2500000);
  assert.deepEqual(mse.resetCalls, [
    { key: 'v1', keepPosition: false },
    { key: 'a2', keepPosition: false },
  ]);
  assert.equal(element.currentTime, 2.5);
  assert.equal(await pipeline.flush(1), null, 'seek 后待封装样本已丢弃');
});

test('end：收尾 flush 后 endOfStream（否则元素永不 ended）', async () => {
  const { pipeline, mse } = build();
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  await pipeline.end();
  assert.equal(mse.eos, 1);
  assert.equal(pipeline.counters.mediaSegments, 1);
});

test('字幕样本产出 cue 事件（不进 SourceBuffer）', async () => {
  const { pipeline, mse } = build({
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
  assert.equal(mse.appends.length, 0, '字幕不建 SourceBuffer');
});

test('destroy：释放 MediaSource 与元素监听，且幂等', async () => {
  const { pipeline, mse, element } = build();
  await pipeline.init();
  await pipeline.destroy();
  assert.equal(mse.destroyed, true);
  assert.equal(element.listeners.get('waiting')?.length ?? 0, 0, '元素监听已解绑');
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(mse.appends.length, 2, 'destroy 后不再 append');
  await pipeline.destroy();
  assert.equal(pipeline.state, 'destroyed');
});

test('Player + MSE 管线：load → play → 成段 → endOfStream → destroy 闭环', async () => {
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
        yield createSample({
          trackId: id,
          codec: id === 1 ? 'avc1.42E01E' : 'mp4a.40.2',
          timestamp: 0,
          duration: 200000,
          keyframe: true,
          data: await source.read(0, 1),
          size: 1,
        });
      })();
    }
  }

  const mse = new FakeMseHelper();
  const element = new FakeMediaElement();
  const remuxer = new FakeRemuxer();
  const player = new Player({
    route: 'mse',
    demuxerFactory: () => new ToyAvDemuxer(new MemoryDataSource(new Uint8Array([1]))),
    capabilities: { webcodecs: { supported: false, video: {}, audio: {} }, mse: { supported: true, mimeTypes: [] } },
    pipelineFactory: msePipelineFactory({
      mediaElement: element,
      mse,
      remuxer,
      schedule: (fn) => { fn(); return () => {}; },
    }),
  });

  await player.load(new Uint8Array([1]));
  assert.equal(player.route, 'mse');
  assert.equal(mse.opened, true);

  await player.play();
  assert.equal(element.playing, true);
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(remuxer.segments.length, 2, '视频/音频各成一段');
  assert.equal(mse.eos, 1, '样本泵结束触发 endOfStream');
  assert.equal(player.ended, true);

  await player.destroy();
  assert.equal(mse.destroyed, true);
  assert.equal(player.state, 'destroyed');
});
