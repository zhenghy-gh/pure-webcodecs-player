import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';
import { createSample } from '../src/types.js';

/** 假解码器：记录 decode，decode 后不自动出帧，由测试手动 emit */
class FakeDecoder {
  constructor(init) {
    this.init = init;
    this.decodeQueueSize = 0;
    this.chunks = [];
  }
  configure() {}
  decode(chunk) { this.chunks.push(chunk); }
  reset() {}
  close() {}
  emit(frame) { this.init.output(frame); }
}

class FakeFrame {
  constructor(timestamp) { this.timestamp = timestamp; }
  close() {}
}

class FakeRenderer {
  constructor() { this.drawn = []; }
  draw(frame) { this.drawn.push(frame.timestamp); frame.close(); }
}

const liveInfo = {
  container: 'mkv',
  live: true,
  seekable: false,
  durationUs: 0,
  tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }],
};

function buildLive(options = {}) {
  const videoDecoder = new FakeDecoder({ output: () => {}, error: () => {} });
  const renderer = new FakeRenderer();
  const events = [];
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: liveInfo,
    player: null,
    options: {
      videoDecoderFactory: (init) => { videoDecoder.init = init; return videoDecoder; },
      audioDecoderFactory: null,
      schedule: (fn) => { fn(); return () => {}; }, // 立即执行，不留真实定时器
      now: () => options.nowSec ?? 0,
      liveLatencyUs: options.liveLatencyUs ?? 2_000_000,
      catchUpThresholdUs: options.catchUpThresholdUs,
    },
  });
  pipeline.renderer = renderer;
  pipeline.on('catchup', (e) => events.push(e));
  return { pipeline, videoDecoder, renderer, events };
}

async function pumpSamples(pipeline, fromUs = 0, stepUs = 1_000_000, count = 11) {
  for (let i = 0; i < count; i++) {
    await pipeline.pushSample(createSample({
      trackId: 1,
      codec: 'avc1.42E01E',
      timestamp: fromUs + i * stepUs,
      keyframe: true,
      data: new Uint8Array([1]),
    }));
  }
}

test('直播落后：落后超过阈值时重锚主钟到 live 边缘并丢旧帧', async () => {
  const { pipeline, videoDecoder, renderer, events } = buildLive({
    liveLatencyUs: 2_000_000,
    catchUpThresholdUs: 1_000_000,
  });
  await pipeline.init();
  pipeline.play();
  // live edge = 10s；目标播放位置 = 10s - 2s = 8s
  await pumpSamples(pipeline);
  for (let i = 0; i <= 10; i++) videoDecoder.emit(new FakeFrame(i * 1_000_000));

  assert.equal(events.length, 1, '落后 8s > 阈值 1s 应触发一次追赶');
  assert.equal(events[0].toUs, 8_000_000);
  assert.equal(events[0].reanchored, true);
  assert.equal(pipeline.counters.catchups, 1);
  // 0..7s 被当作旧帧丢弃；首帧渲染从追赶落点 8s 开始
  assert.equal(pipeline.counters.framesDropped, 8);
  assert.equal(renderer.drawn[0], 8_000_000);
  // frozen 主钟下 9s/10s 帧相对 8s 超前 ≥hardResyncSec，会再触发「主钟重锚到超前帧」→ 也渲染
  assert.ok(renderer.drawn.length >= 1);
});

test('直播落后：落后未超阈值时不做追赶（阈值守卫）', async () => {
  const { pipeline, videoDecoder, renderer, events } = buildLive({
    liveLatencyUs: 2_000_000,
    catchUpThresholdUs: 20_000_000, // 落后 8s < 20s → 不追赶
  });
  await pipeline.init();
  pipeline.play();
  await pumpSamples(pipeline);
  for (let i = 0; i <= 10; i++) videoDecoder.emit(new FakeFrame(i * 1_000_000));

  assert.equal(events.length, 0);
  assert.equal(pipeline.counters.catchups, 0);
  assert.equal(pipeline.counters.framesDropped, 0);
  assert.equal(renderer.drawn.length, 11, '主钟冻结于起点，全部帧按原速渲染');
});

test('点播（live=false）即使配置 liveLatencyUs 也不触发追赶', async () => {
  const { pipeline, videoDecoder, renderer, events } = buildLive({
    liveLatencyUs: 2_000_000,
    catchUpThresholdUs: 1_000_000,
  });
  pipeline.mediaInfo = { ...liveInfo, live: false };
  await pipeline.init();
  pipeline.play();
  await pumpSamples(pipeline);
  for (let i = 0; i <= 10; i++) videoDecoder.emit(new FakeFrame(i * 1_000_000));
  assert.equal(events.length, 0);
  assert.equal(pipeline.counters.catchups, 0);
  assert.equal(renderer.drawn.length, 11);
});

test('seek/切轨后 live edge 重置：不拿旧边缘触发追赶', async () => {
  const { pipeline, videoDecoder, renderer, events } = buildLive({
    liveLatencyUs: 2_000_000,
    catchUpThresholdUs: 1_000_000,
  });
  await pipeline.init();
  pipeline.play();
  await pumpSamples(pipeline);
  assert.equal(pipeline._liveEdgeUs, 10_000_000);
  pipeline.seek(2_000_000);
  assert.equal(pipeline._liveEdgeUs, -1, 'seek 后按新时间轴重新累计 live edge');
  pipeline.selectTrack('video', 1).catch(() => {});
  assert.equal(pipeline._liveEdgeUs, -1);
});
