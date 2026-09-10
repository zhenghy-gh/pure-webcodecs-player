/**
 * wav/__tests__/wav-player.test.js — createWavPlayer 构造与 WavPlayer 基本方法
 * 浏览器专属能力（AudioContext/AudioWorklet）无法在 Node 单测中实例化，
 * 故通过「最小 mock 环境」让 isWavPlaybackSupported() 为真，从而触达
 * load/getters/seek/getStats 等纯逻辑；真实出声路径（play）标注为浏览器专属。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWavHeader, createWavPlayer, isWavPlaybackSupported, WavPlayer, ErrorCode }
  from '../src/index.js';

/* ---------------- fixture ---------------- */

function putFourCC(dv, off, id) { for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i)); }
function putChunk(dv, off, id, size) { putFourCC(dv, off, id); dv.setUint32(off + 4, size, true); }

function buildWav(opt = {}) {
  const channels = opt.channels ?? 2;
  const sampleRate = opt.sampleRate ?? 48000;
  const bits = opt.bitsPerSample ?? 16;
  const bps = bits >> 3;
  const blockAlign = channels * bps;
  const byteRate = sampleRate * blockAlign;
  const frames = opt.frames ?? 48000; // 默认 1 秒，便于 seek 0.5s 精确
  const dataBytes = frames * blockAlign;
  const total = 12 + 24 + (8 + dataBytes);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  putChunk(dv, 0, 'RIFF', total - 8); putFourCC(dv, 8, 'WAVE');
  putChunk(dv, 12, 'fmt ', 16);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, bits, true);
  putChunk(dv, 36, 'data', dataBytes);
  for (let i = 0; i < frames * channels; i++) dv.setInt16(44 + i * 2, (i * 100) % 30000, true);
  return new Uint8Array(buf);
}

/** 临时注入最小浏览器环境，返回还原函数 */
function mockBrowserEnv() {
  const saved = {
    window: globalThis.window,
    AudioContext: globalThis.AudioContext,
    createObjectURL: globalThis.URL && globalThis.URL.createObjectURL,
  };
  globalThis.window = {};
  globalThis.AudioContext = function () {};
  if (globalThis.URL) globalThis.URL.createObjectURL = () => 'blob:mock';
  return () => {
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
    if (saved.AudioContext === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved.AudioContext;
    if (globalThis.URL) {
      if (saved.createObjectURL === undefined) delete globalThis.URL.createObjectURL;
      else globalThis.URL.createObjectURL = saved.createObjectURL;
    }
  };
}

/* ---------------- Node 原生契约 ---------------- */

describe('Node 下 createWavPlayer 契约', () => {
  test('isWavPlaybackSupported()=false，createWavPlayer()=null', () => {
    assert.equal(isWavPlaybackSupported(), false);
    assert.equal(createWavPlayer(), null);
  });

  test('直接 new WavPlayer() 在 Node 抛 NOT_SUPPORTED', () => {
    assert.throws(() => new WavPlayer(), (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });
});

/* ---------------- mock 环境下的基本方法 ---------------- */

describe('mock 环境下 WavPlayer 基本方法', () => {
  test('createWavPlayer 返回实例且 load 解析字段正确', () => {
    const restore = mockBrowserEnv();
    try {
      const player = createWavPlayer();
      assert.ok(player instanceof WavPlayer);

      const wav = buildWav({ channels: 2, sampleRate: 48000, frames: 48000 });
      let ready = false;
      player.on('ready', () => { ready = true; });
      const { durationSec } = player.load(wav);
      assert.equal(ready, true);
      assert.equal(player.sampleRate, 48000);
      assert.equal(player.channels, 2);
      assert.equal(player.bitsPerSample, 16);
      assert.equal(player.codec, 'pcm-s16');
      assert.equal(player.totalFrames, 48000);
      assert.ok(Math.abs(durationSec - 1.0) < 1e-9);
      assert.equal(player.duration(), 1.0);
      assert.equal(player.currentTime(), 0);
      assert.equal(player.seekable, true);
      assert.deepEqual(player.rates, [0.5, 0.75, 1, 1.25, 1.5, 2]);
    } finally {
      restore();
    }
  });

  test('setVolume/setRate 限幅；seek 更新位置并广播 time 事件', async () => {
    const restore = mockBrowserEnv();
    try {
      const player = createWavPlayer();
      player.load(buildWav({ channels: 1, sampleRate: 48000, frames: 48000 }));

      player.setVolume(2); assert.equal(player.volume, 1);
      player.setVolume(-1); assert.equal(player.volume, 0);
      player.setRate(10); assert.equal(player.rate, 4);
      player.setRate(0.1); assert.equal(player.rate, 0.25);

      let evt = null;
      player.on('time', (p) => { evt = p; });
      player.seek(0.5);
      assert.equal(player.currentTime(), 0.5);
      assert.ok(evt && Math.abs(evt.currentTime - 0.5) < 1e-9);

      const stats = player.getStats();
      assert.ok(Array.isArray(stats));
      const codecRow = stats.find((r) => r[0] === 'codec');
      assert.ok(codecRow && codecRow[1].includes('pcm-s16'));
      const underrunRow = stats.find((r) => r[0] === 'underrun');
      assert.ok(underrunRow);

      // 中间件缺失时 stop() 安全（不触碰真实音频设备）
      await player.stop();
      assert.equal(player.state, 'ready');
    } finally {
      restore();
    }
  });

  test('play() 依赖真实 AudioContext（浏览器专属）：Node mock 环境因 API 不全而拒绝', async () => {
    const restore = mockBrowserEnv();
    try {
      const player = createWavPlayer();
      player.load(buildWav({ frames: 48000 }));
      // 我们仅 stub 了 AudioContext 构造器，未提供 audioWorklet.addModule 等，
      // 因此 play() 必然失败——说明真实出声需浏览器环境，单测中不校验音频输出。
      await assert.rejects(() => player.play());
    } finally {
      restore();
    }
  });
});
