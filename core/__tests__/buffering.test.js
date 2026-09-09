import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

const caps = { webcodecs: { supported: true, video: {}, audio: { 'pcm-s16': true } }, mse: { supported: false, mimeTypes: [] } };

/** 可控样本流：可设样本数、时间步长、读取闸门、以及是否自带缓冲区间 */
class SpanDemuxer extends Demuxer {
  constructor(source, options = {}) {
    super(source, options);
    this.count = options.count ?? 10;
    this.stepUs = options.stepUs ?? 500_000;
    this.gate = options.gate ?? null;
    this.ranges = options.ranges ?? null;
    this.emitted = 0;
  }
  async _doOpen() {
    return {
      container: 'wav',
      tracks: [{ id: 1, type: 'audio', codec: 'pcm-s16', numberOfChannels: 2 }],
      durationUs: this.count * this.stepUs,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    const self = this;
    return (async function* () {
      for (let i = 0; i < self.count; i++) {
        if (self.gate) await self.gate();
        self.emitted += 1;
        yield createSample({
          trackId: id,
          codec: 'pcm-s16',
          timestamp: i * self.stepUs,
          duration: self.stepUs,
          keyframe: true,
          data: new Uint8Array(64),
          size: 64,
        });
      }
    })();
  }
  getBufferedRanges() { return this.ranges; }
  async _doSeek(timestampUs) { return { actualTimestampUs: timestampUs }; }
}

function source() { return new MemoryDataSource(new Uint8Array([1])); }

async function drain(p, expected, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    if (expected()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return expected();
}

test('起播前向缓冲：灌到 bufferTargetUs 才进入常规泵，并发出 buffering 事件对', async () => {
  const pushed = [];
  const buffering = [];
  const p = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 10, stepUs: 500_000 }),
    capabilities: caps,
    bufferTargetUs: 3_000_000,
    pipelineFactory: async () => ({ async pushSample(s) { pushed.push(s); } }),
  });
  p.on('buffering', (e) => buffering.push(e.active));
  await p.load(new Uint8Array([1]));
  await p.play();
  // 0/0.5/.../3.0s 共 7 个样本即满足 3s 水位（允许泵已多跑几个）
  assert.ok(pushed.length >= 6, `预缓冲样本数应达到水位，实际 ${pushed.length}`);
  assert.deepEqual(buffering.slice(0, 2), [true, false]);
  assert.equal(p.state, 'playing');
  assert.ok(await drain(p, () => pushed.length === 10));
  assert.equal(p.ended, true);
});

test('起播前向缓冲：短流遇 EOS 立即起播，不因水位不足挂死', async () => {
  const pushed = [];
  const p = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 2, stepUs: 100_000 }),
    capabilities: caps,
    bufferTargetUs: 60_000_000,
    pipelineFactory: async () => ({ async pushSample(s) { pushed.push(s); } }),
  });
  await p.load(new Uint8Array([1]));
  await Promise.race([
    p.play(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('prebuffer hang')), 3000)),
  ]);
  assert.ok(await drain(p, () => pushed.length === 2));
  assert.equal(p.ended, true);
});

test('起播前向缓冲：时间戳不推进时由 prebufferMaxSamples 兜底，不死循环', async () => {
  const pushed = [];
  const p = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 200, stepUs: 1 }),
    capabilities: caps,
    bufferTargetUs: 3_000_000,
    prebufferMaxSamples: 64,
    pipelineFactory: async () => ({ async pushSample(s) { pushed.push(s); } }),
  });
  await p.load(new Uint8Array([1]));
  await Promise.race([
    p.play(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('prebuffer hang')), 3000)),
  ]);
  assert.ok(pushed.length >= 64, `应达到预缓冲上限，实际 ${pushed.length}`);
  assert.ok(await drain(p, () => pushed.length === 200, 2000));
});

test('播放中 destroy：样本泵被 token 中断，不再继续灌样本', async () => {
  const pushed = [];
  // 非阻塞生成器（不挂外部 promise），避免异步生成器被 await 卡住时 destroy 无法中断
  const demuxer = new SpanDemuxer(source(), { count: 500, stepUs: 1 });
  const p = new Player({
    demuxerFactory: () => demuxer,
    capabilities: caps,
    bufferTargetUs: 3_000_000,
    prebufferMaxSamples: 8,
    pipelineFactory: async () => ({ async pushSample(s) { pushed.push(s); } }),
  });
  await p.load(new Uint8Array([1]));
  const playing = p.play();
  await new Promise((resolve) => setImmediate(resolve));
  const before = pushed.length;
  await p.destroy();
  await Promise.race([
    playing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('play() 未随 destroy 退出')), 2000)),
  ]);
  assert.equal(p.state, 'destroyed');
  await new Promise((resolve) => setImmediate(resolve));
  const afterDestroy = pushed.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pushed.length, afterDestroy, `销毁后不应继续灌样本（销毁前 ${before}，销毁后 ${afterDestroy}）`);
});

test('背压：管线水位超阈值时暂停拉流，回落后续跑', async () => {
  let aheadUs = 10_000_000;
  const pushed = [];
  const p = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 6, stepUs: 500_000 }),
    capabilities: caps,
    bufferTargetUs: 1_000_000,
    backpressureFactor: 2,
    backpressurePollMs: 5,
    pipelineFactory: async () => ({
      get bufferedAheadUs() { return aheadUs; },
      async pushSample(s) { pushed.push(s); },
    }),
  });
  await p.load(new Uint8Array([1]));
  void p.play();
  await new Promise((resolve) => setTimeout(resolve, 40));
  // 首帧已灌入，但水位仍高 → 泵暂停，不应继续拉到尾
  assert.ok(pushed.length >= 1 && pushed.length < 6, `水位过高时应停泵，实际 ${pushed.length}`);
  aheadUs = 0;
  assert.ok(await drain(p, () => pushed.length === 6, 500));
  assert.equal(p.ended, true);
});

test('stats.bitrateBps：按滑动窗口统计，不再恒为 0', async () => {
  const p = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 10, stepUs: 100_000 }),
    capabilities: caps,
    bufferTargetUs: 0,
    pipelineFactory: async () => ({ async pushSample() {} }),
  });
  await p.load(new Uint8Array([1]));
  assert.equal(p.stats.bitrateBps, 0);
  await p.play();
  await drain(p, () => p.stats.samplesDecoded === 10);
  assert.ok(p.stats.bitrateBps > 0, `码率应大于 0，实际 ${p.stats.bitrateBps}`);
  assert.equal(p.stats.droppedFrames, 0);
  assert.equal(typeof p.stats.decodedFps, 'number');
});

test('buffered：demuxer 区间优先，缺失时回落到管线区间/水位', async () => {
  const ranges = [{ startUs: 0, endUs: 2_000_000 }];
  const fromDemuxer = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 1, ranges }),
    capabilities: caps,
    bufferTargetUs: 0,
    pipelineFactory: async () => ({ async pushSample() {}, getBufferedRanges: () => [{ startUs: 9, endUs: 9 }] }),
  });
  await fromDemuxer.load(new Uint8Array([1]));
  assert.deepEqual(fromDemuxer.buffered, ranges);

  const fromPipeline = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 1 }),
    capabilities: caps,
    bufferTargetUs: 0,
    pipelineFactory: async () => ({
      async pushSample() {},
      getBufferedRanges: () => [{ startUs: 1_000_000, endUs: 4_000_000 }],
    }),
  });
  await fromPipeline.load(new Uint8Array([1]));
  assert.deepEqual(fromPipeline.buffered, [{ startUs: 1_000_000, endUs: 4_000_000 }]);

  const fromAhead = new Player({
    demuxerFactory: () => new SpanDemuxer(source(), { count: 1 }),
    capabilities: caps,
    bufferTargetUs: 0,
    pipelineFactory: async () => ({
      async pushSample() {},
      currentTimeUs: 2_000_000,
      bufferedAheadUs: 3_000_000,
    }),
  });
  await fromAhead.load(new Uint8Array([1]));
  assert.deepEqual(fromAhead.buffered, [{ startUs: 2_000_000, endUs: 5_000_000 }]);
});

test('progress 事件链路：demuxer 的读取进度透传到 Player', async () => {
  const demuxer = new SpanDemuxer(source(), { count: 1 });
  const p = new Player({
    demuxerFactory: () => demuxer,
    capabilities: caps,
    bufferTargetUs: 0,
    pipelineFactory: async () => ({ async pushSample() {} }),
  });
  await p.load(new Uint8Array([1]));
  const seen = [];
  p.on('progress', (payload) => seen.push(payload));
  demuxer.emit('progress', { loadedBytes: 1024, totalBytes: 4096 });
  assert.deepEqual(seen, [{ loadedBytes: 1024, totalBytes: 4096 }]);
});
