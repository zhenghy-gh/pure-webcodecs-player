/**
 * flac player 智能装载可测化（env/浏览器依赖层）
 * ------------------------------------------------------------
 * loadFlacSmart 的主路径（decodeAudioData）在 Node 下不可达，用 Fake globalThis
 * （withGlobals try/finally 还原）注入假 AudioContext 覆盖双路径分支；
 * 回退路径用真实 fixture 走纯 JS 解码器全链路。
 * 不覆盖：真实浏览器 AudioContext 的解码语义与 WavPlayer 的 AudioWorklet 调度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFix } from './helpers.mjs';
import {
  isFlacPlaybackSupported,
  createFlacPlayer,
  loadFlacSmart,
  decodeFlacToPlayable,
  encodeF32PlanarToWavBytes,
} from '../src/player.js';
import { WavPlayer } from '../../wav/src/player.js';

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

/** 记录 load() 入参的最小播放器替身 */
function makePlayerStub() {
  return { loaded: [], load(bytes) { this.loaded.push(bytes); } };
}

/** 假 AudioContext：decodeAudioData 可编程成功/失败，close 记录次数 */
function makeAudioContext({ result = null, error = null } = {}) {
  return class FakeAudioContext {
    constructor() {
      this.closed = 0;
      this.decoded = [];
    }
    async decodeAudioData(buffer) {
      this.decoded.push(buffer);
      if (error) throw error;
      return result;
    }
    async close() { this.closed += 1; }
  };
}

/** 假 AudioBuffer：两声道确定性数据，供 planar 转换断言 */
function makeAudioBuffer(sampleRate = 48000, length = 4) {
  return {
    sampleRate,
    numberOfChannels: 2,
    length,
    getChannelData(c) {
      return Float32Array.from({ length }, (_, i) => (c === 0 ? i / length : -(i / length)));
    },
  };
}

/* ------------------------------ 能力探测 ------------------------------ */

test('Node 默认环境：isFlacPlaybackSupported=false，createFlacPlayer 返回 null', () => {
  assert.equal(isFlacPlaybackSupported(), false);
  assert.equal(createFlacPlayer(), null);
});

test('能力齐全时 createFlacPlayer 产出 WavPlayer；缺 URL.createObjectURL 仍 null', async () => {
  await withGlobals({
    window: {},
    AudioContext: class {},
    Blob: class {},
    URL: { createObjectURL() {} },
  }, () => {
    const p = createFlacPlayer();
    assert.ok(p instanceof WavPlayer);
  });
  // 缺 createObjectURL（函数探测）→ 不支持
  await withGlobals({
    window: {},
    AudioContext: class {},
    Blob: class {},
    URL: {},
  }, () => {
    assert.equal(createFlacPlayer(), null);
  });
});

/* ------------------------------ WAV 封装 ------------------------------ */

test('encodeF32PlanarToWavBytes：IEEE float 头与 planar→交错字节级', () => {
  const bytes = encodeF32PlanarToWavBytes(
    [Float32Array.from([0.5, -0.5]), Float32Array.from([0.25, -0.25])],
    8000,
  );
  const dv = new DataView(bytes.buffer);
  const magic = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  assert.equal(magic(0), 'RIFF');
  assert.equal(dv.getUint32(4, true), bytes.length - 8);
  assert.equal(magic(8), 'WAVE');
  assert.equal(magic(12), 'fmt ');
  assert.equal(dv.getUint32(16, true), 16);
  assert.equal(dv.getUint16(20, true), 3, 'format=IEEE float');
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(24, true), 8000);
  assert.equal(dv.getUint32(28, true), 8000 * 2 * 4, 'byteRate');
  assert.equal(dv.getUint16(32, true), 2 * 4, 'blockAlign');
  assert.equal(dv.getUint16(34, true), 32);
  assert.equal(magic(36), 'data');
  assert.equal(dv.getUint32(40, true), 2 * 2 * 4);

  // 载荷按帧交错：frame0=[ch0,ch1]，frame1=[ch0,ch1]
  assert.equal(dv.getFloat32(44, true), 0.5);
  assert.equal(dv.getFloat32(48, true), 0.25);
  assert.equal(dv.getFloat32(52, true), -0.5);
  assert.equal(dv.getFloat32(56, true), -0.25);
  assert.equal(bytes.length, 44 + 16);
});

/* ------------------------------ loadFlacSmart 主路径 ------------------------------ */

test('loadFlacSmart：decodeAudioData 成功走主路径，WAV 交接且原字节不被分离', async () => {
  const flac = await readFix('sample-basic.flac');
  const player = makePlayerStub();
  const Ctx = makeAudioContext({ result: makeAudioBuffer() });

  await withGlobals({ AudioContext: Ctx }, async () => {
    const r = await loadFlacSmart(player, flac);
    assert.equal(r.via, 'decode-audio-data');
    assert.equal(r.sampleRate, 48000);
    assert.equal(r.channels, 2);
    assert.equal(r.totalSamples, 4);
    assert.deepEqual(r.tags, {}, '主路径仅做安全的标签提取，无标签时为空对象');

    // WAV 头对齐 AudioBuffer 参数，载荷为 planar→交错
    const wav = player.loaded[0];
    assert.ok(wav instanceof Uint8Array);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(dv.getUint16(22, true), 2);
    assert.equal(dv.getUint32(24, true), 48000);
    assert.equal(dv.getUint32(40, true), 4 * 2 * 4);
    assert.equal(dv.getFloat32(44, true), 0);
    assert.ok(Object.is(dv.getFloat32(48, true), -0), 'frame0 ch1 = -(0/4) 为 -0');
    assert.equal(dv.getFloat32(44 + 4 * 4, true), 0.5, 'frame2 ch0');

    // 传入 decodeAudioData 的是拷贝（flacBytes.slice()）：原 buffer 未被 transfer 分离
    assert.ok(!flac.buffer.detached, '原 AudioBuffer 未被 transfer 分离');
  });
});

test('loadFlacSmart：decodeAudioData 抛错回退纯 JS 解码器（真实 fixture 全链路）', async () => {
  const flac = await readFix('sample-basic.flac');
  const player = makePlayerStub();
  const Ctx = makeAudioContext({ error: new Error('not supported') });

  await withGlobals({ AudioContext: Ctx }, async () => {
    const r = await loadFlacSmart(player, flac);
    assert.equal(r.via, 'js-decoder-fallback');
    assert.equal(r.sampleRate, 8000);
    assert.equal(r.channels, 1);
    assert.equal(r.totalSamples, 32);

    const ref = decodeFlacToPlayable(flac);
    assert.equal(r.totalSamples, ref.totalSamples);
    assert.deepEqual([...player.loaded[0]], [...ref.wavBytes], '回退路径交接的 WAV 与直连解码一致');
  });
});

test('loadFlacSmart：无 AudioContext 全局也走回退路径', async () => {
  const flac = await readFix('sample-basic.flac');
  const player = makePlayerStub();
  // withGlobals 显式置 undefined（而非删除）→ 走 typeof 判定为非函数
  await withGlobals({ AudioContext: undefined }, async () => {
    const r = await loadFlacSmart(player, flac);
    assert.equal(r.via, 'js-decoder-fallback');
    assert.equal(r.totalSamples, 32);
    assert.equal(player.loaded.length, 1);
  });
});
