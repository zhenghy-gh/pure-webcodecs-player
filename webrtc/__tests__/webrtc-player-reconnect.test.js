/**
 * webrtc 补充单测：player.js 状态机 / 重连 / destroy 深水区（未覆盖分支）
 *  - _waitForIceGathering：iceGatheringState 初始即 complete → 直接 setLocalDescription，不设兜底定时器
 *  - onconnectionstatechange 'closed'：非 destroyed 且非终态时迁移到 CLOSED
 *  - _scheduleReconnect 早退：state 为 FAILED / CLOSED 时不排程、不发 reconnecting 事件
 *  - _scheduleReconnect 自迁移守卫：已在 RECONNECTING 时再次掉线不重复发 statechange
 *  - _addIceCandidate：pc 已被 teardown 为 null 时（post-destroy）走可选链短路，不抛错
 *  - destroy：从未 play、channel 为 null 时仍安全进入 CLOSED
 *  - 重连定时器回调内 _connect 抛错 → 发 warn 事件并再次 _scheduleReconnect
 * 全部注入 RTCPeerConnection mock + signalChannel，零真实浏览器 / 零网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcPlayer, WebRtcState } from '../src/player.js';

/* ---------------- FakePC（可控，记录关键调用） ---------------- */

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this._listeners = new Map();
    this._setLocalCalls = 0;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async setLocalDescription(d) {
    this._setLocalCalls += 1;
    this.localDescription = d;
    const prev = this.iceGatheringState;
    this.iceGatheringState = 'complete';
    // 真实 RTCPeerConnection 仅在采集状态「发生转移」时派发事件，避免 finish() 递归调用时无限触发
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

function makeChannel(answers = ['A'], throwAfter = Infinity) {
  let i = 0;
  return {
    connected: 0,
    exchangedOffers: [],
    closed: 0,
    drainRemoteCandidates: () => [],
    async connect() { this.connected += 1; },
    async exchange(offer) {
      this.exchangedOffers.push(offer);
      if (i >= throwAfter) throw new Error('协商失败（模拟服务端不可用）');
      const sdp = answers[Math.min(i, answers.length - 1)];
      i += 1;
      return { sdp };
    },
    async close() { this.closed += 1; },
  };
}

/* ---------------- _waitForIceGathering 即时完成分支 ---------------- */

test('_waitForIceGathering：iceGatheringState 初始 complete 直接 setLocalDescription，不设兜底定时器', async () => {
  // 构造一个初始即 complete 的 PC
  class PreGatheredPC extends FakePC {
    constructor() { super(); this.iceGatheringState = 'complete'; }
  }
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: PreGatheredPC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', {});
  const pc = player.pc;
  // 走的是 `if (iceGatheringState === 'complete') return pc.setLocalDescription(offer)` 分支
  assert.equal(pc._setLocalCalls, 1, '仅调用一次 setLocalDescription');
  assert.equal(pc.localDescription.sdp, 'OFFER');
  // 未注册 icegatheringstatechange 兜底监听（即时分支不进入 Promise 体）
  assert.equal(pc._listeners.get('icegatheringstatechange')?.length ?? 0, 0);
  await player.destroy();
});

/* ---------------- onconnectionstatechange 'closed' 迁移 ---------------- */

test('onconnectionstatechange：pc 报告 closed（未销毁）应迁移到 CLOSED', async () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A']),
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://e/whep', {});
  player.pc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);

  // pc 直接 closed（非我们主动 destroy）
  player.pc.setConnectionState('closed');
  assert.equal(player.state, WebRtcState.CLOSED, 'pc closed 应迁移 CLOSED');
  assert.equal(player._destroyed, false, '非主动销毁');
  // 该分支不发 connectionlost（那是 failed/disconnected 分支）
  assert.ok(!events.some(([t]) => t === 'connectionlost'));
  await player.destroy();
});

/* ---------------- _scheduleReconnect 早退：FAILED ---------------- */

test('_scheduleReconnect：state 已为 FAILED 时直接早退，不排程、不发事件', () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
    backoffBaseMs: 50,
    onEvent: (t, p) => events.push([t, p]),
  });
  player.state = WebRtcState.FAILED; // 强制终态
  player._scheduleReconnect();
  assert.equal(player._reconnectTimer, null, '不应设置重连定时器');
  assert.ok(!events.some(([t]) => t === 'reconnecting'), '不应发 reconnecting 事件');
});

test('_scheduleReconnect：state 已为 CLOSED 时直接早退，不排程', () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
    onEvent: (t, p) => events.push([t, p]),
  });
  player.state = WebRtcState.CLOSED;
  player._scheduleReconnect();
  assert.equal(player._reconnectTimer, null);
  assert.ok(!events.some(([t]) => t === 'reconnecting'));
});

/* ---------------- _scheduleReconnect 自迁移守卫 ---------------- */

test('_scheduleReconnect：已在 RECONNECTING 时再次掉线不重复发 statechange，仅累加 attempt', async () => {
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A', 'A']),
    backoffBaseMs: 5,
    maxReconnectAttempts: 20,
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://e/whep', {});
  const pc = player.pc;
  pc.setConnectionState('connected');
  pc.setConnectionState('failed'); // 第一次掉线 → RECONNECTING（attempt 1）
  assert.equal(player.state, WebRtcState.RECONNECTING);

  // 同一 pc 在 RECONNECTING 期间再次掉线：守卫应跳过重复 _setState
  pc.setConnectionState('failed');
  const toReconnecting = events.filter(
    ([t, p]) => t === 'statechange' && p.to === 'reconnecting'
  );
  assert.equal(toReconnecting.length, 1, '只应发一次到 RECONNECTING 的 statechange');
  const reconnectEvents = events.filter(([t]) => t === 'reconnecting');
  assert.equal(reconnectEvents.length, 2, '两次掉线各发一次 reconnecting');
  assert.equal(reconnectEvents[1][1].attempt, 2);
  assert.equal(player._reconnectAttempts, 2);

  // 立即销毁，避免定时器自然触发
  await player.destroy();
});

/* ---------------- _addIceCandidate：pc 为 null（post-destroy） ---------------- */

test('_addIceCandidate：pc 已 teardown 为 null 时不抛错、不调用 addIceCandidate', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', {});
  assert.ok(player.pc, 'play 后 pc 存在');
  await player.destroy();
  assert.equal(player.pc, null, 'destroy 后 pc 为 null');
  // pc 为 null，走 this.pc?.addIceCandidate 短路
  await assert.doesNotReject(
    () => player._addIceCandidate({ candidate: 'c1', sdpMid: '0' }),
    'pc 为 null 时不应抛错'
  );
});

/* ---------------- destroy：从未 play（channel 为 null） ---------------- */

test('destroy：构造时未注入 signalChannel 且从未 play，仍安全进入 CLOSED', async () => {
  const player = new WebRtcPlayer({ RTCPeerConnectionImpl: FakePC });
  assert.equal(player.channel, null);
  assert.equal(player.state, WebRtcState.IDLE);
  await assert.doesNotReject(() => player.destroy(), '无 channel / 未 play 应安全销毁');
  assert.equal(player.state, WebRtcState.CLOSED);
  assert.equal(player._destroyed, true);
  assert.equal(player.pc, null);
});

/* ---------------- 重连定时器回调内 _connect 抛错 → warn + 再排程 ---------------- */

test('重连定时器触发后 _connect 抛错：发 warn 事件并再次 _scheduleReconnect', async () => {
  const events = [];
  // throwAfter=1：首次协商成功（play 用 answers[0]），后续重连协商全部抛错
  const channel = makeChannel(['A'], 1);
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: channel,
    backoffBaseMs: 5,
    maxReconnectAttempts: 50,
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://e/whep', {});
  const firstPc = player.pc;
  firstPc.setConnectionState('connected');
  firstPc.setConnectionState('failed'); // 进入 RECONNECTING 并开始退避排程

  // 等待退避定时器触发 → 新建 pc → exchange 抛错 → catch 发 warn
  await new Promise((r) => setTimeout(r, 60));

  const warns = events.filter(([t, p]) => t === 'warn' && /重连失败/.test(p.message));
  assert.ok(warns.length >= 1, '应发「重连失败」warn 事件');
  // 定时器触发后确实新建过第二个 pc 并再次发起 exchange（play 的 1 次 + 重连的 1 次）
  assert.ok(channel.exchangedOffers.length >= 2, '重连应再次发起协商');

  await player.destroy();
});
