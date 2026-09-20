/**
 * webcodecs-pipeline-gaps.test.js —— mp4 WebCodecs 管线残余分支补测（wave 162）
 *
 * 覆盖：
 *   - _ensureDecoders：supported() 判双不支持 → 抛 decodeError（99-100）；
 *   - 音频解码器 output/error 回调接线（117-118 / 121-122）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Mp4WebCodecsPipeline } from '../src/webcodecs-pipeline.js';

async function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

class FakeDecoder {
  static supported = true;
  static async isConfigSupported() {
    return { supported: this.supported };
  }
  constructor(init) {
    this.init = init;
    this.configured = null;
    this.chunks = [];
    this.flushes = 0;
  }
  configure(c) { this.configured = c; }
  decode(chunk) { this.chunks.push(chunk); }
  async flush() { this.flushes += 1; }
  reset() {}
  close() {}
}
class FakeChunk { constructor(init) { this.init = init; } }

function fakeDemuxer(tracks, samplesByTrack) {
  return {
    getMediaInfo: () => ({ container: 'mp4', tracks, durationUs: 0, seekable: false, live: false }),
    samples(trackId) {
      return (async function* () {
        for (const s of samplesByTrack[trackId] ?? []) yield s;
      })();
    },
    async readSampleData(sample) { sample.data = new Uint8Array([1]); return sample.data; },
  };
}

const A_TRACK = { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 44100, channelCount: 2 };
const V_TRACK = { id: 1, type: 'video', codec: 'avc1.42001E' };
const GLOBALS = {
  VideoDecoder: FakeDecoder, AudioDecoder: FakeDecoder,
  EncodedVideoChunk: FakeChunk, EncodedAudioChunk: FakeChunk,
};

test('_ensureDecoders：双配置不支持 → start 拒绝 decodeError（99-100）', async () => {
  const demuxer = fakeDemuxer([V_TRACK, A_TRACK], {});
  await withGlobals(GLOBALS, async () => {
    FakeDecoder.supported = false;
    try {
      const pipeline = new Mp4WebCodecsPipeline(demuxer, {});
      await assert.rejects(
        () => pipeline.start(),
        (e) => e.code === 'DECODE_ERROR' && /decoder unsupported: configs unsupported/.test(e.message),
      );
      assert.equal(pipeline.videoDecoder, null, '不支持时不建解码器');
    } finally {
      FakeDecoder.supported = true;
    }
  });
});

test('音频解码器回调：output → stats+onAudioData；error → stats+onError（117-122）', async () => {
  const demuxer = fakeDemuxer(
    [A_TRACK],
    { 2: [{ index: 0, trackId: 2, timestamp: 0, duration: 23219, size: 8, keyframe: true, data: new Uint8Array(8) }] },
  );
  const stats = { decoded: 0, decodeErrors: [], markDemuxed() {}, markSampleDecoded() { this.decoded += 1; }, markDecodeError(e) { this.decodeErrors.push(e); } };
  const audioDataEvents = [];
  const errors = [];
  await withGlobals(GLOBALS, async () => {
    const pipeline = new Mp4WebCodecsPipeline(demuxer, {
      stats,
      onAudioData: (data, meta) => audioDataEvents.push([data, meta]),
      onError: (e) => errors.push(e),
    });
    await pipeline.start();

    const ad = pipeline.audioDecoder;
    ad.init.output('audio-data-x');
    assert.deepEqual(audioDataEvents, [['audio-data-x', { decoder: 'audio' }]]);
    assert.equal(stats.decoded, 1);

    const err = new Error('audio decode boom');
    ad.init.error(err);
    assert.deepEqual(errors, [err]);
    assert.deepEqual(stats.decodeErrors, [err]);

    await pipeline.close();
  });
});
