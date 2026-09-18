/**
 * wav/__tests__/wav-player-smart.test.js — WavPlayer 播放调度可测化（env 层）
 * ------------------------------------------------------------
 * play/seek/pause 的真实调度路径在 Node 下不可达（AudioContext/AudioWorklet），
 * 用 Fake globalThis（withGlobals try/finally 还原）+ node:test mock timers
 * 覆盖完整推送循环：预填充、水位节流、eof、暂停恢复、ended 重播、seek 续推。
 * 不覆盖：真实浏览器的音频输出语义与 worklet 消费时序。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WavPlayer } from '../src/player.js';

/* ---------------- fixture ---------------- */

function putFourCC(dv, off, id) { for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i)); }
function putChunk(dv, off, id, size) { putFourCC(dv, off, id); dv.setUint32(off + 4, size, true); }

function buildWav(opt = {}) {
  const channels = opt.channels ?? 1;
  const sampleRate = opt.sampleRate ?? 48000;
  const frames = opt.frames ?? 48000; // 默认 1 秒
  const dataBytes = frames * channels * 2;
  const total = 12 + 24 + (8 + dataBytes);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  putChunk(dv, 0, 'RIFF', total - 8); putFourCC(dv, 8, 'WAVE');
  putChunk(dv, 12, 'fmt ', 16);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
  putChunk(dv, 36, 'data', dataBytes);
  for (let i = 0; i < frames * channels; i++) dv.setInt16(44 + i * 2, (i * 37) % 30000, true);
  return new Uint8Array(buf);
}

/* ---------------- Fake 环境 ---------------- */

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

/** 一套 Fake WebAudio：AudioContext / AudioWorkletNode / Blob / URL */
function makeFakes() {
  const env = { initialState: 'running' };
  const ctxInstances = [];
  const nodeInstances = [];

  class FakeParam {
    constructor() { this.auto = []; }
    setValueAtTime(v, t) { this.auto.push(['set', v, t]); }
    setTargetAtTime(v, t, tc) { this.auto.push(['target', v, t, tc]); }
  }

  class FakePort {
    constructor() { this.sent = []; this.onmessage = null; }
    postMessage(msg, transfer) { this.sent.push({ msg, transfer: transfer ?? null }); }
    /** 模拟 worklet → 主线程消息 */
    dispatch(data) { this.onmessage?.({ data }); }
  }

  class FakeGain {
    constructor() { this.gain = new FakeParam(); this.disconnects = 0; }
    connect(dest) { return dest; }
    disconnect() { this.disconnects++; }
  }

  class FakeAudioContext {
    constructor() {
      this.destination = { kind: 'destination' };
      this.state = env.initialState;
      this.currentTime = 1.25;
      this.resumed = 0;
      this.gains = [];
      this.addModuleUrls = [];
      this.audioWorklet = { addModule: async (url) => { this.addModuleUrls.push(url); } };
      ctxInstances.push(this);
    }
    createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
    async resume() { this.resumed++; this.state = 'running'; }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.opts = opts;
      this.port = new FakePort();
      this.parameters = new Map([['playbackRate', new FakeParam()]]);
      this.disconnects = 0;
      nodeInstances.push(this);
    }
    connect(dest) { return dest; }
    disconnect() { this.disconnects++; }
  }

  class FakeBlob {
    constructor(parts, opts) { this.parts = parts; this.type = opts?.type ?? ''; }
  }

  const fakeURL = {
    created: [],
    revoked: [],
    createObjectURL(blob) { this.created.push(blob); return 'blob:fake'; },
    revokeObjectURL(u) { this.revoked.push(u); },
  };
  return { env, ctxInstances, nodeInstances, FakeAudioContext, FakeAudioWorkletNode, FakeBlob, fakeURL, FakeParam, FakeGain };
}

/** 注入 Fake 浏览器环境 + mock timers，构建已 load 的播放器 */
async function withPlayer(t, opt, fn) {
  const fakes = makeFakes();
  return withGlobals({
    window: {},
    AudioContext: fakes.FakeAudioContext,
    AudioWorkletNode: fakes.FakeAudioWorkletNode,
    Blob: fakes.FakeBlob,
    URL: fakes.fakeURL,
  }, async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = new WavPlayer();
    player.load(buildWav(opt));
    return fn(player, fakes);
  });
}

/** 把 node 已发送的消息喂给 WriteTracker（按 flush 分段校验连续性） */
class WriteTracker {
  constructor() { this.segs = [[]]; this.cursor = 0; this.eof = false; this.flushes = []; }
  feed(msg) {
    if (msg.type === 'flush') {
      this.flushes.push(msg.baseFrame);
      this.cursor = msg.baseFrame;
      this.eof = false;
      this.segs.push([]);
    } else if (msg.type === 'write') {
      const n = msg.planar[0].length;
      this.segs[this.segs.length - 1].push([this.cursor, this.cursor + n]);
      this.cursor += n;
    } else if (msg.type === 'eof') this.eof = true;
  }
  /** 各分段内 [a,b) 连续无重叠无缝隙 */
  contiguous() {
    return this.segs.every((seg) => seg.every(([a, b], i) => i === 0 || a === seg[i - 1][1]));
  }
}

function drain(node, tracker) {
  for (const { msg } of node.port.sent.splice(0)) tracker.feed(msg);
}

/** 驱动推送循环直至 eof（上限保护） */
function tickUntilEof(t, node, tracker) {
  for (let i = 0; i < 24 && !tracker.eof; i++) t.mock.timers.tick(60);
  drain(node, tracker);
}

/* ---------------- 推送循环调度 ---------------- */

describe('WavPlayer 推送循环调度（Fake WebAudio + mock timers）', () => {
  test('首播：预填充后循环存活，分块推进直至 eof；write 一律 Transferable', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      const tracker = new WriteTracker();
      await player.play();
      assert.equal(player.state, 'playing');
      const node = fakes.nodeInstances[0];
      assert.equal(node.port.sent[0].msg.type, 'write');
      assert.ok(node.port.sent[0].transfer !== null, 'write 消息必须带 Transferable');
      drain(node, tracker);
      assert.deepEqual(tracker.segs.at(-1), [[0, 8192], [8192, 12288]], 'prefill + 循环首块同步推进');

      tickUntilEof(t, node, tracker);
      assert.equal(tracker.eof, true, '循环应推进到文件尾并发 eof');
      assert.ok(tracker.contiguous(), '各分段写入连续无重叠');
      assert.equal(tracker.segs.at(-1).at(-1)[1], 48000, '覆盖至全部 48000 帧');
    });
  });

  test('暂停→恢复：循环先自灭，play 续启且不重复装载', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      const tracker = new WriteTracker();
      await player.play();
      const node = fakes.nodeInstances[0];
      t.mock.timers.tick(60); t.mock.timers.tick(60); // prefill + 两块
      drain(node, tracker);

      player.pause();
      t.mock.timers.tick(60);
      const msgs = node.port.sent.splice(0);
      assert.equal(msgs.filter((m) => m.msg.type === 'write').length, 0, '暂停后循环退出，不再推送');
      assert.deepEqual(msgs.at(-1).msg, { type: 'pause', value: true });

      await player.play(); // 恢复
      drain(node, tracker);
      assert.equal(tracker.flushes.length, 0, '恢复不应 flush/重复预填充，应续启循环');
      const resumed = tracker.segs.at(-1).at(-1);
      assert.deepEqual(resumed, [20480, 24576], '从暂停点续推下一块');

      tickUntilEof(t, node, tracker);
      assert.ok(tracker.contiguous(), '全程写入连续（无重复块/缝隙）');
      assert.equal(tracker.segs.at(-1).at(-1)[1], 48000);
      assert.equal(tracker.eof, true);
    });
  });

  test('ended→重播：seek(0) flush 后 play 不重复预填充，循环续启', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      const tracker = new WriteTracker();
      await player.play();
      const node = fakes.nodeInstances[0];
      tickUntilEof(t, node, tracker);
      node.port.dispatch({ type: 'ended' }); // worklet 播完上报
      assert.equal(player.state, 'ended');

      await player.play(); // 从头重播
      drain(node, tracker);
      assert.deepEqual(tracker.flushes, [0], '重播前 flush baseFrame=0');
      const seg = tracker.segs.at(-1);
      assert.deepEqual(seg[0], [0, 8192], '重播只预填充一次');
      assert.ok(seg.length >= 2 && seg[1][0] === 8192, '循环立即续推，无重复 [0,8192) 块');

      tickUntilEof(t, node, tracker);
      assert.equal(tracker.eof, true);
      assert.ok(tracker.contiguous());
      assert.equal(tracker.segs.at(-1).at(-1)[1], 48000);
    });
  });

  test('播放中 seek：flush 对齐 + 预填充 + 循环从新位置续推', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      const tracker = new WriteTracker();
      await player.play();
      const node = fakes.nodeInstances[0];
      t.mock.timers.tick(60);
      drain(node, tracker);

      await player.seek(0.5); // 24000 帧
      drain(node, tracker);
      assert.deepEqual(tracker.flushes, [24000]);
      const seg = tracker.segs.at(-1);
      assert.deepEqual(seg[0], [24000, 32192], 'seek 后预填充 [24000, 32192)');

      t.mock.timers.tick(60);
      drain(node, tracker);
      assert.ok(tracker.contiguous(), '旧循环采纳新游标，不产生重叠/缝隙');
      assert.deepEqual(tracker.segs.at(-1)[1], [32192, 36288], '循环从预填充尾续推');
    });
  });

  test('水位节流：buffered 达高水位推迟推送，回落恢复', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      const tracker = new WriteTracker();
      await player.play();
      const node = fakes.nodeInstances[0];
      drain(node, tracker); // prefill [0,8192) + 循环首块 [8192,12288)，下一块已排定
      const baseCount = tracker.segs.at(-1).length;

      node.port.dispatch({ type: 'progress', frame: 100, buffered: 16384 - 4096 - 1024 });
      t.mock.timers.tick(60);
      drain(node, tracker);
      assert.equal(tracker.segs.at(-1).length, baseCount, '高水位：本块被推迟');
      t.mock.timers.tick(20);
      drain(node, tracker);
      assert.equal(tracker.segs.at(-1).length, baseCount, '仍高于水位：继续推迟');

      node.port.dispatch({ type: 'progress', frame: 100, buffered: 0 });
      t.mock.timers.tick(20);
      drain(node, tracker);
      assert.deepEqual(tracker.segs.at(-1).at(-1), [12288, 16384], '水位回落：恢复推送');
    });
  });
});

/* ---------------- worklet 上行消息处理 ---------------- */

describe('WavPlayer worklet 消息处理', () => {
  test('progress→time 事件；overflow（含 total 回退累计）；underrun→stats；ended→置态', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      await player.play();
      const node = fakes.nodeInstances[0];

      const times = [];
      player.on('time', (p) => times.push(p));
      node.port.dispatch({ type: 'progress', frame: 9600, buffered: 100 });
      assert.equal(player.currentTime(), 0.2);
      assert.ok(times.length === 1 && Math.abs(times[0].currentTime - 0.2) < 1e-9);

      const overflows = [];
      player.on('overflow', (p) => overflows.push(p));
      node.port.dispatch({ type: 'overflow', dropped: 5, total: 7 });
      assert.deepEqual(overflows[0], { dropped: 5, total: 7 });
      node.port.dispatch({ type: 'overflow', dropped: 2 }); // 无 total：本地累计
      assert.equal(overflows[1].total, 9);

      node.port.dispatch({ type: 'underrun', count: 3 });
      assert.equal(player.underruns, 3);
      const stats = player.getStats();
      assert.deepEqual(stats.find((r) => r[0] === 'underrun'), ['underrun', '3']);
      assert.equal(stats.find((r) => r[0] === '溢出丢弃帧')[1], '9');

      let endedFired = false;
      player.on('ended', () => { endedFired = true; });
      node.port.dispatch({ type: 'ended' });
      assert.equal(player.state, 'ended');
      assert.equal(endedFired, true);
      assert.deepEqual(node.port.sent.at(-1).msg, { type: 'pause', value: true }, 'ended 先按 playing 发暂停');
    });
  });

  test('progress 上报位置驱动 getStats 的 worklet 缓冲行', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      await player.play();
      const node = fakes.nodeInstances[0];
      node.port.dispatch({ type: 'progress', frame: 40000, buffered: 4800 });
      const stats = player.getStats();
      // 剩余 48000-40000=8000 帧 < 水位上限 12288 → 8000/48000 ≈ 167ms
      assert.equal(stats.find((r) => r[0] === 'worklet 缓冲≈')[1], '167 ms');
    });
  });
});

/* ---------------- 音频图与生命周期 ---------------- */

describe('WavPlayer 音频图与生命周期', () => {
  test('ensureGraph：addModule→revoke、节点初值；stop 幂等；stop 后重播', async (t) => {
    await withPlayer(t, {}, async (player, fakes) => {
      await player.play();
      const ctx = fakes.ctxInstances[0];
      const node = fakes.nodeInstances[0];
      assert.equal(ctx.addModuleUrls.length, 1);
      assert.deepEqual(fakes.fakeURL.revoked, ['blob:fake'], 'addModule 后立即回收 URL');
      assert.equal(node.name, 'wav-pcm-sink');
      assert.equal(node.opts.processorOptions.channels, 1);
      assert.equal(node.opts.processorOptions.capacityFrames, 16384);
      assert.deepEqual(node.parameters.get('playbackRate').auto[0], ['set', 1, 1.25], '初值 setValueAtTime');

      player.setVolume(0.5);
      assert.deepEqual(ctx.gains[0].gain.auto.at(-1), ['target', 0.5, 1.25, 0.01], '音量走 setTargetAtTime');
      player.setRate(2);
      assert.deepEqual(node.parameters.get('playbackRate').auto.at(-1), ['target', 2, 1.25, 0.05], '倍速走 setTargetAtTime');

      await player.stop();
      assert.equal(node.disconnects, 1);
      assert.equal(ctx.gains[0].disconnects, 1);
      assert.equal(player.state, 'ready');

      await player.play(); // stop 后重播：新建节点，prefill 从 baseFrame 起
      assert.equal(fakes.nodeInstances.length, 2, 'stop 后重建音频节点');
      const node2 = fakes.nodeInstances[1];
      const tracker = new WriteTracker();
      drain(node2, tracker);
      assert.deepEqual(tracker.segs.at(-1), [[0, 8192]]);
      tickUntilEof(t, node2, tracker);
      assert.equal(tracker.eof, true);
      assert.ok(tracker.contiguous());
    });
  });

  test('未 load 直接 play 抛状态错误；suspended ctx 触发 resume', async (t) => {
    const fakes = makeFakes();
    await withGlobals({
      window: {},
      AudioContext: fakes.FakeAudioContext,
      AudioWorkletNode: fakes.FakeAudioWorkletNode,
      Blob: fakes.FakeBlob,
      URL: fakes.fakeURL,
    }, async () => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const player = new WavPlayer();
      await assert.rejects(() => player.play(), /先调用 load\(\) 再 play\(\)/);

      player.load(buildWav({ frames: 48000 }));
      fakes.env.initialState = 'suspended';
      await player.play();
      assert.ok(fakes.ctxInstances[0].resumed >= 1, 'suspended 时调用 resume');
    });
  });
});
