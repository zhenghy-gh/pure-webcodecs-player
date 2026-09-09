import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, createPlayer } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

class ToyPlayerDemuxer extends Demuxer {
  async _doOpen() {
    return { container: 'wav', tracks: [{ id: 1, type: 'audio', codec: 'pcm-s16', numberOfChannels: 2 }], durationUs: 200000, seekable: true, live: false };
  }
  _createTrackIterator(id) {
    const source = this.source;
    return (async function* () {
      for (let i = 0; i < 2; i++) yield createSample({ trackId: id, codec: 'pcm-s16', timestamp: i * 100000, duration: 100000, keyframe: true, data: await source.read(0, 1), size: 1 });
    })();
  }
  async _doSeek(timestampUs) { return { actualTimestampUs: Math.min(timestampUs, 100000) }; }
}

function factory() { return new ToyPlayerDemuxer(new MemoryDataSource(new Uint8Array([1]))); }
const caps = { webcodecs: { supported: true, video: {}, audio: { 'pcm-s16': true } }, mse: { supported: false, mimeTypes: [] } };

test('createPlayer/load：接入 demuxer、路线和轨道事件', async () => {
  const p = await createPlayer({ demuxerFactory: factory, capabilities: caps, pipelineFactory: async () => ({ pushSample() {} }) });
  let states = [];
  let tracks = null;
  p.on('statechange', (s) => states.push(s));
  p.on('trackschange', (e) => (tracks = e.tracks));
  assert.equal(await p.load(new Uint8Array([1])), p);
  assert.equal(p.state, 'ready');
  assert.equal(p.route, 'webcodecs');
  assert.equal(tracks[0].codec, 'pcm-s16');
  assert.deepEqual(states, ['ready']);
});

test('play/pause/pump：样本消费、统计和自然结束', async () => {
  const p = new Player({ demuxerFactory: factory, capabilities: caps, pipelineFactory: async () => ({ pushSample() {} }) });
  await p.load(new Uint8Array([1]));
  let ended = 0;
  p.on('ended', () => ended++);
  await p.play();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.ended, true);
  assert.equal(p.state, 'paused');
  assert.equal(ended, 1);
  assert.equal(p.stats.samplesDecoded, 2);
  p.pause();
});

test('seek：恢复来源状态并返回实际落点', async () => {
  const p = new Player({ demuxerFactory: factory, capabilities: caps, pipelineFactory: async () => ({ pushSample() {} }) });
  await p.load(new Uint8Array([1]));
  assert.deepEqual(await p.seek(180000), { actualTimestampUs: 100000 });
  assert.equal(p.state, 'ready');
  await p.destroy();
  assert.equal(p.state, 'destroyed');
  await assert.rejects(() => p.load(new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
});

test('load 失败进入 error 并以 PlayerError 拒绝', async () => {
  const p = new Player({ demuxerFactory: async () => { throw new Error('bad source'); } });
  await assert.rejects(() => p.load(new Uint8Array([1])), (e) => e.name === 'PlayerError' && e.code === 'SOURCE_ERROR');
  assert.equal(p.state, 'error');
});
