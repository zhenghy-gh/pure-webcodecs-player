/**
 * wav/__tests__/review-fixes.test.js — 第一轮评审修复回归
 * 覆盖：worklet 环形缓冲溢出守卫（阻断1）/ s24 负值符号扩展 /
 *       流式 riffSize 哨兵 / byteRate=0 / seek-from-ended /
 *       NaN 入参守卫 / 定稿方法 open·readSample·destroy 生命周期。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLET_NAME, WORKLET_SOURCE } from '../src/worklet-processor.js';
import { convertToFloat32Planar } from '../src/pcm-convert.js';
import { WavDemuxer, parseWavHeader, probeFailed } from '../src/index.js';
import { buildWav } from './fixtures/gen.mjs';

/* ============================================================
 * worklet 溢出守卫（沙盒实例化 WORKLET_SOURCE，评审指出的零覆盖区）
 * ============================================================ */

/** 在受控沙盒中实例化 worklet 处理器源码 */
function instantiateProcessor({ channels = 1, capacityFrames = 1024, sampleRate = 48000 } = {}) {
  const registry = {};
  const Base = class {
    constructor() {
      this.port = {
        msgs: [],
        postMessage(m) { this.msgs.push(m); },
        set onmessage(fn) { this._onmessage = fn; },
        get onmessage() { return this._onmessage; },
      };
    }
  };
  const factory = new Function(
    'registerProcessor', 'sampleRate', 'currentFrame', 'currentTime',
    'AudioWorkletProcessor', WORKLET_SOURCE,
  );
  factory((name, cls) => { registry[name] = cls; }, sampleRate, 0, 0, Base);
  const Ctor = registry[WORKLET_NAME];
  const node = new Ctor({ processorOptions: { channels, capacityFrames } });
  node.parameters = { playbackRate: [1] };
  return node;
}

describe('worklet 环形缓冲溢出守卫（阻断1 回归）', () => {
  test('容量外写入被拒并上报 overflow，未消费采样不被覆写', () => {
    const CAP = 1024;
    const node = instantiateProcessor({ channels: 1, capacityFrames: CAP });

    // 写入 900 帧（i*0.001 斜坡）
    const a = Float32Array.from({ length: 900 }, (_, i) => i * 0.001);
    node.handleMessage({ type: 'write', planar: [a] });
    assert.equal(node.buffered(), 900);

    // 再写 200 帧：仅 124 帧可入，76 帧应被丢弃并上报
    const bStart = 0.9;
    const b = Float32Array.from({ length: 200 }, (_, i) => bStart + i * 0.001);
    node.handleMessage({ type: 'write', planar: [b] });

    const ovf = node.port.msgs.find(m => m.type === 'overflow');
    assert.ok(ovf, '必须产生 overflow 上报');
    assert.equal(ovf.dropped, 76);
    assert.equal(ovf.total, 76);
    assert.equal(node.buffered(), CAP, '缓冲恰好等于容量');

    // 消费前 1024 帧：必须严格等于未被覆写的原序列（A 全部 + B 前 124）
    const out = [new Float32Array(CAP)];
    node.process([[]], [out]);
    for (let i = 0; i < CAP - 1; i++) {   // 末帧因插值前瞻自然为静音
      const expect = i < 900 ? i * 0.001 : bStart + (i - 900) * 0.001;
      if (Math.abs(out[0][i] - expect) > 1e-6) {
        assert.fail(`第 ${i} 样本应为 ${expect}，实得 ${out[0][i]}（被覆写则守卫失效）`);
      }
    }
  });

  test('溢出后恢复写入：flush 清场后新数据正常入环', () => {
    const node = instantiateProcessor({ channels: 1 });
    node.handleMessage({ type: 'write', planar: [Float32Array.from({ length: 1100 }, () => 1)] });
    assert.equal(node.droppedTotal, 76);              // 1100-1024 被守卫丢弃
    node.handleMessage({ type: 'flush', baseFrame: 0 });
    assert.equal(node.buffered(), 0);
    node.handleMessage({ type: 'write', planar: [Float32Array.from([0.5, 0.25])] });
    node.handleMessage({ type: 'eof' });               // 真实时序：推完即发 eof，尾帧保持生效
    const o2 = [new Float32Array(16)];
    node.process([[]], [o2]);
    assert.ok(Math.abs(o2[0][0] - 0.5) < 1e-6);
    assert.ok(Math.abs(o2[0][1] - 0.25) < 1e-6);       // eof 尾帧保持：末帧不再被前瞻吞掉
  });

  test('连续过载周期：droppedTotal 累计且序列头完整（评审定量仿真同构）', () => {
    // 复刻评审仿真形态：产能 > 消费，连续多周期过载
    const CAP = 1024;
    const node = instantiateProcessor({ channels: 1, capacityFrames: CAP });
    let pushed = 0;
    let base = 0;
    for (let cycle = 0; cycle < 15; cycle++) {
      const chunk = Float32Array.from({ length: 96 }, (_, i) => base + i);
      node.handleMessage({ type: 'write', planar: [chunk] });
      pushed += 96;
      base += 96;
      if (node.buffered() >= CAP) break;               // 已满：后续全部计入丢弃
    }
    assert.equal(node.droppedTotal, pushed - node.buffered(),
      'droppedTotal 必须等于 推送总量 − 实际入环量');
    node.handleMessage({ type: 'eof' });                // 启用尾帧保持，整段可完整消费

    // 整环消费：前 CAP 个样本必须与首写序列严格一致（覆写即失真）
    const out = [new Float32Array(CAP)];
    node.process([[]], [out]);
    for (let i = 0; i < CAP; i++) {
      if (Math.abs(out[0][i] - i * 1.0) > 1e-6) {
        assert.fail(`第 ${i} 样本被覆写：实得 ${out[0][i]}，应为 ${i}`);
      }
    }
  });
});

/* ============================================================
 * s24 负值符号扩展（评审测试缺口）
 * ============================================================ */
describe('f32 非有限值钳制（评审建议回归）', () => {
  test('NaN/±Inf 直通被钳制为 0，正常值保留', () => {
    // 单声道 f32：[1.5, NaN, +Inf, -Inf, 0.25]
    const data = new Uint8Array(20);
    const dv = new DataView(data.buffer);
    dv.setFloat32(0, 1.5, true);
    dv.setFloat32(4, NaN, true);
    dv.setFloat32(8, Infinity, true);
    dv.setFloat32(12, -Infinity, true);
    dv.setFloat32(16, 0.25, true);
    const { planar } = convertToFloat32Planar(data, { formatTag: 3, channels: 1, bitsPerSample: 32 });
    assert.equal(planar[0][0], 1.5);
    assert.equal(planar[0][1], 0);                       // NaN → 0
    assert.equal(planar[0][2], 0);                       // +Inf → 0
    assert.equal(planar[0][3], 0);                       // −Inf → 0
    assert.equal(planar[0][4], 0.25);
  });
});

describe('s24 符号扩展', () => {
  test('负值（高位 1）正确扩展为负浮点', () => {
    // 单声道两帧：0xFFFFFF(-1) 与 0x800000(-8388608)
    const data = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0x00, 0x80]);
    const { planar } = convertToFloat32Planar(data, { formatTag: 1, channels: 1, bitsPerSample: 24 });
    assert.ok(Math.abs(planar[0][0] - (-1 / 8388608)) < 1e-12, `-1 实得 ${planar[0][0]}`);
    assert.equal(planar[0][1], -1);                  // 最小值饱和为 -1.0
  });
});

/* ============================================================
 * 流式哨兵 / byteRate=0 / NaN 守卫 / seek-from-ended / 定稿方法
 * ============================================================ */

/** 构造 riffSize=0xFFFFFFFF 的流式录制 WAV */
function buildStreamingWav() {
  const bytes = buildWav({ channels: 1, sampleRate: 8000, frames: 16 });
  const dv = new DataView(bytes.buffer);
  dv.setUint32(4, 0xFFFFFFFF, true);                 // 流式占位尺寸
  return bytes;
}

/** 构造 byteRate=0 的畸形头 WAV */
function buildZeroByteRateWav() {
  const bytes = buildWav({});
  new DataView(bytes.buffer).setUint32(28, 0, true);
  return bytes;
}

function memorySource(bytes) {
  return {
    size: bytes.length,
    async read(o, l) {
      if (o < 0 || o + l > bytes.length) throw Object.assign(new Error('越界'), { code: 'SOURCE_ERROR' });
      return bytes.subarray(o, o + l);
    },
    async close() {},
  };
}

describe('评审严重/建议项回归', () => {
  test('riffSize=0xFFFFFFFF 流式头部可打开且时长按 data 块推算', () => {
    const h = parseWavHeader(buildStreamingWav());
    assert.equal(h.format.channels, 1);
    assert.equal(h.codec, 'pcm-s16');
    assert.ok(h.durationUs > 0);
  });

  test('byteRate=0 时 durationUs=null（不再产出 Infinity）', () => {
    const h = parseWavHeader(buildZeroByteRateWav());
    assert.equal(h.durationUs, null);
  });

  test('EOS 后 seek 回 ready，samples 可继续迭代（严重2 回归）', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ frames: 40 })));
    await dem.parseInit();
    for await (const _ of dem.samples(1)) { void _; }   // 消费到 EOS
    assert.equal(dem.state, 'ended');
    await dem.seek(0);                                   // 回跳开头
    assert.equal(dem.state, 'ready');
    let n = 0;
    for await (const s of dem.samples(1)) { assert.equal(s.codec, 'pcm-s16'); n++; }
    assert.ok(n >= 1, 'ended 后 seek 必须能重新迭代');
    await dem.stop();
  });

  test('seek(NaN) 抛 STATE_ERROR 不穿透', async () => {
    const dem = new WavDemuxer(memorySource(buildWav()));
    await dem.parseInit();
    await assert.rejects(() => dem.seek(Number.NaN),
      e => e.code === 'STATE_ERROR');
    await dem.stop();
  });

  test('定稿方法 open/readSample/destroy 生命周期（§2.2）', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ frames: 40 })));
    const mi = await dem.open();                          // open = parseInit 定稿名
    assert.equal(mi.container, 'wav');

    let got = 0;
    for (;;) {
      const s = await dem.readSample(1);
      if (!s) break;                                      // EOS resolve null
      got++;
      assert.equal(s.keyframe, true);
    }
    assert.ok(got >= 1);

    const r = await dem.seek(Math.round(20 / 8000 * 1e6));
    assert.ok(r.actualTimestampUs >= 0);
    const again = await dem.readSample(1);
    assert.ok(again && again.timestamp === r.actualTimestampUs);

    await dem.destroy();                                  // 幂等销毁
    await dem.destroy();
    await assert.rejects(() => dem.open(), e => e.code === 'STATE_ERROR');
  });

  test('§10 注册形状：probe/createDemuxer/containerName', async () => {
    const mod = await import('../src/index.js');
    assert.equal(mod.containerName, 'wav');
    assert.deepEqual(mod.extensions, ['wav', 'wave']);
    const bytes = buildWav({});
    const pr = mod.probe(bytes);
    assert.ok(pr && pr.container === 'wav' && pr.confidence >= 0.8);
    const dem = await mod.createDemuxer(memorySource(bytes));
    assert.equal(dem.mediaInfo.container, 'wav');
    await dem.destroy();

    await assert.rejects(
      () => mod.createDemuxer(memorySource(new TextEncoder().encode('OggS garbage'))),
      e => e.code === 'PROBE_FAILED',
    );
  });
});
