/**
 * AudioWorklet 播放器可测化（env/浏览器依赖层）。
 *
 * 该文件只覆盖「不依赖真实 AudioContext / AudioWorklet 音频线程」的纯逻辑：
 *   - 内联 worklet 处理器源码与注册名（契约 §7 定稿常量）
 *   - createWorkletUrl：Blob + URL.createObjectURL（Node 22 原生支持，非浏览器专属 API）
 *   - 构造期守卫：无 AudioContext 环境（Node 默认）应抛 NOT_SUPPORTED，而非静默构造出无法运行的实例
 *
 * 其余（AudioContext 装载 worklet、process() 环形缓冲、currentTimeSec 主钟、gain 音量、underrun
 * 上报等）必须在真实浏览器里验证——见文件末尾的 Node 豁免清单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PCM_WORKLET_CODE,
  AUDIO_SINK_PROCESSOR_NAME,
  createWorkletUrl,
  AudioWorkletPlayer,
} from '../src/audio-worklet-player.js';
import { notSupported } from '../src/errors.js';

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
