/**
 * webrtc 模块单测：SDP 解析 / WHEP 信令 / 状态机与重连 / getStats 提取
 * 全部使用内联 fixture 与注入的 mock，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSdp,
  summarizeSdp,
} from '../src/sdp-utils.js';
import {
  WhepSignal,
  WebSocketSignal,
} from '../src/signaling.js';
import {
  WebRtcPlayer,
  WebRtcState,
  computeBackoffMs,
  parsePlayerUrl,
} from '../src/player.js';
import { extractMetrics } from '../src/stats.js';

/* ---------------- fixtures ---------------- */

const WHEP_ANSWER_SDP = `v=0
o=- 46117317 2 IN IP4 127.0.0.1
s=WHEP Answer
t=0 0
a=group:BUNDLE 0 1
a=ice-options:trickle
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=mid:0
a=sendonly
a=rtcp-mux
a=ice-ufrag:6HHH
a=ice-pwd:Kk7eSLXWJeBPy2CuQlvVZpbU
a=fingerprint:sha-256 11:FF:ED:80:27:64:B3:8D:5E:F2:56:41:8A:12:FD:D7:62:CC:24:26:EC:E0:97:C4:60:1C:2D:67:AB:AB:AF:72
a=setup:passive
a=rtpmap:96 H264/90000
a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
a=candidate:1 1 UDP 2122252543 192.168.1.4 61665 typ host
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=mid:1
a=sendonly
a=rtcp-mux
a=ice-ufrag:6HHH
a=ice-pwd:Kk7eSLXWJeBPy2CuQlvVZpbU
a=fingerprint:sha-256 11:FF:ED:80:27:64:B3:8D:5E:F2:56:41:8A:12:FD:D7:62:CC:24:26:EC:E0:97:C4:60:1C:2D:67:AB:AB:AF:72
a=setup:passive
a=rtpmap:111 opus/48000/2
`;

/* ---------------- SDP 解析 ---------------- */

test('parseSdp：媒体行/编解码/ICE 属性结构化', () => {
  const { session, media } = parseSdp(WHEP_ANSWER_SDP);
  assert.equal(session.version, 0);
  assert.equal(session.name, 'WHEP Answer');
  assert.equal(session.attributes.group, 'BUNDLE 0 1');

  assert.equal(media.length, 2);
  const [video, audio] = media;
  assert.equal(video.type, 'video');
  assert.equal(video.direction, 'sendonly');
  assert.equal(video.mid, '0');
  assert.equal(video.rtcpMux, true);
  assert.equal(video.iceUfrag, '6HHH');
  assert.match(video.fingerprint, /^sha-256/);
  assert.equal(video.setup, 'passive');

  assert.deepEqual(
    video.codecs.map((c) => `${c.name}/${c.clockRate}`),
    ['H264/90000']
  );
  assert.match(video.codecs[0].fmtp, /profile-level-id=42e01f/);

  assert.equal(audio.codecs[0].name, 'OPUS');
  assert.equal(audio.codecs[0].channels, 2);
});

test('summarizeSdp：信令校验摘要', () => {
  const s = summarizeSdp(WHEP_ANSWER_SDP);
  assert.equal(s.bundle, true);
  assert.deepEqual(s.mediaTypes, ['video', 'audio']);
  assert.ok(s.directions.every((d) => d === 'sendonly'), 'WHEP answer 应为 sendonly');
  assert.deepEqual(s.codecs, ['v:H264', 'a:OPUS']);
  assert.equal(s.hasIce, true);
  assert.equal(s.hasDtls, true);
  assert.equal(s.candidateCount, 1);
});

/* ---------------- WHEP 信令 ---------------- */

function mockFetchForWhep() {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      return {
        status: 201,
        ok: true,
        headers: {
          get: (h) => (h.toLowerCase() === 'location' ? '/sessions/abc123' : h.toLowerCase() === 'content-type' ? 'application/sdp' : null),
        },
        text: async () => WHEP_ANSWER_SDP,
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
    };
  };
  impl.calls = calls;
  return impl;
}

test('WhepSignal：POST offer 换 201 answer，Location 解析为绝对地址', async () => {
  const fetchImpl = mockFetchForWhep();
  const sig = new WhepSignal('https://edge.example.com/whep?token=x', { fetchImpl });
  await sig.connect();
  const { sdp, resourceUrl } = await sig.exchange('OFFER\nSDP=');

  assert.equal(sdp, WHEP_ANSWER_SDP);
  assert.equal(resourceUrl, 'https://edge.example.com/sessions/abc123');
  assert.equal(sig.resourceUrl, resourceUrl);

  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(post.url, 'https://edge.example.com/whep?token=x');
  assert.equal(post.init.headers['Content-Type'], 'application/sdp');
  assert.equal(post.init.body, 'OFFER\nSDP=');
});

test('WhepSignal：close() 向资源地址发 DELETE', async () => {
  const fetchImpl = mockFetchForWhep();
  const sig = new WhepSignal('https://edge.example.com/whep', { fetchImpl });
  await sig.exchange('OFFER');
  await sig.close();
  const del = fetchImpl.calls.find((c) => c.init.method === 'DELETE');
  assert.equal(del.url, 'https://edge.example.com/sessions/abc123');
  // 幂等：再次 close 不再发请求
  const count = fetchImpl.calls.filter((c) => c.init.method === 'DELETE').length;
  await sig.close();
  assert.equal(fetchImpl.calls.filter((c) => c.init.method === 'DELETE').length, count);
});

test('WhepSignal：非 201 响应抛出含状态码的错误', async () => {
  const impl = async () => ({
    status: 404,
    ok: false,
    headers: { get: () => 'text/plain' },
    text: async () => 'no such stream',
  });
  const sig = new WhepSignal('https://edge.example.com/whep', { fetchImpl: impl });
  await assert.rejects(() => sig.exchange('OFFER'), /HTTP 404/);
});

test('WebSocketSignal（自定义信令适配点）：offer/answer JSON 往返', async () => {
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWS.instances.push(this);
    }
    onopen() {}
    send(data) {
      this.sent.push(data);
      this.readyState = 1;
      // 模拟服务端回 answer
      setTimeout(() => this.onmessage({ data: JSON.stringify({ type: 'answer', sdp: 'ANSWER_SDP' }) }), 5);
    }
    close() {
      this.readyState = 3;
    }
  }
  FakeWS.instances = [];

  const sig = new WebSocketSignal('wss://sig.example.com/live/cam1', { WebSocketImpl: FakeWS });
  const connectPromise = sig.connect();
  FakeWS.instances[0].readyState = 1;
  FakeWS.instances[0].onopen(); // 触发 open
  await connectPromise;

  const { sdp } = await sig.exchange('MY_OFFER');
  assert.equal(sdp, 'ANSWER_SDP');
  assert.equal(JSON.parse(FakeWS.instances[0].sent[0]).type, 'offer');
  await sig.close();
});

/* ---------------- 状态机与重连 ---------------- */

/** 可控的 RTCPeerConnection mock */
class FakeRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this._listeners = new Map();
    this.closedViaClose = false;
  }

  addTransceiver(kind, init) {
    this.transceivers.push({ kind, direction: init?.direction });
    return { kind };
  }

  async createOffer() {
    return { type: 'offer', sdp: 'OFFER_SDP_V0' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    // 模拟 ICE 收集完成
    this.iceGatheringState = 'complete';
    for (const fn of this._listeners.get('icegatheringstatechange') || []) fn();
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  /** 测试驱动连接状态变化 */
  setConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }

  close() {
    this.closedViaClose = true;
    this.connectionState = 'closed';
  }
}

function makeChannel(answers = ['ANSWER_SDP']) {
  let i = 0;
  return {
    connected: 0,
    exchangedOffers: [],
    closed: 0,
    drainRemoteCandidates: () => [],
    async connect() {
      this.connected += 1;
    },
    async exchange(offerSdp) {
      this.exchangedOffers.push(offerSdp);
      if (i < answers.length) return { sdp: answers[i++] };
      throw new Error(`第 ${i + 1} 次协商失败（模拟服务端不可用）`);
    },
    async close() {
      this.closed += 1;
    },
  };
}

const ELEMENTS = { video: {}, audio: {} };

test('状态机：play 后 connecting → connected，track 挂到元素', async () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    signalChannel: makeChannel(),
    onEvent: (type, payload) => events.push([type, payload]),
  });
  await player.play('https://edge.example.com/whep', ELEMENTS);
  assert.equal(player.state, WebRtcState.CONNECTING);

  const pc = player.pc;
  pc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);

  // 收流事件 → srcObject 绑定
  const fakeStream = { id: 's1' };
  pc.ontrack({ track: { kind: 'video' }, streams: [fakeStream] });
  assert.equal(player.stream, fakeStream);
  assert.equal(ELEMENTS.video.srcObject, fakeStream);

  // 只收不发
  assert.deepEqual(pc.transceivers.map((t) => t.direction), ['recvonly', 'recvonly']);
  // 非 trickle：offer 应等 gathering 完成后取 localDescription
  assert.equal(player.channel.exchangedOffers[0], 'OFFER_SDP_V0');

  await player.destroy();
  assert.equal(player.state, WebRtcState.CLOSED);
});

test('重连：连接丢失触发退避重连并最终恢复 connected', async () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    signalChannel: makeChannel(['ANSWER_1', 'ANSWER_2']),
    backoffBaseMs: 10,
    maxReconnectAttempts: 3,
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://edge/x', {});
  const firstPc = player.pc;
  firstPc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);

  // 掉线
  firstPc.setConnectionState('failed');
  assert.equal(player.state, WebRtcState.RECONNECTING);

  // 等待退避定时器完成重连（backoffBaseMs=10ms）
  for (let i = 0; i < 50 && player.state !== WebRtcState.CONNECTED; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (player.pc && player.pc !== firstPc && player.pc.connectionState === 'new') {
      player.pc.setConnectionState('connected'); // 驱动新 PC 连接成功
    }
  }
  assert.equal(player.state, WebRtcState.CONNECTED, `应重连成功，实际 ${player.state}`);
  assert.ok(player.channel.exchangedOffers.length >= 2);
  await player.destroy();
});

test('重连：超过上限进入 FAILED 并发布 error', async () => {
  const events = [];
  const channel = makeChannel(['ANSWER_1']); // 第二次起协商失败
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    signalChannel: channel,
    backoffBaseMs: 10,
    maxReconnectAttempts: 2,
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://edge/x', {});
  player.pc.setConnectionState('connected');
  player.pc.setConnectionState('disconnected'); // 触发第一次重连

  for (let i = 0; i < 100 && player.state !== WebRtcState.FAILED; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(player.state, WebRtcState.FAILED);
  assert.ok(events.some(([t]) => t === 'error'), '应有 error 事件');
  await player.destroy();
});

test('computeBackoffMs：指数增长、封顶与无抖动确定性', () => {
  const opts = { baseMs: 1000, capMs: 15000, jitterRatio: 0 };
  assert.equal(computeBackoffMs(0, opts), 1000);
  assert.equal(computeBackoffMs(1, opts), 2000);
  assert.equal(computeBackoffMs(2, opts), 4000);
  assert.equal(computeBackoffMs(10, opts), 15000, '封顶 capMs');
});

test('parsePlayerUrl：三种地址形态映射', () => {
  assert.deepEqual(parsePlayerUrl('https://a/b/whep'), { channelUrl: 'https://a/b/whep', kind: 'whep' });
  assert.deepEqual(parsePlayerUrl('wss://sig/x'), { channelUrl: 'wss://sig/x', kind: 'custom' });
  assert.deepEqual(parsePlayerUrl('webrtc://cdn.live/group/stream'), {
    channelUrl: 'https://cdn.live/group/stream/whep',
    kind: 'whep',
  });
  assert.throws(() => parsePlayerUrl('ftp://x'));
});

/* ---------------- getStats 提取 ---------------- */

function fakeReport(entries) {
  return entries; // extractMetrics 支持数组形态
}

test('extractMetrics：RTT/丢包/抖动/缓冲延迟提取', () => {
  const report = fakeReport([
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.037 },
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 1250000, packetsLost: 3, jitter: 0.012, framesDecoded: 240, framesDropped: 2, framesPerSecond: 30.1, jitterBufferDelay: 0.9, jitterBufferEmittedCount: 300 },
    { type: 'inbound-rtp', kind: 'audio', bytesReceived: 96000, packetsLost: 1, jitter: 0.004, jitterBufferDelay: 0.4, jitterBufferEmittedCount: 200 },
    { type: 'outbound-rtp', kind: 'video', bytesSent: 1 }, // 应被忽略
  ]);
  const m = extractMetrics(report, {});

  assert.equal(m.rttMs, 37);
  assert.equal(m.video.framesDecoded, 240);
  assert.equal(m.video.jitterMs, 12);
  // 播放端抖动缓冲平均驻留：0.9s / 300 帧 = 0.003s/帧 → 3ms
  assert.equal(m.video.bufferDelayMs, 3);

  assert.equal(m.audio.packetsLost, 1);
});

test('extractMetrics：差分码率需要两次采样（注入时钟）', () => {
  let t = 1000;
  const clock = () => (t += 2000); // 每次调用推进 2s
  const r1 = fakeReport([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 100000 }]);
  const m1 = extractMetrics(r1, {}, clock);
  assert.equal(m1.video.kbps, null, '首采样无 prev，kbps 为空');

  const r2 = fakeReport([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 350000 }]);
  const m2 = extractMetrics(r2, m1.nextPrev, clock);
  assert.equal(m2.video.kbps, 1000, '250KB/2s = 1000 kbps');

  const r3 = fakeReport([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 600000 }]);
  const m3 = extractMetrics(r3, m2.nextPrev, clock);
  assert.equal(m3.video.kbps, 1000, '再增 250KB/2s');
});

test('extractMetrics：remote-outbound-rtp 提供端到端延迟估计', () => {
  const sentAt = new Date(Date.now() - 200).toISOString();
  const m = extractMetrics(
    fakeReport([{ type: 'remote-outbound-rtp', remoteTimestamp: sentAt }]),
    {}
  );
  assert.ok(m.latencyEstimateMs >= 150 && m.latencyEstimateMs <= 5000, `估计值异常: ${m.latencyEstimateMs}`);
});
