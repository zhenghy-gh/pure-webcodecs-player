/**
 * webrtc 补充单测：player.js 媒体轨道 / 退避纯函数深水区（未覆盖分支）
 *  - ontrack：video 轨道挂到 _videoEl.srcObject（带 stream）
 *  - ontrack：audio 轨道挂到 _audioEl.srcObject（带 stream）
 *  - ontrack：ev.streams[0] 缺失时回退 new MediaStream([track])
 *  - pause / resume：真实调用元素的 pause() / play()
 *  - computeBackoffMs：jitterRatio>0 配合注入 rand 的确定性抖动（上/下/零）
 *  - computeBackoffMs：下限保护 Math.max(50, ...) 触底
 *  - computeBackoffMs：负 attempt 经 Math.max(0, attempt) 归一
 *  - computeBackoffMs：默认 rand（Math.random）结果落在 ±ratio 区间内
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcPlayer, WebRtcState, computeBackoffMs } from '../src/player.js';

/* ---------------- FakePC ---------------- */

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this._listeners = new Map();
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    const prev = this.iceGatheringState;
    this.iceGatheringState = 'complete';
    if (prev !== 'complete') {
      for (const f of this._listeners.get('icegatheringstatechange') || []) f();
    }
  }
  addEventListener(t, f) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(f);
  }
  removeEventListener() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  async getStats() { return []; }
  close() { this.connectionState = 'closed'; }
  setConnectionState(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

function makeChannel(answers = ['A']) {
  return {
    connected: 0,
    exchangedOffers: [],
    closed: 0,
    drainRemoteCandidates: () => [],
    async connect() { this.connected += 1; },
    async exchange(offer) {
      this.exchangedOffers.push(offer);
      return { sdp: answers[Math.min(this.exchangedOffers.length - 1, answers.length - 1)] };
    },
    async close() { this.closed += 1; },
  };
}

/* ---------------- ontrack：video / audio 绑定 ---------------- */

test('ontrack：video 轨道挂到 _videoEl.srcObject，audio 轨道挂到 _audioEl.srcObject', async () => {
  const videoEl = { srcObject: null };
  const audioEl = { srcObject: null };
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', { video: videoEl, audio: audioEl });

  const videoStream = { id: 'v' };
  player.pc.ontrack({ track: { kind: 'video' }, streams: [videoStream] });
  assert.equal(player.stream, videoStream);
  assert.equal(videoEl.srcObject, videoStream);

  const audioStream = { id: 'a' };
  player.pc.ontrack({ track: { kind: 'audio' }, streams: [audioStream] });
  assert.equal(audioEl.srcObject, audioStream, 'audio 轨道应挂到 audio 元素');

  await player.destroy();
});

/* ---------------- ontrack：无 streams 回退 MediaStream ---------------- */

test('ontrack：ev.streams[0] 缺失时回退 new MediaStream([track])', async () => {
  // Node 无原生 MediaStream，注入最小双便于断言构造参数
  const saved = globalThis.MediaStream;
  let captured = null;
  globalThis.MediaStream = class {
    constructor(tracks) { captured = tracks; this.tracks = tracks || []; }
  };
  try {
    const player = new WebRtcPlayer({
      RTCPeerConnectionImpl: FakePC,
      signalChannel: makeChannel(),
    });
    await player.play('https://e/whep', {});
    const track = { kind: 'video' };
    player.pc.ontrack({ track, streams: [] }); // 无 streams[0]
    assert.ok(captured, '应构造 MediaStream 回退');
    assert.deepEqual(captured, [track], 'MediaStream 应以单 track 构造');
    assert.equal(player.stream.tracks[0], track);
    await player.destroy();
  } finally {
    globalThis.MediaStream = saved;
  }
});

/* ---------------- pause / resume 真实调用元素方法 ---------------- */

test('pause / resume：真实调用元素的 pause() / play()', async () => {
  const calls = { pause: 0, play: 0 };
  const videoEl = {
    srcObject: null,
    pause() { calls.pause += 1; },
    play() { calls.play += 1; return Promise.resolve(); },
  };
  const audioEl = {
    srcObject: null,
    pause() { calls.pause += 1; },
    play() { calls.play += 1; return Promise.resolve(); },
  };
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', { video: videoEl, audio: audioEl });
  player.pause();
  assert.equal(calls.pause, 2, 'video + audio 均调用 pause');
  player.resume();
  assert.equal(calls.play, 2, 'video + audio 均调用 play');
  await player.destroy();
});

/* ---------------- computeBackoffMs 退避纯函数深水区 ---------------- */

test('computeBackoffMs：jitterRatio>0 + 注入 rand 的确定性抖动（下/零/上界）', () => {
  const opts = { baseMs: 1000, capMs: 15000, jitterRatio: 0.5, rand: () => 0 };
  // rand=0 → (0*2-1) = -1 → jitter = -raw*ratio → round(raw*(1-ratio))
  assert.equal(computeBackoffMs(0, opts), 500, 'rand=0 → 下限抖动 1000*(1-0.5)');

  opts.rand = () => 0.5;
  // rand=0.5 → (0.5*2-1)=0 → jitter=0 → raw
  assert.equal(computeBackoffMs(0, opts), 1000, 'rand=0.5 → 无抖动');

  opts.rand = () => 1;
  // rand=1 → (1*2-1)=1 → jitter=+raw*ratio → round(raw*(1+ratio))
  assert.equal(computeBackoffMs(0, opts), 1500, 'rand=1 → 上限抖动 1000*(1+0.5)');
});

test('computeBackoffMs：下限保护 Math.max(50, ...) 触底（极小 base）', () => {
  // base=10, attempt=0, ratio=0 → raw=10，经 max(50,10) 触底到 50
  assert.equal(computeBackoffMs(0, { baseMs: 10, capMs: 15000, jitterRatio: 0 }), 50);
});

test('computeBackoffMs：负 attempt 经 Math.max(0, attempt) 归一为 0', () => {
  const opts = { baseMs: 1000, capMs: 15000, jitterRatio: 0 };
  assert.equal(computeBackoffMs(-1, opts), 1000, 'attempt=-1 → 视为 0 次 → base');
  assert.equal(computeBackoffMs(-5, opts), 1000, 'attempt=-5 → 仍为 base');
});

test('computeBackoffMs：默认 rand(Math.random) 结果落在 ±jitterRatio 区间内', () => {
  const x = computeBackoffMs(0); // 默认 base=1000, cap=15000, ratio=0.2
  assert.ok(x >= 800 && x <= 1200, `默认随机抖动应在 [800,1200]，实际 ${x}`);
});
