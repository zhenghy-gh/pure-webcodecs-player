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

const multiTrackInfo = {
  container: 'mkv',
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.42E01E' },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    { id: 3, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
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

test('init：并发调用共享同一 Promise，不重复创建轨道或写 init', async () => {
  let releaseOpen;
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const mse = new FakeMseHelper();
  mse.open = async () => openGate;
  const { pipeline, remuxer } = build({ mse });

  const first = pipeline.init();
  const second = pipeline.init();
  assert.equal(first, second, '并发 init 应共享同一 Promise');
  releaseOpen();
  await Promise.all([first, second]);

  assert.equal(mse.tracks.size, 2);
  assert.deepEqual(remuxer.inits, [1, 2]);
  assert.equal(pipeline.counters.initSegments, 2);
});

test('msePipelineFactory：初始化失败时回收已创建的 MediaSource', async () => {
  const mse = new FakeMseHelper();
  mse.append = async (key, data) => {
    if (key === 'v1') throw new Error('init append failed');
    mse.appends.push({ key, byteLength: data.byteLength });
  };

  await assert.rejects(
    () => msePipelineFactory({ mediaElement: new FakeMediaElement(), mse, remuxer: new FakeRemuxer() })({
      route: 'mse', mediaInfo: avInfo, player: null, options: {},
    }),
    /init append failed/,
  );
  assert.equal(mse.destroyed, true, '工厂初始化失败应回收已创建的 MediaSource');
});
test('init：部分轨道 init 成功后失败，重试只补写未完成轨道', async () => {
  let failInit = true;
  const mse = new FakeMseHelper();
  const append = mse.append.bind(mse);
  mse.append = async (key, data) => {
    if (key === 'a2' && failInit && data[0] === 0xf0) {
      failInit = false;
      throw new Error('audio init append failed');
    }
    return append(key, data);
  };
  const { pipeline, remuxer } = build({ mse });
  const added = [];
  pipeline.on('trackAdded', (event) => added.push(event));

  await assert.rejects(() => pipeline.init(), /audio init append failed/);
  assert.deepEqual(remuxer.inits, [1, 2]);
  assert.deepEqual(added.map(({ key }) => key), ['v1', 'a2']);
  assert.deepEqual([...pipeline._initializedTracks], ['v1']);
  assert.equal(pipeline.counters.initSegments, 1);

  await pipeline.init();
  assert.deepEqual(remuxer.inits, [1, 2, 2]);
  assert.deepEqual(added.map(({ key }) => key), ['v1', 'a2']);
  assert.deepEqual([...pipeline._initializedTracks], ['v1', 'a2']);
  assert.equal(pipeline.counters.initSegments, 2);
});
test('init：mseFactory 迟到于 destroy 时回收未挂载的 MediaSource', async () => {
  let releaseMse;
  const mseReady = new Promise((resolve) => { releaseMse = resolve; });
  const lateMse = new FakeMseHelper();
  const element = new FakeMediaElement();
  const pipeline = new MsePipeline({
    route: 'mse',
    mediaInfo: avInfo,
    player: null,
    options: {
      mediaElement: element,
      mseFactory: async () => {
        await mseReady;
        return lateMse;
      },
      remuxer: new FakeRemuxer(),
    },
  });

  const initializing = pipeline.init();
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.destroy();
  releaseMse();
  await initializing;

  assert.equal(lateMse.destroyed, true, '迟到的 MediaSource 必须回收');
  assert.equal(pipeline.mse, null);
  assert.equal(pipeline.state, 'destroyed');
});

test('init：open 完成后 destroy 不再创建 SourceBuffer 或写入 init', async () => {
  let releaseOpen;
  const openReady = new Promise((resolve) => { releaseOpen = resolve; });
  const mse = new FakeMseHelper();
  let addTrackCalls = 0;
  const addTrack = mse.addTrack.bind(mse);
  mse.addTrack = async (...args) => {
    addTrackCalls += 1;
    return addTrack(...args);
  };
  let releaseRemuxer;
  const remuxerReady = new Promise((resolve) => { releaseRemuxer = resolve; });
  const { pipeline } = build({
    mse,
    options: {
      remuxer: null,
      remuxerFactory: async () => remuxerReady,
    },
  });

  const initializing = pipeline.init();
  await new Promise((resolve) => setImmediate(resolve));
  releaseOpen();
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.destroy();
  releaseRemuxer(new FakeRemuxer());
  await initializing;

  assert.equal(addTrackCalls, 0);
  assert.equal(mse.appends.length, 0);
  assert.equal(pipeline._initialized, false);
  assert.equal(pipeline.state, 'destroyed');
});
test('init：addTrack 完成后 destroy 不再创建或写入 init segment', async () => {
  let releaseAddTrack;
  const addTrackReady = new Promise((resolve) => { releaseAddTrack = resolve; });
  const mse = new FakeMseHelper();
  const addTrack = mse.addTrack.bind(mse);
  mse.addTrack = async (...args) => {
    await addTrackReady;
    return addTrack(...args);
  };
  const { pipeline, remuxer } = build({ mse });
  const added = [];
  pipeline.on('trackAdded', (event) => added.push(event));

  const initializing = pipeline.init();
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.destroy();
  releaseAddTrack();
  await initializing;

  assert.deepEqual(remuxer.inits, []);
  assert.deepEqual(added, []);
  assert.equal(mse.appends.length, 0);
  assert.equal(pipeline._initialized, false);
  assert.equal(pipeline.state, 'destroyed');
});
test('init：destroy 发生在 setDuration 期间时不绑定监听或标记初始化完成', async () => {
  let releaseDuration;
  const durationReady = new Promise((resolve) => { releaseDuration = resolve; });
  const mse = new FakeMseHelper();
  mse.setDuration = async () => durationReady;
  const { pipeline, element } = build({ mse });

  const initializing = pipeline.init();
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.destroy();
  releaseDuration();
  await initializing;

  assert.equal(pipeline.state, 'destroyed');
  assert.equal(pipeline._initialized, false);
  assert.equal(element.listeners.size, 0);
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

test('seek：背压等待中的 flush 丢弃 seek 前媒体段', async () => {
  let waitCallback;
  let waiting = true;
  const mse = new FakeMseHelper();
  mse.bufferedAhead = () => (waiting ? 60 : 0);
  const { pipeline } = build({
    mse,
    options: {
      schedule: (fn) => {
        waitCallback = fn;
        return () => {};
      },
    },
  });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  const segments = [];
  pipeline.on('segment', (segment) => segments.push(segment));

  const flushing = pipeline.flush(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof waitCallback, 'function', 'flush 应停在背压等待');

  await pipeline.seek(2_000_000);
  waiting = false;
  waitCallback();
  assert.equal(await flushing, null);
  assert.equal(mse.appends.length, 2, 'seek 前媒体段不应追加');
  assert.equal(pipeline.counters.mediaSegments, 0);
  assert.deepEqual(segments, []);
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

test('end：seek 取消背压中的旧收尾，seek 后仍可追加新媒体段', async () => {
  let waitCallback;
  let waiting = true;
  const mse = new FakeMseHelper();
  mse.bufferedAhead = () => (waiting ? 60 : 0);
  const { pipeline } = build({
    mse,
    options: {
      schedule: (fn) => {
        waitCallback = fn;
        return () => {};
      },
    },
  });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));

  const eos = [];
  pipeline.on('eos', (event) => eos.push(event));
  const ending = pipeline.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof waitCallback, 'function', 'end 应停在背压等待');

  await pipeline.seek(2_000_000);
  waiting = false;
  waitCallback();
  await ending;

  assert.equal(mse.eos, 0, 'seek 后旧收尾不得 endOfStream');
  assert.deepEqual(eos, []);
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 2_000_000, duration: 100000, keyframe: true, data: new Uint8Array([2]),
  }));
  await pipeline.flush(1);
  assert.equal(mse.appends.length, 3, 'seek 后新媒体段仍可追加');
});

test('end：切轨取消旧收尾，切轨后新轨仍可追加媒体段', async () => {
  let waitCallback;
  let waiting = true;
  const mse = new FakeMseHelper();
  mse.bufferedAhead = () => (waiting ? 60 : 0);
  const { pipeline } = build({
    mse,
    mediaInfo: {
      ...avInfo,
      tracks: [
        ...avInfo.tracks,
        { id: 3, type: 'audio', codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      ],
    },
    options: {
      schedule: (fn) => {
        waitCallback = fn;
        return () => {};
      },
    },
  });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));

  const ending = pipeline.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof waitCallback, 'function', '旧轨 flush 应停在背压等待');

  await pipeline.selectTrack('audio', 3);
  waiting = false;
  waitCallback();
  await ending;

  assert.equal(mse.eos, 0, '切轨后旧收尾不得 endOfStream');
  await pipeline.pushSample(createSample({
    trackId: 3, codec: 'opus', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([2]),
  }));
  await pipeline.flush(3);
  assert.equal(mse.eos, 0);
  assert.equal(mse.appends.length, 4, '新轨 init 和媒体段均应追加');
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

test('selectTrack：未初始化时等待 init 完成后再切轨', async () => {
  let releaseOpen;
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const mse = new FakeMseHelper();
  mse.open = async () => openGate;
  const { pipeline, remuxer } = build({ mse, mediaInfo: multiTrackInfo });

  const switching = pipeline.selectTrack('audio', 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mse.tracks.size, 0, '切轨不能绕过进行中的初始化');

  releaseOpen();
  await switching;
  assert.equal(pipeline.active.audio, 3);
  assert.deepEqual(remuxer.inits, [1, 2, 3]);
});
test('selectTrack：并发请求按调用顺序串行完成', async () => {
  let releaseAppend;
  const appendReady = new Promise((resolve) => { releaseAppend = resolve; });
  const mse = new FakeMseHelper();
  const append = mse.append.bind(mse);
  mse.append = async (key, data) => {
    if (key === 'a3' && data[0] === 0xf0) await appendReady;
    return append(key, data);
  };
  const { pipeline } = build({ mse, mediaInfo: multiTrackInfo });
  await pipeline.init();

  const changes = [];
  pipeline.on('trackchange', (event) => changes.push(event.trackId));
  const first = pipeline.selectTrack('audio', 3);
  await new Promise((resolve) => setImmediate(resolve));
  const second = pipeline.selectTrack('audio', 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipeline.active.audio, 2);

  releaseAppend();
  await Promise.all([first, second]);
  assert.equal(pipeline.active.audio, 2);
  assert.deepEqual(changes, [3, 2]);
});

test('切轨目标轨初始化失败时不丢失背压中的旧轨 flush', async () => {
  let waitCallback;
  let waiting = true;
  let failInit = true;
  const tracks = new Map();
  const appends = [];
  const mse = {
    async open() {},
    async addTrack(key, mime) { tracks.set(key, { key, mime }); },
    async append(key, data) {
      if (key === 'a3' && failInit && data[0] === 0xf0) {
        failInit = false;
        throw new Error('target init append failed');
      }
      appends.push({ key, data });
    },
    bufferedAhead: () => (waiting ? 60 : 0),
    async endOfStream() {},
    destroy() {},
    tracks,
  };
  const remuxer = {
    createInitSegment(track) { return new Uint8Array([0xf0, track.id]); },
    createMediaSegment(track, samples) {
      return {
        data: new Uint8Array(samples.length),
        sequenceNumber: 0,
        sampleCount: samples.length,
        baseMediaDecodeTimeUs: samples[0].timestamp,
        durationUs: samples.reduce((sum, sample) => sum + (sample.duration ?? 0), 0),
      };
    },
  };
  const { pipeline } = build({
    mse,
    remuxer,
    mediaInfo: multiTrackInfo,
    options: {
      schedule: (fn) => {
        waitCallback = fn;
        return () => {};
      },
    },
  });
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 2,
    codec: 'mp4a.40.2',
    timestamp: 0,
    duration: 100000,
    keyframe: true,
    data: new Uint8Array([1]),
  }));
  const segments = [];
  pipeline.on('segment', (segment) => segments.push(segment));

  const flushing = pipeline.flush(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof waitCallback, 'function', '旧轨 flush 应停在背压等待');

  await assert.rejects(() => pipeline.selectTrack('audio', 3), /target init append failed/);
  assert.equal(pipeline.active.audio, 2);

  waiting = false;
  waitCallback();
  const segment = await flushing;
  assert.equal(segment.sampleCount, 1, '旧轨 flush 应在失败切轨后继续完成');
  assert.equal(pipeline.counters.mediaSegments, 1);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].trackId, 2);
  assert.equal(pipeline.active.audio, 2);
  assert.equal(pipeline._initializedTracks.has('a3'), false);
  assert.equal(appends.filter(({ key }) => key === 'a3').length, 0, '失败 init 不应留下目标轨媒体数据');
});

test('切轨初始化失败时保留旧轨状态，并允许重试新轨', async () => {
  const tracks = new Map();
  let failInit = true;
  const mse = {
    async open() {},
    async addTrack(key, mime) { tracks.set(key, { key, mime }); },
    async append(key, data) {
      if (key === 'a3' && failInit && data[0] === 0xf0) {
        failInit = false;
        throw new Error('init append failed');
      }
    },
    bufferedAhead: () => 0,
    async endOfStream() {},
    destroy() {},
    tracks,
  };
  const remuxer = {
    inits: [],
    createInitSegment(track) {
      this.inits.push(track.id);
      return new Uint8Array([0xf0, track.id]);
    },
    createMediaSegment(track, samples) {
      return { data: new Uint8Array(samples.length), sampleCount: samples.length };
    },
  };
  const pipeline = build({ mse, remuxer, mediaInfo: multiTrackInfo }).pipeline;
  await pipeline.init();
  await pipeline.pushSample(createSample({
    trackId: 2, codec: 'mp4a.40.2', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  const changes = [];
  pipeline.on('trackchange', (event) => changes.push(event));

  await assert.rejects(() => pipeline.selectTrack('audio', 3), /init append failed/);
  assert.equal(pipeline.active.audio, 2);
  const preserved = await pipeline.flush(2);
  assert.equal(preserved.sampleCount, 1, '失败后旧轨待封装样本仍被保留');
  assert.deepEqual(changes, []);

  await pipeline.selectTrack('audio', 3);
  assert.equal(pipeline.active.audio, 3);
  assert.deepEqual(remuxer.inits, [1, 2, 3, 3], '重试必须重新生成并写入新轨 init');
  assert.deepEqual(changes, [{ type: 'audio', trackId: 3, codec: 'mp4a.40.2' }]);
});
