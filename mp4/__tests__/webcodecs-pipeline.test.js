import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoConfig, buildAudioConfig, Mp4WebCodecsPipeline } from '../src/webcodecs-pipeline.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import {
  buildProgressiveVideoFixture,
  buildFragmentedFixture,
  makeAscFixture,
} from './fixtures.js';

function makeTrack(partial) {
  return { id: 1, type: 'video', codec: '', codecPrivate: null, sampleEntryType: '', timescale: 1000, duration: 0, language: 'und', ...partial };
}

test('buildVideoConfig：纯函数构造（Node 无 WebCodecs 也可测）', () => {
  const cfg = buildVideoConfig(makeTrack({
    type: 'video',
    codec: 'avc1.42001E',
    codecPrivate: new Uint8Array([1, 66, 0, 30]),
    width: 320,
    height: 240,
  }));
  assert.equal(cfg.codec, 'avc1.42001E');
  assert.equal(cfg.width, 320);
  assert.equal(cfg.height, 240);
  assert.ok(cfg.description instanceof Uint8Array);

  assert.throws(() => buildVideoConfig({ type: 'video' }), /codec/);
  assert.throws(() => buildVideoConfig({ type: 'audio' }), TypeError);
});

test('buildAudioConfig：AAC 配置带 AudioSpecificConfig', () => {
  const asc = makeAscFixture();
  const cfg = buildAudioConfig(makeTrack({
    type: 'audio',
    codec: 'mp4a.40.2',
    codecPrivate: asc,
    sampleRate: 44100,
    channelCount: 2,
  }));
  assert.equal(cfg.codec, 'mp4a.40.2');
  assert.equal(cfg.sampleRate, 44100);
  assert.equal(cfg.numberOfChannels, 2);
  assert.deepEqual([...cfg.description], [...asc]);
});

test('Node 环境无 WebCodecs：管线构造抛 STATE_ERROR', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  assert.throws(
    () => new Mp4WebCodecsPipeline(d, {}),
    (e) => e.code === 'STATE_ERROR',
  );
});
