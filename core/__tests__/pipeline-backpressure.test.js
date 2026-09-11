/**
 * core-pipeline 背压（_waitQueue）行为固化
 *
 * 覆盖此前零测试的背压路径：解码队列超过 maxDecodeQueue 时让出事件循环，
 * 以及 guard 上限（64 次）耗尽后放弃等待的行为。
 *
 * 注意：本项目踩坑记录——本文件用 schedule 注入可控调度器，
 * 不依赖真实 setTimeout 以免在 --test-concurrency 下被 macrotask 饥饿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCodecsPipeline, webcodecsPipelineFactory } from '../src/pipeline-webcodecs.js';
import { Player } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/** 假解码器：decodeQueueSize 可手动设置，用于构造背压场景 */
class QueueDecoder {
  constructor(init) {
    this.init = init;
    this.closed = false;
    this.chunks = [];
    this.decodeQueueSize = 0;
  }
  configure() {}
  decode(chunk) {
    this.chunks.push(chunk);
  }
  reset() {}
  close() {
    this.closed = true;
  }
}

class NullRenderer {
  draw(frame) {
    frame?.close?.();
  }
  destroy() {}
}

class NullAudioOutput {
  async init() {}
  push() {}
  play() {}
  pause() {}
  clearBuffer() {}
  setVolume() {}
  destroy() {}
  get currentTimeUs() {
    return 0;
  }
}

/** 单视频轨 toy demuxer（有界，便于管线跑通） */
class ToyVideoDemuxer extends Demuxer {
  async _doOpen() {
    return {
      container: 'toy',
      tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', width: 64, height: 64 }],
      durationUs: 1_000_000,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    return (async function* () {
      yield createSample({
        trackId: id,
        timestamp: 0,
        duration: 100_000,
        keyframe: true,
        data: new Uint8Array([1]),
        size: 1,
      });
    })();
  }
}

/**
 * 构造一个直接可用的管线（不经 Player），用于精确单测 _waitQueue。
 *
 * 重要：`_waitQueue` 的 while 条件对 decodeQueueSize 会**读取两次**
 * （一次 typeof 判断、一次数值比较），因此桩不能按「每次读取」推进，
 * 而要按「每轮等待」推进——否则一次迭代内就拿到下一个值，背压永不触发。
 * 这里用 `setQueue` 手动控制当前队列长度，最贴近真实解码器的语义。
 */
function makePipelineWithQueue(cfg) {
  const decoder = new QueueDecoder({ output: () => {}, error: () => {} });
  let current = cfg.initial ?? 8;
  Object.defineProperty(decoder, 'decodeQueueSize', {
    get() {
      return current;
    },
  });

  const scheduled = [];
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: {
      container: 'toy',
      tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E', width: 64, height: 64 }],
      durationUs: 1_000_000,
      seekable: true,
      live: false,
    },
    player: null,
    options: {
      maxDecodeQueue: cfg.limit ?? 8,
      videoDecoderFactory: () => decoder,
      audioDecoderFactory: () => new QueueDecoder({ output: () => {}, error: () => {} }),
      audioOutputFactory: async () => new NullAudioOutput(),
      rendererFactory: () => new NullRenderer(),
      // 受控调度：记录回调而不真正异步，由测试手动 flush
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => {};
      },
    },
  });

  return {
    pipeline,
    decoder,
    scheduled,
    setQueue(n) {
      current = n;
    },
    /** 依次执行已排队的调度回调 */
    async flushScheduled() {
      while (scheduled.length) {
        const { fn } = scheduled.shift();
        fn();
        await Promise.resolve();
      }
    },
  };
}

/* --------------------------- 基础：未达上限不等待 --------------------------- */

test('背压：队列长度低于上限时不调度等待，直接通过', async () => {
  const { pipeline, decoder, scheduled } = makePipelineWithQueue({ initial: 0, limit: 8 });
  await pipeline._waitQueue(decoder);
  assert.equal(scheduled.length, 0, '未触发背压，不应有调度');
});

test('背压：decodeQueueSize 非数值（假实现无该属性）时直接通过', async () => {
  const { pipeline, scheduled } = makePipelineWithQueue({ initial: 0 });
  await pipeline._waitQueue({}); // 无 decodeQueueSize → typeof 非 number
  assert.equal(scheduled.length, 0, '非数值队列长度应视为无背压');
});

/* --------------------------- 主体：达上限则让出循环 --------------------------- */

test('背压：达到上限时调度等待，队列回落后放行', async () => {
  const { pipeline, decoder, scheduled, setQueue } = makePipelineWithQueue({ initial: 8, limit: 8 });
  let resolved = false;
  const p = pipeline._waitQueue(decoder).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(scheduled.length, 1, '队列满 → 应调度一次等待');
  assert.equal(resolved, false, '尚未放行');

  // 队列回落后执行等待回调 → 重新查询得 0 < 8 → 退出
  setQueue(0);
  scheduled.shift().fn();
  await p;
  assert.equal(resolved, true, '队列回落后放行');
});

test('背压：队列回落后仍需完整走完本轮等待（单次等待即可放行）', async () => {
  const { pipeline, decoder, scheduled, setQueue } = makePipelineWithQueue({ initial: 9, limit: 8 });
  const p = pipeline._waitQueue(decoder);
  await Promise.resolve();
  assert.equal(scheduled.length, 1, '仅调度一次等待');
  setQueue(7);
  scheduled.shift().fn();
  await p; // 不挂起即证明放行
  assert.equal(scheduled.length, 0, '无多余调度');
});

test('背压：默认上限为 8（options 未提供 maxDecodeQueue）', async () => {
  const decoder = new QueueDecoder({ output: () => {}, error: () => {} });
  let q = 7;
  Object.defineProperty(decoder, 'decodeQueueSize', { get: () => q });
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: { container: 'toy', tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }], durationUs: 1, seekable: true, live: false },
    player: null,
    options: { schedule: (fn) => { fn(); return () => {}; } },
  });
  // 7 < 8 不等待
  let scheduledCount = 0;
  const origSchedule = pipeline._schedule;
  pipeline._schedule = (fn, ms) => {
    scheduledCount += 1;
    return origSchedule(fn, ms);
  };
  await pipeline._waitQueue(decoder);
  assert.equal(scheduledCount, 0, '7 < 默认上限 8 → 不等待');
  q = 8;
  await pipeline._waitQueue(decoder);
  assert.ok(scheduledCount >= 1, '8 >= 默认上限 8 → 触发等待');
});

/* --------------------------- guard 上限：64 次耗尽后放弃 --------------------------- */

test('背压：队列持续满时 guard 上限 64 次后放弃等待（不永久挂起）', async () => {
  // 队列恒为 999（永不回落）→ 应当调度 64 次后跳出
  const { pipeline, decoder, scheduled } = makePipelineWithQueue({ initial: 999, limit: 8 });
  let done = false;
  const p = pipeline._waitQueue(decoder).then(() => {
    done = true;
  });
  // 反复冲刷受控调度器直至 promise 完成
  let loops = 0;
  while (!done && loops < 200) {
    loops += 1;
    await Promise.resolve();
    if (scheduled.length) {
      const { fn } = scheduled.shift();
      fn();
    }
  }
  await p;
  assert.equal(done, true, 'guard 耗尽后必须返回，不能永久挂起');
  assert.ok(loops < 200, '未陷入死循环');
  assert.equal(scheduled.length, 0, '所有调度已消费');
});

test('背压：guard 上限耗尽时统计调度次数恰为 64', async () => {
  const { pipeline, decoder } = makePipelineWithQueue({ initial: 999, limit: 8 });
  let schedules = 0;
  pipeline._schedule = (fn) => {
    schedules += 1;
    fn();
    return () => {};
  };
  await pipeline._waitQueue(decoder);
  assert.equal(schedules, 64, 'guard 硬上限为 64 次等待');
});

/* --------------------------- 集成：pushSample 走背压后再入队 --------------------------- */

test('集成：队列满时 pushSample 先等待再交给解码器', async () => {
  const decoder = new QueueDecoder({ output: () => {}, error: () => {} });
  let q = 8;
  Object.defineProperty(decoder, 'decodeQueueSize', { get: () => q });
  const schedules = [];
  const pipeline = new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: { container: 'toy', tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }], durationUs: 1, seekable: true, live: false },
    player: null,
    options: {
      maxDecodeQueue: 8,
      videoDecoderFactory: () => decoder,
      audioDecoderFactory: () => new QueueDecoder({ output: () => {}, error: () => {} }),
      audioOutputFactory: async () => new NullAudioOutput(),
      rendererFactory: () => new NullRenderer(),
      schedule: (fn) => {
        schedules.push(fn);
        return () => {};
      },
    },
  });
  pipeline._videoDecoder = decoder;

  const p = pipeline.pushSample({ trackId: 1, timestamp: 0, keyframe: true, data: new Uint8Array([1]) });
  await Promise.resolve();
  assert.equal(decoder.chunks.length, 0, '背压期间不应入队');
  assert.equal(schedules.length, 1, '应已调度一次等待');
  q = 0; // 队列回落
  schedules.shift()();
  await p;
  assert.equal(decoder.chunks.length, 1, '背压解除后样本已交解码器');
});

test('集成：Player 全链路可跑通且不因背压死锁（队列始终为 0）', async () => {
  const decoder = new QueueDecoder({ output: () => {}, error: () => {} });
  const renderer = new NullRenderer();
  const player = new Player({
    demuxerFactory: () => new ToyVideoDemuxer(new MemoryDataSource(new Uint8Array([1]))),
    capabilities: {
      webcodecs: { supported: true, video: { 'avc1.42E01E': true }, audio: {} },
      mse: { supported: false, mimeTypes: [] },
    },
    pipelineFactory: webcodecsPipelineFactory({
      videoDecoderFactory: () => decoder,
      audioDecoderFactory: () => new QueueDecoder({ output: () => {}, error: () => {} }),
      audioOutputFactory: async () => new NullAudioOutput(),
      schedule: (fn) => {
        fn();
        return () => {};
      },
    }),
  });
  await player.load(new Uint8Array([1]));
  player.pipeline.renderer = renderer;
  await player.play();
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.equal(decoder.chunks.length, 1, '样本已进解码器');
  await player.destroy();
});
