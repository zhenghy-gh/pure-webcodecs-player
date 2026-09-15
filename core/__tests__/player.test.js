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

test('load/destroy 并发：迟到的 demuxer 被销毁且不创建管线', async () => {
  let resolveOpen;
  let demuxer;
  let pipelineCreated = false;
  const open = new Promise((resolve) => { resolveOpen = resolve; });
  demuxer = {
    open: async () => open,
    destroy: async () => { demuxer.destroyed = true; },
  };
  const p = new Player({
    demuxerFactory: async () => demuxer,
    pipelineFactory: async () => { pipelineCreated = true; return {}; },
  });
  const loading = p.load(new Uint8Array([1]));
  await new Promise((resolve) => setImmediate(resolve));
  await p.destroy();
  resolveOpen({ container: 'wav', tracks: [], durationUs: 0, seekable: true, live: false });
  await assert.rejects(() => loading, (e) => e.code === 'ABORTED');
  assert.equal(demuxer.destroyed, true);
  assert.equal(pipelineCreated, false);
  assert.equal(p.state, 'destroyed');
});
test('load 失败进入 error 并以 PlayerError 拒绝', async () => {
  const p = new Player({ demuxerFactory: async () => { throw new Error('bad source'); } });
  await assert.rejects(() => p.load(new Uint8Array([1])), (e) => e.name === 'PlayerError' && e.code === 'SOURCE_ERROR');
  assert.equal(p.state, 'error');
});

test('管线 error 进入播放器 error 态并转发 PlayerError', async () => {
  let pipeline;
  const p = new Player({
    demuxerFactory: factory,
    capabilities: caps,
    pipelineFactory: async () => {
      pipeline = {
        on(event, fn) { if (event === 'error') this.errorHandler = fn; return () => {}; },
        pushSample() {},
      };
      return pipeline;
    },
  });
  const errors = [];
  p.on('error', (error) => errors.push(error));
  await p.load(new Uint8Array([1]));
  pipeline.errorHandler(new Error('decoder failed'));
  assert.equal(p.state, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'SOURCE_ERROR');
  assert.match(errors[0].message, /播放管线失败/);
});

test('解复用器打开失败时清理已创建的解复用器', async () => {
  let demuxer;
  const p = new Player({
    demuxerFactory: () => {
      demuxer = {
        open: async () => { throw new Error('demux open failed'); },
        destroy: async () => { demuxer.destroyedByPlayer = true; },
      };
      return demuxer;
    },
  });
  await assert.rejects(() => p.load(new Uint8Array([1])), (error) => error.name === 'PlayerError' && error.code === 'SOURCE_ERROR');
  assert.equal(p.state, 'error');
  assert.equal(demuxer.destroyedByPlayer, true);
  assert.equal(p.pipeline, null);
  assert.equal(p.demuxer, null);
});
