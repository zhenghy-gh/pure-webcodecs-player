/**
 * MSE 路线端到端防回归（真实浏览器验收暴露的缺陷，见 docs/review/round-1-问题清单.md §44）
 *
 * 1. chooseRoute 忽略宿主 routePreference —— 强制 MSE 时仍裁决 webcodecs；
 * 2. MseHelper.addTrack 用**实例**调 isTypeSupported（实为构造器静态方法）→ 恒判不支持；
 * 3. MsePipeline.init 逐轨「建 SB → 写 init」交错 —— Chrome 在某 SB 写过数据后拒绝新建 SB
 *    （QuotaExceededError: reached the limit of SourceBuffer objects），必须两阶段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoute } from '../src/capabilities.js';
import { MsePipeline } from '../src/pipeline-mse.js';

const info = {
  container: 'mp4',
  durationUs: 52_209_000,
  seekable: true,
  live: false,
  tracks: [
    { id: 1, type: 'video', codec: 'avc1.64001E', width: 854, height: 480 },
    { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
  ],
};
const dualCaps = {
  webcodecs: { supported: true, video: { 'avc1.64001E': true }, audio: { 'mp4a.40.2': true } },
  // mimeTypes 非空 = 深探测结果，chooseRoute 直接采信（Node 无 MediaSource 也能确定性裁决）
  mse: { supported: true, mimeTypes: ['video/mp4; codecs="avc1.64001E, mp4a.40.2"'] },
};

test('chooseRoute：默认优先级仍是「能用 WebCodecs 就不落 MSE」', () => {
  assert.equal(chooseRoute(dualCaps, info), 'webcodecs');
  assert.equal(chooseRoute(dualCaps, info, { preference: [] }), 'webcodecs');
});

test('chooseRoute：尊重宿主 routePreference（强制 MSE 时不再回落到 webcodecs）', () => {
  assert.equal(chooseRoute(dualCaps, info, { preference: ['mse'] }), 'mse');
  assert.equal(chooseRoute(dualCaps, info, { preference: ['mse', 'webcodecs'] }), 'mse');
});

test('chooseRoute：偏好路线不可用时，回退到偏好列表内的下一个可用路线', () => {
  const wcOnly = {
    webcodecs: dualCaps.webcodecs,
    mse: { supported: false, mimeTypes: [] },
  };
  assert.equal(chooseRoute(wcOnly, info, { preference: ['mse', 'webcodecs'] }), 'webcodecs');
  const noneCaps = {
    webcodecs: { supported: false, video: {}, audio: {} },
    mse: { supported: false, mimeTypes: [] },
  };
  assert.equal(chooseRoute(noneCaps, info, { preference: ['mse', 'webcodecs'] }), 'none');
});

/** 记录调用顺序的假 MediaSource 封装 */
class OrderMse {
  constructor({ supported = true } = {}) {
    this.calls = [];
    this.supportedFlag = supported;
    this.opened = false;
    this.duration = null;
  }
  async open() { this.opened = true; }
  async addTrack(key) { this.calls.push(`add:${key}`); return { key }; }
  async append(key) { this.calls.push(`append:${key}`); }
  async setDuration(sec) { this.duration = sec; }
  bufferedAhead() { return 0; }
}

class FakeRemuxer {
  constructor() { this.inits = []; }
  createInitSegment(track) { this.inits.push(track.id); return new Uint8Array([0xf0, track.id]); }
  createMediaSegment(track, samples) {
    return {
      data: new Uint8Array(samples.length),
      sequenceNumber: 0,
      sampleCount: samples.length,
      baseMediaDecodeTimeUs: samples[0]?.timestamp ?? 0,
      durationUs: samples.reduce((a, s) => a + (s.duration ?? 0), 0),
    };
  }
}

function buildPipeline(mse) {
  return new MsePipeline({
    route: 'mse',
    mediaInfo: info,
    player: null,
    options: {
      mediaElement: { currentTime: 0, play() {}, pause() {}, addEventListener() {}, removeEventListener() {} },
      mse,
      remuxer: new FakeRemuxer(),
      schedule: (fn) => { fn(); return () => {}; },
    },
  });
}

test('MsePipeline.init：先建齐所有 SourceBuffer，再统一写 init segment（Chrome 配额限制）', async () => {
  const mse = new OrderMse();
  const pipeline = buildPipeline(mse);
  await pipeline.init();
  assert.deepEqual(
    mse.calls,
    ['add:v1', 'add:a2', 'append:v1', 'append:a2'],
    '建 SB 与写 init 不得交错：任一 SB 写过数据后 Chrome 拒绝再新建 SB',
  );
  assert.equal(pipeline.counters.initSegments, 2);
});

test('MseHelper.addTrack：isTypeSupported 走构造器静态方法（实例上不存在）', async () => {
  const { MseHelper } = await import('../src/mse-helper.js');

  // 真实语义：MediaSource 实例上没有 isTypeSupported，只有构造器静态有
  class FakeSource {
    constructor() { this.readyState = 'open'; this.sourceBuffers = []; }
    addSourceBuffer(mime) { this.sourceBuffers.push(mime); return { addEventListener() {}, removeEventListener() {}, appendBuffer() {}, updating: false }; }
  }
  const staticSupported = (flag) => class extends FakeSource {
    static isTypeSupported() { return flag; }
  };

  const okCtor = staticSupported(true);
  const original = globalThis.MediaSource;
  globalThis.MediaSource = okCtor;
  try {
    const helper = new MseHelper({ addEventListener() {}, removeEventListener() {} });
    helper.mediaSource = new okCtor();
    helper.opened = true;
    await helper.addTrack('v1', 'video/mp4; codecs="avc1.64001E"');
    assert.equal(helper.channels.size, 1, '静态 isTypeSupported=true 时应建轨成功');
  } finally {
    globalThis.MediaSource = original;
  }

  const noCtor = staticSupported(false);
  globalThis.MediaSource = noCtor;
  try {
    const helper2 = new MseHelper({ addEventListener() {}, removeEventListener() {} });
    helper2.mediaSource = new noCtor();
    helper2.opened = true;
    await assert.rejects(
      () => helper2.addTrack('v1', 'video/mp4; codecs="avc1.64001E"'),
      (e) => e.code === 'NOT_SUPPORTED',
    );
  } finally {
    globalThis.MediaSource = original;
  }
});
