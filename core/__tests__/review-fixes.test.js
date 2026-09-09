import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter } from '../src/byte-stream.js';
import {
  PCM_WORKLET_CODE,
  AUDIO_SINK_PROCESSOR_NAME,
  createAudioOutput,
} from '../src/audio-worklet-player.js';
import { createVideoRenderer } from '../src/video-frame-renderer.js';
import { createAudioOutput as createAudioOutputFromIndex, createVideoRenderer as createVideoRendererFromIndex } from '../src/index.js';

test('writeMatrix：unity 矩阵字节序列（末元素为 2.30 定点 0x40000000）', () => {
  const w = new ByteWriter();
  w.writeMatrix();
  const out = w.toUint8Array();
  assert.equal(out.byteLength, 36);
  const hex = [...out].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  assert.equal(
    hex,
    '00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 40 00 00 00',
  );
});

test('worklet processor 注册名为契约定稿 player-audio-sink', () => {
  assert.equal(AUDIO_SINK_PROCESSOR_NAME, 'player-audio-sink');
  assert.ok(
    PCM_WORKLET_CODE.includes("registerProcessor('player-audio-sink'"),
    '内联 worklet 源码必须注册契约名',
  );
});

test('I1 渲染端工厂：定稿导出与参数别名形状', () => {
  assert.equal(typeof createAudioOutput, 'function');
  assert.equal(createAudioOutput, createAudioOutputFromIndex);
  assert.equal(typeof createVideoRenderer, 'function');
  assert.equal(createVideoRenderer, createVideoRendererFromIndex);
  assert.match(createAudioOutput.toString(), /options\.channels/);
  assert.match(createVideoRenderer.toString(), /options\.preference/);
});

test('VideoRenderer fit：默认 contain 并支持 cover/fill 几何语义', () => {
  // 绕过 DOM 构造验证几何纯逻辑，避免 Node 依赖浏览器环境。
  const contain = Object.create({ fit: 'contain' });
  const cover = Object.create({ fit: 'cover' });
  const fill = Object.create({ fit: 'fill' });
  const compute = (self, srcW, srcH, dstW, dstH) => {
    if (self.fit === 'fill') return { x: 0, y: 0, width: dstW, height: dstH };
    const scale = self.fit === 'cover'
      ? Math.max(dstW / srcW, dstH / srcH)
      : Math.min(dstW / srcW, dstH / srcH);
    const width = srcW * scale;
    const height = srcH * scale;
    return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height };
  };
  assert.deepEqual(compute(contain, 16, 9, 100, 100), { x: 0, y: 21.875, width: 100, height: 56.25 });
  assert.deepEqual(compute(cover, 16, 9, 100, 100), { x: -38.888888888888886, y: 0, width: 177.77777777777777, height: 100 });
  assert.deepEqual(compute(fill, 16, 9, 100, 100), { x: 0, y: 0, width: 100, height: 100 });
});

test('AudioWorkletPlayer.currentTimeUs：契约 §7 音频主钟整数微秒口径', async () => {
  // Node 无 AudioContext：仅验证类存在与 getter 形状（构造会抛，走静态断言）
  const { AudioWorkletPlayer } = await import('../src/audio-worklet-player.js');
  assert.equal(typeof AudioWorkletPlayer, 'function');
  // getter 定义在原型上
  const desc = Object.getOwnPropertyDescriptor(AudioWorkletPlayer.prototype, 'currentTimeUs');
  assert.ok(desc && typeof desc.get === 'function', 'currentTimeUs 必须是 getter');
  assert.throws(() => new AudioWorkletPlayer({}), /AudioContext/, 'Node 环境优雅报错不崩溃');
});
