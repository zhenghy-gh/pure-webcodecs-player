/**
 * webrtc 补充单测：player.js 主路径深水区
 *  - WebRtcState 完整合法迁移矩阵
 *  - destroy 幂等：调用两次、调用前未 play
 *  - destroy 后 play：state=CLOSED 时 _destroyed 被重置但迁移非法应抛
 *  - play 在 CONNECTING 中掉线直接走 RECONNECTING（不走 CONNECTED）
 *  - 缺失 PCImpl 时 play 抛 notSupported
 *  - pause/resume 在未 play 时不抛错
 *  - parsePlayerUrl：stun:/turn:/IP 主机/IPv6/null/undefined
 *  - drainRemoteCandidates 真实候选经 _addIceCandidate 注入 PC
 *  - reconnect 定时器在重连回调中再次 destroy 被安全短路
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebRtcPlayer,
  WebRtcState,
  parsePlayerUrl,
} from '../src/player.js';
import { ErrorCode } from '../../core/src/errors.js';

/* ---------------- FakePC（足够驱动全部路径） ---------------- */

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this._listeners = new Map();
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.added = [];
    this.closeCount = 0;
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.iceGatheringState = 'complete';
    for (const f of this._listeners.get('icegatheringstatechange') || []) f();
  }
  addEventListener(t, f) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(f); }
  removeEventListener(t, f) {
    const list = this._listeners.get(t) || [];
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
  }
  async setRemoteDescription() {}
  async addIceCandidate(c) { this.added.push(c); }
  async getStats() { return []; }
  close() { this.closeCount += 1; this.connectionState = 'closed'; }
  setConnectionState(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

function makeChannel(answers = ['A'], remoteCandidates = []) {
  let i = 0;
  return {
    connected: 0,
    exchangedOffers: [],
    closed: 0,
    _candidates: remoteCandidates.slice(),
    drainRemoteCandidates() {
      const out = this._candidates;
      this._candidates = [];
      return out;
    },
    async connect() { this.connected += 1; },
    async exchange(offer) {
      this.exchangedOffers.push(offer);
      return { sdp: answers[Math.min(i, answers.length - 1)] };
    },
    async close() { this.closed += 1; },
  };
}

/* ---------------- WebRtcState 迁移矩阵 ---------------- */

test('WebRtcState：合法迁移表覆盖所有源状态的去向', () => {
  // 抄一份预期迁移表与实现对照
  const expected = {
    idle: ['connecting', 'closed'],
    connecting: ['connected', 'reconnecting', 'failed', 'closed'],
    connected: ['reconnecting', 'failed', 'closed'],
    reconnecting: ['connecting', 'connected', 'reconnecting', 'failed', 'closed'],
    failed: ['connecting', 'closed'],
    closed: [],
  };
  // 用反射从 player.js 取出私有表（每个源 → 实际能迁移到）
  const player = new WebRtcPlayer({ RTCPeerConnectionImpl: FakePC });
  for (const [from, targets] of Object.entries(expected)) {
    for (const to of targets) {
      // 强制把 state 改到 from（绕过构造）
      player.state = from;
      assert.doesNotThrow(
        () => player._setState(to),
        `${from} → ${to} 应合法`
      );
    }
    // 未列出的迁移必须抛
    const allStates = Object.values(WebRtcState);
    for (const to of allStates) {
      if (targets.includes(to)) continue;
      if (to === from) continue; // 同状态：不通过 _setState 测
      player.state = from;
      assert.throws(
        () => player._setState(to),
        /非法状态迁移/,
        `${from} → ${to} 应非法`
      );
    }
  }
});

test('WebRtcState：CLOSED 为终态，任何迁移均抛错', () => {
  const player = new WebRtcPlayer({ RTCPeerConnectionImpl: FakePC });
  player.state = WebRtcState.CLOSED;
  for (const to of Object.values(WebRtcState)) {
    assert.throws(() => player._setState(to), /非法状态迁移/);
  }
});

/* ---------------- destroy 幂等与边界 ---------------- */

test('destroy：未 play 直接 destroy 应安全进入 CLOSED 且无资源引用', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  assert.equal(player.state, WebRtcState.IDLE);
  await player.destroy();
  assert.equal(player.state, WebRtcState.CLOSED);
  assert.equal(player._destroyed, true);
  assert.equal(player.pc, null);
  assert.equal(player.channel.closed, 1);
});

test('destroy：连续两次调用不抛错（幂等）', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', {});
  await player.destroy();
  // 第二次 destroy 仍然 resolve 且 pc 已 null
  await assert.doesNotReject(() => player.destroy());
  assert.equal(player.state, WebRtcState.CLOSED);
  assert.equal(player.pc, null);
});

test('destroy 后 play：_destroyed 被重置但 CLOSED→CONNECTING 非法应抛 stateError', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.destroy();
  assert.equal(player.state, WebRtcState.CLOSED);
  await assert.rejects(
    () => player.play('https://e/whep', {}),
    (e) => {
      assert.equal(e.code, ErrorCode.STATE_ERROR);
      assert.match(e.message, /非法状态迁移/);
      return true;
    }
  );
});

/* ---------------- CONNECTING 期掉线走 RECONNECTING ---------------- */

test('CONNECTING 中掉线（未达 connected）应进入 RECONNECTING 而非 FAILED', async () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A']),
    backoffBaseMs: 5,
    maxReconnectAttempts: 10,
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://e/whep', {});
  assert.equal(player.state, WebRtcState.CONNECTING);
  // 协商尚未完成时连接状态变 failed —— 应走重连而非直 FAILED
  player.pc.setConnectionState('failed');
  assert.equal(player.state, WebRtcState.RECONNECTING);
  // reconnecting 事件已发，且包含 attempt/delayMs
  const reconnecting = events.find(([t]) => t === 'reconnecting');
  assert.ok(reconnecting, '应发 reconnecting 事件');
  assert.equal(reconnecting[1].attempt, 1);
  assert.ok(typeof reconnecting[1].delayMs === 'number');
  // 关键断言：此刻没有 fatal error（state 仍 RECONNECTING 而非 FAILED）
  assert.ok(!events.some(([t]) => t === 'error' && t[1]?.fatal));
});

/* ---------------- play 在缺失 PCImpl 时抛错 ---------------- */

test('play：当前环境无 RTCPeerConnection（未注入）抛 notSupported', async () => {
  const saved = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  try {
    const player = new WebRtcPlayer({ signalChannel: makeChannel() });
    await assert.rejects(
      () => player.play('https://e/whep', {}),
      (e) => {
        assert.equal(e.code, ErrorCode.NOT_SUPPORTED);
        return true;
      }
    );
  } finally {
    globalThis.RTCPeerConnection = saved;
  }
});

/* ---------------- pause / resume 在未 play 时不抛 ---------------- */

test('pause / resume：在未 play 时调用不抛错且不报错', () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  assert.doesNotThrow(() => player.pause());
  assert.doesNotThrow(() => player.resume());
});

/* ---------------- parsePlayerUrl 扩展形态 ---------------- */

test('parsePlayerUrl：stun:/turn: 等非白名单 scheme 一律抛错', () => {
  // 这些不在 http/ws/webrtc 协议分支，正则不匹配 → 落到末尾 parseError
  assert.throws(() => parsePlayerUrl('stun:stun.l.google.com:19302'), /无法识别的/);
  assert.throws(() => parsePlayerUrl('turn:turn.example.com:3478'), /无法识别的/);
  assert.throws(() => parsePlayerUrl('ftp://x/y'), /无法识别的/);
  assert.throws(() => parsePlayerUrl('rtsp://x/y'), /无法识别的/);
});

test('parsePlayerUrl：非字符串 / null / undefined 一律抛错', () => {
  assert.throws(() => parsePlayerUrl(null), /非空字符串/);
  assert.throws(() => parsePlayerUrl(undefined), /非空字符串/);
  assert.throws(() => parsePlayerUrl(42), /非空字符串/);
  assert.throws(() => parsePlayerUrl({}), /非空字符串/);
});

test('parsePlayerUrl：webrtc:// 支持 IPv6 主机（带端口）', () => {
  // 主机段只要求 [^/]+，所以 IPv6 字面量可整体作为 host（不参与 URL 解析）
  const r = parsePlayerUrl('webrtc://[::1]:8443/live/cam1');
  assert.equal(r.kind, 'whep');
  assert.equal(r.channelUrl, 'https://[::1]:8443/live/cam1/whep');
});

test('parsePlayerUrl：webrtc:// 支持裸 IP 主机', () => {
  const r = parsePlayerUrl('webrtc://192.168.1.10:8443/app/stream');
  assert.equal(r.kind, 'whep');
  assert.equal(r.channelUrl, 'https://192.168.1.10:8443/app/stream/whep');
});

test('parsePlayerUrl：webrtc:// 仅有主机（无路径）应映射为 https://host/whep', () => {
  const r = parsePlayerUrl('webrtc://edge.example.com');
  assert.deepEqual(r, { channelUrl: 'https://edge.example.com/whep', kind: 'whep' });
});

/* ---------------- trickle 候选经 channel.drainRemoteCandidates 注入 PC ---------------- */

test('drainRemoteCandidates 真实候选经 _addIceCandidate 注入 pc.addIceCandidate', async () => {
  const remoteCands = [
    { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.4 61665 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    { candidate: 'candidate:2 1 UDP 1694498815 203.0.113.5 54321 typ srflx raddr 192.168.1.4 rport 61665', sdpMid: '1', sdpMLineIndex: 1 },
  ];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A'], remoteCands),
  });
  await player.play('https://e/whep', {});
  // _connect 调用了 drainRemoteCandidates → 经 _addIceCandidate 落入 pc
  assert.equal(player.pc.added.length, 2);
  assert.equal(player.pc.added[0].sdpMid, '0');
  assert.equal(player.pc.added[1].sdpMid, '1');
  // drainRemoteCandidates 在 connect 后应清空
  assert.equal(player.channel._candidates.length, 0);
});

/* ---------------- 重连回调内 destroy 应被安全短路 ---------------- */

test('重连定时器回调内 _destroyed 已置 true 应直接返回，不再 exchange', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A', 'A']),
    backoffBaseMs: 5,
    maxReconnectAttempts: 5,
  });
  await player.play('https://e/whep', {});
  const firstPc = player.pc;
  firstPc.setConnectionState('connected');
  firstPc.setConnectionState('failed');
  // 极小窗口内立刻 destroy，定时器触发时 _destroyed=true 直接 return
  await player.destroy();
  await new Promise((r) => setTimeout(r, 40));
  // exchange 仅首次成功的那一次，destroy 后 0 次
  assert.equal(player.channel.exchangedOffers.length, 1);
  assert.equal(player.pc, null);
});
