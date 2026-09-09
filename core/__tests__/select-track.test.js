import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';
import { WebCodecsPipeline, webcodecsPipelineFactory } from '../src/pipeline-webcodecs.js';
import { MsePipeline } from '../src/pipeline-mse.js';

/** 假解码器：记录 configure/decode/close */
class FakeDecoder {
  constructor(init) {
    this.init = init;
    this.config = null;
    this.closed = false;
    this.decodeQueueSize = 0;
    this.chunks = [];
  }
  configure(config) { this.config = config; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() {}
  close() { this.closed = true; }
  emit(frame) { this.init.output(frame); }
}

class FakeAudioOutput {
  constructor(options) {
    this.sampleRate = options?.sampleRate ?? 48000;
    this.channelCount = options?.channelCount ?? 2;
    this.pushed = [];
    this.cleared = 0;
    this._us = 0;
  }
  async init() {}
  push(channels) { this.pushed.push(channels); }
  play() {}
  pause() {}
  clearBuffer() { this.cleared += 1; }
  setVolume() {}
  destroy() {}
  get currentTimeUs() { return this._us; }
}

const multiInfo = {
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

/** 每条轨产 N 个样本，并记录被拉取的 trackId */
class MultiTrackDemuxer extends Demuxer {
  constructor(source, log, perTrack = 2) {
    super(source);
    this.log = log;
    this.perTrack = perTrack;
  }
  async _doOpen() { return multiInfo; }
  _createTrackIterator(id) {
    const log = this.log;
    const perTrack = this.perTrack;
    return (async function* () {
      for (let i = 0; i < perTrack; i++) {
        log.push(id);
        yield createSample({
          trackId: id,
          codec: id === 1 ? 'avc1.42E01E' : 'mp4a.40.2',
          timestamp: i * 100000,
          duration: 100000,
          keyframe: true,
          data: new Uint8Array([id]),
          size: 1,
        });
      }
    })();
  }
}

test('Player.selectTrack：合法性与选中态维护', async () => {
  const log = [];
  const player = new Player({
    demuxerFactory: () => new MultiTrackDemuxer(new MemoryDataSource(new Uint8Array([1])), log),
    capabilities: { webcodecs: { supported: true, video: {}, audio: {} }, mse: { supported: false, mimeTypes: [] } },
    route: 'webcodecs',
    pipelineFactory: webcodecsPipelineFactory({
      videoDecoderFactory: (init) => new FakeDecoder(init),
      audioDecoderFactory: (init) => new FakeDecoder(init),
      audioOutputFactory: async () => new FakeAudioOutput(),
      schedule: (fn) => { fn(); return () => {}; },
    }),
  });
  await player.load(new Uint8Array([1]));
  assert.deepEqual(player.selectedTracks, { video: 1, audio: 2, text: null });

  await assert.rejects(() => player.selectTrack('audio', 99), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => player.selectTrack('subtitle', 2), (e) => e.code === 'STATE_ERROR');
  assert.equal(player.selectedTracks.audio, 2, '非法切轨不改变选中态');
  await player.destroy();
});

test('Player.selectTrack：切轨后样本泵只拉选中轨并广播 trackchange', async () => {
  const log = [];
  const player = new Player({
    demuxerFactory: () => new MultiTrackDemuxer(new MemoryDataSource(new Uint8Array([1])), log),
    capabilities: { webcodecs: { supported: true, video: {}, audio: {} }, mse: { supported: false, mimeTypes: [] } },
    route: 'webcodecs',
    pipelineFactory: webcodecsPipelineFactory({
      videoDecoderFactory: (init) => new FakeDecoder(init),
      audioDecoderFactory: (init) => new FakeDecoder(init),
      audioOutputFactory: async () => new FakeAudioOutput(),
      schedule: (fn) => { fn(); return () => {}; },
    }),
  });
  await player.load(new Uint8Array([1]));
  const changes = [];
  player.on('trackchange', (e) => changes.push(e));
  await player.selectTrack('audio', 3);
  assert.equal(player.selectedTracks.audio, 3);
  assert.deepEqual(changes, [{ type: 'audio', trackId: 3 }]);

  await player.play();
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(log.includes(1), '视频轨仍被拉取');
  assert.ok(log.includes(3), '新选中的音频轨被拉取');
  assert.equal(log.includes(2), false, '未选中的音频轨不再拉取');
  await player.destroy();
});

test('WebCodecs 管线：切视频轨重建解码器，非选中轨样本不解码', async () => {
  const info = {
    container: 'mkv',
    tracks: [
      { id: 1, type: 'video', codec: 'avc1.42E01E' },
      { id: 4, type: 'video', codec: 'vp09.00.10.08' },
      { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    ],
    durationUs: 1000000,
    seekable: true,
    live: false,
  };
  const videoDecoders = [];
  const audioDecoders = [];
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: info,
    player: null,
    options: {
      videoDecoderFactory: (init) => { const d = new FakeDecoder(init); videoDecoders.push(d); return d; },
      audioDecoderFactory: (init) => { const d = new FakeDecoder(init); audioDecoders.push(d); return d; },
      audioOutputFactory: async () => new FakeAudioOutput(),
      schedule: (fn) => { fn(); return () => {}; },
    },
  });
  await pipeline.init();
  assert.equal(videoDecoders[0].config.codec, 'avc1.42E01E');

  await pipeline.selectTrack('video', 4);
  assert.equal(videoDecoders[0].closed, true, '旧解码器已 close');
  assert.equal(videoDecoders.length, 2, '新轨新建解码器');
  assert.equal(videoDecoders[1].config.codec, 'vp09.00.10.08');

  await pipeline.pushSample(createSample({
    trackId: 1, codec: 'avc1.42E01E', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(videoDecoders[1].chunks.length, 0, '非选中视频轨样本被丢弃');
  await pipeline.pushSample(createSample({
    trackId: 4, codec: 'vp09.00.10.08', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(videoDecoders[1].chunks.length, 1, '选中视频轨正常进解码器');

  await assert.rejects(() => pipeline.selectTrack('video', 2), (e) => e.code === 'STATE_ERROR');
  void audioDecoders;
});

test('WebCodecs 管线：同格式切音频轨复用音频输出并清缓冲', async () => {
  const outputs = [];
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: multiInfo,
    player: null,
    options: {
      videoDecoderFactory: (init) => new FakeDecoder(init),
      audioDecoderFactory: (init) => new FakeDecoder(init),
      audioOutputFactory: async (o) => { const out = new FakeAudioOutput(o); outputs.push(out); return out; },
      schedule: (fn) => { fn(); return () => {}; },
    },
  });
  await pipeline.init();
  assert.equal(outputs.length, 1);
  await pipeline.selectTrack('audio', 3);
  assert.equal(outputs.length, 1, '采样率/声道一致时复用音频输出，不重建 Worklet');
  assert.equal(outputs[0].cleared, 1, '切轨清掉旧音轨缓冲');
  assert.deepEqual(pipeline.active, { video: 1, audio: 3, text: null });
});

test('MSE 管线：切音频轨新建 SourceBuffer 并补 init segment', async () => {
  const appends = [];
  const tracks = new Map();
  const mse = {
    async open() {},
    async addTrack(key, mime) { tracks.set(key, { key, mime }); },
    async append(key, data) { appends.push({ key, byteLength: data.byteLength }); },
    bufferedAhead: () => 0,
    async resetTrack() {},
    async endOfStream() {},
    destroy() {},
    tracks,
  };
  const remuxer = {
    inits: [],
    createInitSegment(track) { this.inits.push(track.id); return new Uint8Array([0xf0, track.id]); },
    createMediaSegment(track, samples) {
      return { data: new Uint8Array(samples.length), sequenceNumber: 0, sampleCount: samples.length, baseMediaDecodeTimeUs: 0, durationUs: 0 };
    },
  };
  const pipeline = new MsePipeline({
    route: 'mse',
    mediaInfo: multiInfo,
    player: null,
    options: {
      mediaElement: { currentTime: 0, play() {}, pause() {} },
      mse,
      remuxer,
      schedule: (fn) => { fn(); return () => {}; },
      segmentDurationUs: 1_000_000,
    },
  });
  await pipeline.init();
  assert.deepEqual([...tracks.keys()], ['v1', 'a2']);

  await pipeline.pushSample(createSample({
    trackId: 2, codec: 'mp4a.40.2', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  await pipeline.selectTrack('audio', 3);
  assert.deepEqual([...tracks.keys()], ['v1', 'a2', 'a3'], '新轨源缓冲已建立');
  assert.equal(tracks.get('a3').mime, 'audio/mp4; codecs="mp4a.40.2"');
  assert.ok(remuxer.inits.includes(3), '新轨补写 init segment');
  assert.equal(await pipeline.flush(2), null, '旧轨待封装样本已丢弃');

  const before = appends.length;
  await pipeline.pushSample(createSample({
    trackId: 2, codec: 'mp4a.40.2', timestamp: 0, duration: 100000, keyframe: true, data: new Uint8Array([1]),
  }));
  assert.equal(appends.length, before, '非选中音频轨样本不再成段');
  await assert.rejects(() => pipeline.selectTrack('audio', 1), (e) => e.code === 'STATE_ERROR');
});
