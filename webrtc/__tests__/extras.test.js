/**
 * webrtc 补充单测：候选解析 / trickle / 信令容错 / 状态机守卫 / 采集器
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCandidateLine,
  summarizeSdp,
} from '../src/sdp-utils.js';
import { WhepSignal, WebSocketSignal } from '../src/signaling.js';
import { WebRtcPlayer, WebRtcState, computeBackoffMs } from '../src/player.js';
import { extractMetrics } from '../src/stats.js';

/* ---------------- candidate 解析 ---------------- */

test('parseCandidateLine：host/srflx/relay 三类与畸形输入', () => {
  const host = parseCandidateLine('candidate:1 1 UDP 2122252543 192.168.1.4 61665 typ host');
  assert.equal(host.type, 'host');
  assert.equal(host.protocol, 'udp');
  assert.equal(host.port, 61665);

  const srflx = parseCandidateLine('candidate:2 1 UDP 1694498815 203.0.113.5 54321 typ srflx raddr 192.168.1.4 rport 61665');
  assert.equal(srflx.type, 'srflx');
  assert.equal(srflx.relatedAddress, '192.168.1.4');
  assert.equal(srflx.relatedPort, 61665);

  const relay = parseCandidateLine('candidate:3 1 UDP 16777215 198.51.100.7 50000 typ relay raddr 0.0.0.0 rport 0');
  assert.equal(relay.type, 'relay');

  assert.equal(parseCandidateLine('garbage'), null);
});

test('summarizeSdp：缺 ICE 属性时 hasIce=false（信令完整性校验）', () => {
  const sdp = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=T
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=recvonly
a=rtpmap:96 H264/90000`;
  const s = summarizeSdp(sdp);
  assert.equal(s.hasIce, false);
  assert.equal(s.hasDtls, false);
  assert.deepEqual(s.directions, ['recvonly']);
});

/* ---------------- WHEP trickle ---------------- */

test('WhepSignal.sendCandidate：PATCH 到资源地址', async () => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    if (init.method === 'POST') {
      return {
        status: 201,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? '/s/1' : 'application/sdp') },
        text: async () => 'v=0\n',
      };
    }
    return { status: 204, headers: { get: () => null }, text: async () => '' };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await sig.exchange('OFFER');
  await sig.sendCandidate('a=candidate:1 1 UDP 1 1.2.3.4 5 typ host');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, 'https://e/s/1');
  // 未协商时 PATCH 抛错
  const sig2 = new WhepSignal('https://e/whep', { fetchImpl: impl });
  await assert.rejects(() => sig2.sendCandidate('x'), /尚未完成协商/);
});

/* ---------------- WebSocketSignal 容错 ---------------- */

function makeFakeWS() {
  const inst = {
    readyState: 0,
    sent: [],
    handlers: {},
    triggerOpen() {
      this.readyState = 1;
      this.onopen?.();
    },
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
  };
  return inst;
}

test('WebSocketSignal：远端候选缓冲、未知 type 与非法 JSON 静默忽略', async () => {
  const ws = makeFakeWS();
  const sig = new WebSocketSignal('wss://x', { WebSocketImpl: function () { return ws; } });
  const connecting = sig.connect();
  ws.triggerOpen();
  await connecting;

  // 非法 JSON 与未知 type 均静默
  sig.ws.onmessage({ data: 'not-json' });
  sig.ws.onmessage({ data: JSON.stringify({ type: 'unknown-thing' }) });
  assert.equal(sig.drainRemoteCandidates().length, 0);

  sig.ws.onmessage({ data: JSON.stringify({ type: 'candidate', candidate: { candidate: 'c1' } }) });
  sig.ws.onmessage({ data: JSON.stringify({ type: 'candidate', candidate: { candidate: 'c2' } }) });
  const drained = sig.drainRemoteCandidates();
  assert.equal(drained.length, 2);
  assert.equal(sig.drainRemoteCandidates().length, 0, '取走后清空');

  // 未连接时 sendCandidate 不抛错（静默丢弃）
  ws.readyState = 3;
  sig.sendCandidate({ candidate: 'dead' });
});

/* ---------------- 状态机守卫 ---------------- */

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this._l = new Map();
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async setLocalDescription(d) { this.localDescription = d; this.iceGatheringState = 'complete'; for (const f of this._l.get('ig') || []) f(); }
  addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); }
  removeEventListener() {}
  async setRemoteDescription() {}
  close() { this.connectionState = 'closed'; }
  setConnectionState(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

test('状态机：非法迁移抛错且 CLOSED 为终态', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: {
      connect: async () => {}, exchange: async () => ({ sdp: 'A' }), drainRemoteCandidates: () => [], close: async () => {},
    },
  });
  await player.play('https://e/x', {});
  assert.equal(player.state, WebRtcState.CONNECTING);
  // CONNECTING → CONNECTED 合法；再想直接回 IDLE 非法
  player.pc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);
  assert.throws(() => player._setState(WebRtcState.IDLE), /非法状态迁移/);

  await player.destroy();
  // CLOSED 终态：任何迁移非法
  assert.throws(() => player._setState(WebRtcState.CONNECTING), /非法状态迁移/);
});

test('computeBackoffMs：带抖动时结果落在 ±jitterRatio 区间', () => {
  let seq = 0;
  const rand = () => ((seq = (seq + 1) % 4) < 2 ? 0 : 1); // 交替取抖动两端
  for (let attempt = 0; attempt < 6; attempt++) {
    const lo = Math.max(50, Math.round(1000 * 2 ** attempt * 0.8));
    const hi = Math.min(15000, Math.round(1000 * 2 ** attempt * 1.2));
    const v = computeBackoffMs(attempt, { baseMs: 1000, capMs: 15000, jitterRatio: 0.2, rand });
    assert.ok(v >= Math.min(lo, 50) - 1 && v <= hi + 1, `attempt=${attempt} v=${v} 区间[${lo},${hi}]`);
  }
});

/* ---------------- StatsCollector ---------------- */

test('StatsCollector：轮询采样与停止', async () => {
  const report = [
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02 },
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, packetsLost: 0, jitter: 0.01 },
  ];
  const pc = {
    connectionState: 'connected',
    getStats: async () => report,
  };
  const { StatsCollector } = await import('../src/stats.js');
  const collector = new StatsCollector(pc, 10);
  const samples = [];
  collector.start((m) => samples.push(m));
  await new Promise((r) => setTimeout(r, 60));
  collector.stop();
  assert.ok(samples.length >= 2, `应采到多轮样本，实际 ${samples.length}`);
  assert.equal(collector.latest.rttMs, 20);
});

test('extractMetrics：音频差分码率与帧率缺省为 null', () => {
  let t = 0;
  const clock = () => (t += 1000);
  const m1 = extractMetrics([{ type: 'inbound-rtp', kind: 'audio', bytesReceived: 4000 }], {}, clock);
  assert.equal(m1.audio.kbps, null);
  const m2 = extractMetrics([{ type: 'inbound-rtp', kind: 'audio', bytesReceived: 52000 }], m1.nextPrev, clock);
  assert.equal(m2.audio.kbps, 384, '48KB/s = 384kbps');
  assert.equal(m2.video.framesPerSecond ?? null, null);
});

/* ---------------- 工厂与信令细节补充 ---------------- */

test('createSignalChannel：按协议分发到 WHEP/自定义实现', async () => {
  const { createSignalChannel } = await import('../src/signaling.js');
  const whep = createSignalChannel('https://e/whep');
  assert.ok(whep.constructor.name === 'WhepSignal');
  const ws = createSignalChannel('wss://sig/path', { WebSocketImpl: function () {} });
  assert.ok(ws.constructor.name === 'WebSocketSignal');
  assert.throws(() => createSignalChannel('ftp://x'), /无法识别的信令地址协议/);
});

test('WhepSignal：authToken 注入 Authorization 头', async () => {
  let seenHeaders = null;
  const impl = async (_url, init = {}) => {
    seenHeaders = init.headers;
    return {
      status: 201,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/sdp' : null) },
      text: async () => 'v=0\n',
    };
  };
  const sig = new WhepSignal('https://e/whep', { fetchImpl: impl, authToken: 'tok123' });
  await sig.exchange('O');
  assert.equal(seenHeaders.Authorization, 'Bearer tok123');
});

test('parsePlayerUrl：webrtc:// 多级路径与查询串剥离', async () => {
  const { parsePlayerUrl } = await import('../src/player.js');
  const r = parsePlayerUrl('webrtc://cdn.live/app/stream?token=x');
  assert.equal(r.channelUrl, 'https://cdn.live/app/stream/whep');
  assert.equal(r.kind, 'whep');
});

/* ---------------- 本地 mock 信令（派发单 T15 缺口） ---------------- */

test('createMockSignalChannel：answer 生成器注入与生命周期', async () => {
  const { createMockSignalChannel } = await import('../src/mock-signaling.js');
  const gen = (offer) => `ANSWER_OF(${offer.length})`;
  const ch = createMockSignalChannel(gen);
  await assert.rejects(() => ch.exchange('O'), /未连接/); // 未 connect 先拒绝
  await ch.connect();
  const { sdp } = await ch.exchange('OFFER_BYTES');
  assert.equal(sdp, 'ANSWER_OF(11)');
  await ch.sendCandidate({ candidate: 'c' });
  assert.equal(ch.candidates.length, 1);
  await ch.close();
  assert.equal(ch.closed, true);
});

test('createLoopbackSignalPair：A/B 双端互连布线', async () => {
  const { createLoopbackSignalPair } = await import('../src/mock-signaling.js');
  const pair = createLoopbackSignalPair({
    aToB: (offer) => `B-ANSWER(${offer})`,
    bToA: (offer) => `A-ANSWER(${offer})`,
  });
  const r1 = await pair.sideA.exchange('OFFER-A');
  assert.equal(r1.sdp, 'B-ANSWER(OFFER-A)');
  assert.deepEqual(pair.wireA, ['OFFER-A'], 'A 发出的消息在 A 线上');
  // B 无生成器的方向必须报错
  const pair2 = createLoopbackSignalPair({});
  await assert.rejects(() => pair2.sideA.exchange('X'), /未提供 answer 生成器/);
});
