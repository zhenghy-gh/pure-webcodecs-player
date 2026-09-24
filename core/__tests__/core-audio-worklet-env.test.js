/**
 * AudioWorklet 播放器可测化（env/浏览器依赖层）。
 *
 * 该文件覆盖两层：
 *   1. 不依赖任何环境的纯逻辑：内联处理器源码与注册名（契约 §7 定稿常量）、
 *      createWorkletUrl（Blob + URL.createObjectURL，Node 22 原生支持）、
 *      构造期守卫（无 AudioContext 抛 NOT_SUPPORTED）。
 *   2. Fake globalThis（withGlobals try/finally 还原）注入假 AudioContext/
 *      AudioWorkletNode 后的真实调度路径：init 装载、push 转发与 transfer、
 *      play/pause/resume 状态机、currentTimeUs 音频主钟（契约 §7 整数 µs）、
 *      worklet 上行消息（stats/underrun）、clearBuffer、destroy 幂等。
 *
 * 不覆盖：真实浏览器音频线程的 process() 环形缓冲消费时序（worklet 源码逻辑
 * 已由 wav/src/worklet-processor.js 同构面在浏览器侧验证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  PCM_WORKLET_CODE,
  AUDIO_SINK_PROCESSOR_NAME,
  createWorkletUrl,
  AudioWorkletPlayer,
  createAudioOutput,
} from '../src/audio-worklet-player.js';
import { notSupported, ErrorCode } from '../src/errors.js';

/** 确保测试期间 AudioContext 全局未被其他文件污染；结束后还原（零浏览器污染）。 */
function withoutAudioContext(fn) {
  const had = 'AudioContext' in globalThis;
  const prev = globalThis.AudioContext;
  if (had) delete globalThis.AudioContext;
  try {
    return fn();
  } finally {
    if (had) globalThis.AudioContext = prev;
    assert.equal(typeof globalThis.AudioContext, had ? 'function' : 'undefined', 'AudioContext 全局已还原');
  }
}

test('PCM worklet：环形缓冲扩容保留未消费样本与顺序', () => {
  let Processor;
  const context = {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor(_name, ctor) { Processor = ctor; },
    currentSampleRate: 4,
    sampleRate: 4,
    currentTime: 0,
  };
  runInNewContext(PCM_WORKLET_CODE, context);
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([9])], frames: 2 } });
  processor.port.onmessage({ data: { type: 'push', channels: [new Uint8Array([1])], frames: 1 } });
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([9])], frames: 1 << 25 } });
  assert.equal(processor.capacity, 0, '无效输入不得触发环形缓冲分配');
  assert.equal(processor.bufferedFrames, 0);
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([1, 2, 3])], frames: 3 } });
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([4, 5, 6])], frames: 3 } });
  assert.ok(processor.capacity >= 6);
  const output = [new Float32Array(6)];
  processor.process([], [output]);
  assert.deepEqual([...output[0]], [1, 2, 3, 4, 5, 6]);
  assert.equal(processor.bufferedFrames, 0);
});

test('PCM worklet：队列上限阻止累计样本超额分配', () => {
  let Processor;
  const code = PCM_WORKLET_CODE.replace('1 << 24', '4');
  runInNewContext(code, {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor(_name, ctor) { Processor = ctor; },
    currentSampleRate: 4,
    sampleRate: 4,
    currentTime: 0,
  });
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([1, 2, 3])], frames: 3 } });
  processor.port.onmessage({ data: { type: 'push', channels: [new Float32Array([4, 5])], frames: 2 } });
  assert.equal(processor.bufferedFrames, 3, '超过累计队列上限的推送被忽略');
  const tooManyChannels = Array.from({ length: 33 }, () => new Float32Array([1]));
  processor.port.onmessage({ data: { type: 'push', channels: tooManyChannels, frames: 1 } });
  assert.equal(processor.bufferedFrames, 3, '超过通道上限的推送被忽略');
});

test('PCM_WORKLET_CODE：内联处理器源码，注册名与契约 §7 一致', () => {
  assert.equal(typeof PCM_WORKLET_CODE, 'string');
  assert.ok(PCM_WORKLET_CODE.length > 200, '源码体非零');
  assert.ok(PCM_WORKLET_CODE.includes('class PcmRingWorklet extends AudioWorkletProcessor'));
  assert.ok(PCM_WORKLET_CODE.includes(`registerProcessor('${AUDIO_SINK_PROCESSOR_NAME}', PcmRingWorklet)`));
  assert.equal(AUDIO_SINK_PROCESSOR_NAME, 'player-audio-sink');
});

test('createWorkletUrl：生成 blob: URL（Node 22 原生 Blob + URL.createObjectURL）', () => {
  const url = createWorkletUrl();
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith('blob:'), '应为 blob: 协议 URL');
  URL.revokeObjectURL(url); // 避免句柄泄漏
  // 自定义 code 也应走同一路径
  const custom = createWorkletUrl('// custom');
  assert.ok(custom.startsWith('blob:'));
  URL.revokeObjectURL(custom);
});

test('AudioWorkletPlayer：拒绝非法采样率与声道数配置', async () => {
  await withGlobals({ AudioContext: class {} }, async () => {
    for (const sampleRate of [0, -1, NaN, Infinity, '48000']) {
      assert.throws(() => new AudioWorkletPlayer({ sampleRate }), (error) => error.code === ErrorCode.STATE_ERROR);
    }
    for (const channelCount of [0, -1, 1.5, 33, NaN]) {
      assert.throws(() => new AudioWorkletPlayer({ channelCount }), (error) => error.code === ErrorCode.STATE_ERROR);
    }
    assert.doesNotThrow(() => new AudioWorkletPlayer({ sampleRate: 48000, channelCount: 32 }));
  });
});

test('AudioWorkletPlayer 构造守卫：无 AudioContext（Node 默认）抛 NOT_SUPPORTED', () => {
  withoutAudioContext(() => {
    assert.equal(typeof AudioContext, 'undefined', 'Node 默认无 AudioContext');
    assert.throws(
      () => new AudioWorkletPlayer({ sampleRate: 48000, channelCount: 2 }),
      (e) => e.code === notSupported().code,
      '无 AudioContext 必须显式报错而非构造出无法运行的实例',
    );
  });
});

/* ==================== Fake WebAudio 调度路径 ==================== */

/** 临时改写 globalThis 若干属性，执行 fn（支持 async）后原样还原 */
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

/** 一套 Fake WebAudio；env.initialState 可控制构造出的 ctx.state */
function makeFakes() {
  const env = { initialState: 'running' };
  const ctxInstances = [];
  const nodeInstances = [];

  class FakePort {
    constructor() { this.sent = []; this.onmessage = null; }
    postMessage(msg, transfer) { this.sent.push({ msg, transfer: transfer ?? null }); }
    dispatch(data) { this.onmessage?.({ data }); }
  }

  class FakeAudioContext {
    constructor(opts) {
      this.opts = opts ?? null;
      this.sampleRate = opts?.sampleRate ?? 48000;
      this.state = env.initialState;
      this.currentTime = 0;
      this.destination = { kind: 'destination' };
      this.resumed = 0;
      this.suspended = 0;
      this.closed = 0;
      this.gains = [];
      this.addModuleUrls = [];
      this.audioWorklet = { addModule: async (u) => { this.addModuleUrls.push(u); } };
      ctxInstances.push(this);
    }
    createGain() {
      const g = { gain: { value: 1 }, disconnects: 0, connect(d) { return d; }, disconnect() { this.disconnects++; } };
      this.gains.push(g);
      return g;
    }
    async resume() { this.resumed++; this.state = 'running'; }
    async suspend() { this.suspended++; this.state = 'suspended'; }
    async close() { this.closed++; }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.opts = opts;
      this.port = new FakePort();
      this.disconnects = 0;
      nodeInstances.push(this);
    }
    connect(dest) { return dest; }
    disconnect() { this.disconnects++; }
  }

  return { env, ctxInstances, nodeInstances, FakeAudioContext, FakeAudioWorkletNode };
}

/** 注入 Fake 环境，产出未 init 的播放器 */
async function withPlayer(t, options, fn) {
  const fakes = makeFakes();
  return withGlobals({
    AudioContext: fakes.FakeAudioContext,
    AudioWorkletNode: fakes.FakeAudioWorkletNode,
  }, async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = new AudioWorkletPlayer(options);
    return fn(player, fakes);
  });
}

test('init：AudioContext 按 sampleRate 创建、addModule、节点连线、ready 事件；重复 init 幂等', async (t) => {
  await withPlayer(t, { sampleRate: 44100, channelCount: 2 }, async (player, fakes) => {
    const ready = [];
    player.on('ready', (p) => ready.push(p));
    await player.init();
    const ctx = fakes.ctxInstances[0];
    assert.deepEqual(ctx.opts, { sampleRate: 44100 }, 'init 仅透传 sampleRate 给 AudioContext');
    assert.equal(ctx.addModuleUrls.length, 1);
    assert.ok(ctx.addModuleUrls[0].startsWith('blob:'));
    const node = fakes.nodeInstances[0];
    assert.equal(node.name, 'player-audio-sink');
    assert.deepEqual(node.opts.outputChannelCount, [2]);
    assert.equal(ready.length, 1);
    assert.deepEqual(ready[0], { sampleRate: 44100 });

    await player.init(); // 二次调用直接返回
    assert.equal(fakes.ctxInstances.length, 1);
    assert.equal(fakes.nodeInstances.length, 1);
  });
});

test('init/push/play 未按序调用抛 STATE_ERROR；push 空数据早退；push 携带 Transferable', async (t) => {
  await withPlayer(t, {}, async (player, fakes) => {
    assert.throws(() => player.push([new Float32Array(4)]), (e) => e.code === ErrorCode.STATE_ERROR);
    assert.throws(() => player.play(), (e) => e.code === ErrorCode.STATE_ERROR);

    await player.init();
    const node = fakes.nodeInstances[0];
    player.push([]);                    // 空声道早退
    player.push([new Float32Array(0)]); // 空帧早退
    assert.equal(node.port.sent.length, 0);

    const ch = new Float32Array([0.1, 0.2, 0.3]);
    player.push([ch]);
    const sent = node.port.sent[0];
    assert.deepEqual(sent.msg, { type: 'push', channels: [ch], frames: 3 });
    assert.deepEqual(sent.transfer, [ch.buffer]);
    assert.equal(player.bufferedSec, 3 / player.sampleRate);

    assert.throws(
      () => player.push([new Float32Array(2), new Float32Array(3)]),
      (error) => error.code === ErrorCode.STATE_ERROR,
    );
    const view = ch.subarray(1);
    player.push([view]);
    const partial = node.port.sent[1];
    assert.deepEqual([...partial.msg.channels[0]], [...view]);
    assert.equal(partial.msg.channels[0].byteOffset, 0);
    assert.equal(partial.msg.channels[0].buffer.byteLength, 8);
    assert.notEqual(partial.msg.channels[0].buffer, ch.buffer);

    player.push([ch, ch]);
    assert.equal(node.port.sent[2].transfer.length, 1, '重复 channel buffer 只 transfer 一次');

    const foreignFloat = runInNewContext('new Float32Array([0.6, 0.7])');
    player.push([foreignFloat]);
    const foreignCopy = node.port.sent[3];
    assert.deepEqual([...foreignCopy.msg.channels[0]], [...foreignFloat]);
    assert.ok(foreignCopy.msg.channels[0].buffer instanceof ArrayBuffer);

    assert.throws(
      () => player.push([runInNewContext('new Uint16Array([1, 2])')]),
      (error) => error.code === ErrorCode.STATE_ERROR,
    );

    if (typeof SharedArrayBuffer === 'function') {
      const shared = new Float32Array(new SharedArrayBuffer(8));
      shared.set([0.4, 0.5]);
      player.push([shared]);
      const copied = node.port.sent[4];
      assert.deepEqual([...copied.msg.channels[0]], [...shared]);
      assert.ok(copied.msg.channels[0].buffer instanceof ArrayBuffer);
      assert.deepEqual(copied.transfer, [copied.msg.channels[0].buffer]);
    }
  });
});

test('play/pause/resume 状态机：suspended 触发 resume、锚点与 startedAt、事件次序', async (t) => {
  await withPlayer(t, { sampleRate: 48000 }, async (player, fakes) => {
    fakes.env.initialState = 'suspended';
    await player.init();
    const ctx = fakes.ctxInstances[0];
    ctx.currentTime = 1.0;

    const events = [];
    player.on('play', () => events.push('play'));
    player.on('resumed', () => events.push('resumed'));
    player.on('pause', () => events.push('pause'));

    player.play();
    assert.equal(player.playing, true);
    await new Promise((r) => setImmediate(r)); // resume().then 微任务
    assert.deepEqual(events, ['play', 'resumed']);
    assert.equal(ctx.resumed, 1);
    assert.equal(player._anchorCtxTime, 1.0);
    assert.equal(player._startedAt, 0);

    ctx.currentTime = 2.5;
    assert.equal(player.currentTimeSec(), 1.5);
    assert.equal(player.currentTimeUs, 1500000, '音频主钟整数 µs（契约 §7）');

    player.pause();
    assert.equal(player.playing, false);
    assert.equal(ctx.suspended, 1);
    assert.equal(player.currentTimeSec(), 0, '暂停后回落到已消费帧时钟');

    player.resume();
    assert.equal(player.playing, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.resumed, 2);
    assert.deepEqual(events, ['play', 'resumed', 'pause', 'resumed']);
  });
});

test('currentTimeSec 三态：无 ctx 用已消费帧；非 playing 用已消费帧；playing 用 ctx 时钟', async (t) => {
  await withPlayer(t, { sampleRate: 48000 }, async (player, fakes) => {
    const consumed = 96000 / 48000;
    assert.equal(player.currentTimeSec(), 0); // 无 ctx、零消费

    await player.init();
    const ctx = fakes.ctxInstances[0];
    player._playedFrames = 96000;
    assert.equal(player.currentTimeSec(), consumed, '有 ctx 但非 playing');

    ctx.currentTime = 10.0;
    player.play();
    player._anchorCtxTime = 9.0;
    player._startedAt = 2.0;
    assert.equal(player.currentTimeSec(), 3.0, 'playing：startedAt + ctx 增量');
  });
});

test('worklet 上行消息：stats 驱动 progress（值不变不重发）；underrun 累计并广播', async (t) => {
  await withPlayer(t, {}, async (player, fakes) => {
    await player.init();
    const node = fakes.nodeInstances[0];

    const progress = [];
    player.on('progress', (sec) => progress.push(sec));
    const underruns = [];
    player.on('underrun', (p) => underruns.push(p));

    node.port.dispatch({ type: 'stats', bufferedFrames: 960, playedFrames: 4800, sampleRate: 48000 });
    assert.equal(player._bufferedFrames, 960);
    assert.equal(player._playedFrames, 4800);
    assert.equal(progress.length, 1);
    assert.equal(progress[0], 0.1); // 4800/48000，非 playing 走已消费帧时钟
    assert.equal(player.bufferedSec, 0.02);

    node.port.dispatch({ type: 'stats', bufferedFrames: 960, playedFrames: 4800, sampleRate: 48000 });
    assert.equal(progress.length, 1, 'playedFrames 未变化不重发 progress');

    for (const bad of [
      { type: 'stats', bufferedFrames: -1, playedFrames: 4801, sampleRate: 48000 },
      { type: 'stats', bufferedFrames: 960, playedFrames: 4799, sampleRate: 48000 },
      { type: 'stats', bufferedFrames: 960, playedFrames: 4801, sampleRate: NaN },
      { type: 'stats', bufferedFrames: 960, playedFrames: 4801, sampleRate: 0 },
      { type: 'stats', bufferedFrames: 1 << 25, playedFrames: 4801, sampleRate: 48000 },
      null,
    ]) node.port.dispatch(bad);
    assert.equal(player._bufferedFrames, 960, '非法 stats 不得污染 bufferedFrames');
    assert.equal(player._playedFrames, 4800, '非法 stats 不得回退或跳变 playedFrames');
    assert.equal(player.sampleRate, 48000, '非法 stats 不得修改采样率');

    node.port.dispatch({ type: 'underrun', at: 1.25 });
    assert.equal(player.underrunCount, 1);
    assert.deepEqual(underruns, [{ contextTime: 1.25 }]);

    node.port.dispatch({ type: 'underrun', at: -1 });
    node.port.dispatch({ type: 'underrun', at: NaN });
    assert.equal(player.underrunCount, 1, '非法 underrun 时间戳被忽略');

    node.port.dispatch({ type: 'unknown-type' }); // default 分支静默
    assert.equal(player.underrunCount, 1);
  });
});

test('setVolume 钳制；clearBuffer 复位镜像与锚点；destroy 全链幂等并 revoke URL', async (t) => {
  await withPlayer(t, {}, async (player, fakes) => {
    await player.init();
    const ctx = fakes.ctxInstances[0];
    const node = fakes.nodeInstances[0];
    ctx.currentTime = 3.0;

    player.setVolume(2); assert.equal(ctx.gains[0].gain.value, 1);
    player.setVolume(-1); assert.equal(ctx.gains[0].gain.value, 0);
    player.setVolume(0.5); assert.equal(ctx.gains[0].gain.value, 0.5);

    player.push([new Float32Array(480)]);
    node.port.dispatch({ type: 'stats', bufferedFrames: 480, playedFrames: 100, sampleRate: 48000 });
    const destroyed = [];
    player.on('destroy', () => destroyed.push(true));

    player.clearBuffer();
    const clearMsg = node.port.sent.find((s) => s.msg.type === 'clear');
    assert.ok(clearMsg, '向 worklet 发 clear');
    assert.equal(player._bufferedFrames, 0);
    assert.equal(player._playedFrames, 0);
    assert.equal(player._anchorCtxTime, 3.0);
    assert.equal(player._startedAt, 0);

    assert.equal(player.url.startsWith('blob:'), true);
    player.destroy();
    assert.equal(node.disconnects, 1);
    assert.equal(ctx.gains[0].disconnects, 1);
    assert.equal(ctx.closed, 1);
    assert.equal(player.node, null);
    assert.equal(player.context, null);
    assert.equal(player.destroyed, true);
    assert.deepEqual(destroyed, [true]);

    player.destroy(); // 幂等
    assert.equal(ctx.closed, 1);
    assert.equal(player.destroyed, true);
  });
});

test('createAudioOutput：channels 定稿参数与 channelCount 兼容别名等价', async (t) => {
  await withPlayer(t, {}, async (player, fakes) => {
    void fakes;
    const a = createAudioOutput({ sampleRate: 44100, channels: 1 });
    const b = createAudioOutput({ sampleRate: 44100, channelCount: 1 });
    const c = createAudioOutput({ sampleRate: 44100 }); // 两者皆缺省
    assert.equal(a.channelCount, 1);
    assert.equal(b.channelCount, 1);
    assert.equal(c.channelCount, 2);
    assert.ok(a instanceof AudioWorkletPlayer);
  });
});

test('destroy：底层 disconnect 抛错时仍完成清理并广播 destroy', async (t) => {
  await withPlayer(t, {}, async (player, fakes) => {
    await player.init();
    const node = fakes.nodeInstances[0];
    const gain = fakes.ctxInstances[0].gains[0];
    const destroyed = [];
    player.on('destroy', () => destroyed.push(true));
    node.disconnect = () => { throw new Error('node disconnect failed'); };
    gain.disconnect = () => { throw new Error('gain disconnect failed'); };
    assert.doesNotThrow(() => player.destroy());
    assert.equal(player.destroyed, true);
    assert.equal(player.node, null);
    assert.equal(player.context, null);
    assert.deepEqual(destroyed, [true]);
    assert.doesNotThrow(() => player.resume(), '无 context 的 resume 应安全返回');
    assert.doesNotThrow(() => player.clearBuffer(), '销毁后的 clearBuffer 应安全复位');
  });
});
