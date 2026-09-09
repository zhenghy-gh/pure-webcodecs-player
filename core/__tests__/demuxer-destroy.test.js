import test from 'node:test';
import assert from 'node:assert/strict';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/** 生成器会被 `await gate()` 阻塞；不放开 gate，异步生成器 `return()` 无法退出 */
class BlockingDemuxer extends Demuxer {
  constructor(source) {
    super(source);
    this.gate = new Promise(() => {}); // never resolve
  }
  async _doOpen() {
    return {
      container: 'wav',
      tracks: [{ id: 1, type: 'audio', codec: 'pcm-s16', numberOfChannels: 2 }],
      durationUs: 1,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    const gate = this.gate;
    return (async function* () {
      for (let i = 0; i < 5; i++) {
        await gate; // 永不落地
        yield createSample({
          trackId: id,
          codec: 'pcm-s16',
          timestamp: i,
          duration: 1,
          keyframe: true,
          data: new Uint8Array(1),
          size: 1,
        });
      }
    })();
  }
  async _doSeek(t) { return { actualTimestampUs: t }; }
}

test('Demuxer.destroy：迭代器被永不 resolve 的 await 卡住时也能立即完成', async () => {
  const d = new BlockingDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  const inFlight = d.readSample(1);
  await new Promise((resolve) => setImmediate(resolve));
  const settled = await Promise.race([
    d.destroy().then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
  ]);
  assert.equal(settled, 'resolved', 'destroy() 在异步生成器被阻塞时不应挂起');
  assert.equal(d.state, 'destroyed');
  await assert.rejects(d.readSample(1), (e) => e.code === 'STATE_ERROR');
  void inFlight.catch(() => {});
});

test('Demuxer.destroy：幂等', async () => {
  const d = new BlockingDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  await Promise.race([
    (async () => {
      await d.destroy();
      await d.destroy();
      await d.destroy();
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('destroy 多次调用挂起')), 1000)),
  ]);
  assert.equal(d.state, 'destroyed');
  await assert.rejects(d.readSample(1), (e) => e.code === 'STATE_ERROR');
});

test('Player.destroy：阻塞迭代器场景下能在一秒内退出（与 Demuxer.destroy 解耦）', async () => {
  const { Player } = await import('../src/player.js');
  const d = new BlockingDemuxer(new MemoryDataSource(new Uint8Array([1])));
  const caps = { webcodecs: { supported: true, video: {}, audio: { 'pcm-s16': true } }, mse: { supported: false, mimeTypes: [] } };
  const p = new Player({
    demuxerFactory: () => d,
    capabilities: caps,
    pipelineFactory: async () => ({ async pushSample() {} }),
  });
  await p.load(new Uint8Array([1]));
  void p.play();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settled = await Promise.race([
    p.destroy().then(() => 'resolved'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Player.destroy 挂起')), 1500)),
  ]);
  assert.equal(settled, 'resolved');
  assert.equal(p.state, 'destroyed');
});
