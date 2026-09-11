/**
 * webrtc 补充单测：player.js 边界覆盖
 *  - parsePlayerUrl：空串/空白、webrtc:// 无路径、尾部斜杠、ws:// 自定义
 *  - WebRtcState 枚举完整性（6 个终态/非终态值）
 *  - 构造默认值：maxReconnectAttempts=5
 *  - destroy：置 CLOSED、_destroyed、清理资源、stats 归 null、videoEl.srcObject 清空
 *  - trickle：_addIceCandidate 注入候选走 pc.addIceCandidate
 *  - 重连途中 destroy：定时器被清除，不再发起新协商
 * 全部注入 RTCPeerConnection mock，零真实浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebRtcPlayer,
  WebRtcState,
  parsePlayerUrl,
} from '../src/player.js';

/* ---------------- 可控 PC mock ---------------- */

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this._l = new Map();
    this.added = [];
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    const prev = this.iceGatheringState;
    this.iceGatheringState = 'complete';
    // 仅在采集状态「发生转移」时派发，与真实 RTCPeerConnection 一致；
    // 否则 finish() 递归调用 setLocalDescription 会形成无限循环。
    // 键名必须匹配 player.js 注册的 'icegatheringstatechange'（此前误用 'ig'，导致监听永不触发、3s 兜底必走）。
    if (prev !== 'complete') {
      for (const f of this._l.get('icegatheringstatechange') || []) f();
    }
  }
  addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); }
  removeEventListener() {}
  async setRemoteDescription() {}
  async addIceCandidate(c) { this.added.push(c); }
  async getStats() { return []; }
  close() { this.connectionState = 'closed'; }
  setConnectionState(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

function makeChannel(answers = ['A']) {
  let i = 0;
  return {
    connected: 0,
    exchangedOffers: [],
    closed: 0,
    drained: 0,
    drainRemoteCandidates: () => [],
    async connect() { this.connected += 1; },
    async exchange(offer) {
      this.exchangedOffers.push(offer);
      return { sdp: answers[Math.min(i, answers.length - 1)] };
    },
    async close() { this.closed += 1; },
  };
}

/* ---------------- parsePlayerUrl 形态 ---------------- */

test('parsePlayerUrl：空串/空白抛错、webrtc:// 无路径与尾部斜杠、ws:// 自定义', () => {
  assert.throws(() => parsePlayerUrl(''), /非空字符串/);
  assert.throws(() => parsePlayerUrl('   '), /非空字符串/);
  assert.deepEqual(parsePlayerUrl('webrtc://cdn.live'), { channelUrl: 'https://cdn.live/whep', kind: 'whep' });
  assert.deepEqual(parsePlayerUrl('webrtc://cdn.live/app/'), { channelUrl: 'https://cdn.live/app/whep', kind: 'whep' });
  assert.deepEqual(parsePlayerUrl('ws://sig.example.com/live'), { channelUrl: 'ws://sig.example.com/live', kind: 'custom' });
});

/* ---------------- WebRtcState 枚举 ---------------- */

test('WebRtcState：枚举冻结且含 6 个状态值', () => {
  assert.equal(Object.isFrozen(WebRtcState), true);
  assert.deepEqual(Object.values(WebRtcState).sort(), [
    'closed', 'connected', 'connecting', 'failed', 'idle', 'reconnecting',
  ]);
});

/* ---------------- 构造默认值 ---------------- */

test('WebRtcPlayer：maxReconnectAttempts 默认 5，stats 初始 null', () => {
  const p = new WebRtcPlayer();
  assert.equal(p.maxReconnectAttempts, 5);
  assert.equal(p.stats, null);
});

/* ---------------- destroy 行为 ---------------- */

test('WebRtcPlayer：destroy 后状态 CLOSED、资源清理、stats 归 null', async () => {
  const videoEl = { srcObject: null, pause() {} };
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', { video: videoEl });
  const pc = player.pc;
  pc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);
  await new Promise((r) => setTimeout(r, 5)); // 等待 StatsCollector.tick 异步落地 latest
  assert.notEqual(player.stats, null, '连接后启动采集器，stats 非空');

  const channel = player.channel;
  await player.destroy();
  assert.equal(player.state, WebRtcState.CLOSED);
  assert.equal(player._destroyed, true);
  assert.equal(channel.closed, 1, 'destroy 通知服务端释放（close 调用一次）');
  assert.equal(player.stats, null, '销毁后采集器置空');
  assert.equal(player.pc, null, 'pc 已 teardown');
  assert.equal(videoEl.srcObject, null, 'video 元素 srcObject 清空');
});

/* ---------------- trickle 候选注入 ---------------- */

test('WebRtcPlayer：_addIceCandidate 经 pc.addIceCandidate 注入', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(),
  });
  await player.play('https://e/whep', {});
  const cand = { candidate: 'candidate:1 1 UDP 1 1.2.3.4 5 typ host', sdpMid: '0' };
  await player._addIceCandidate(cand);
  assert.equal(player.pc.added.length, 1);
  assert.deepEqual(player.pc.added[0], cand);
});

test('WebRtcPlayer：_addIceCandidate 失败时仅发 warn 不抛', async () => {
  class BadPC extends FakePC {
    async addIceCandidate() { throw new Error('bad candidate'); }
  }
  const events = [];
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: BadPC,
    signalChannel: makeChannel(),
    onEvent: (t, p) => events.push([t, p]),
  });
  await player.play('https://e/whep', {});
  await player._addIceCandidate({ candidate: 'x' });
  assert.ok(events.some(([t]) => t === 'warn'), '候选失败应发 warn，不抛异常');
});

/* ---------------- 重连途中 destroy ---------------- */

test('WebRtcPlayer：重连排程途中 destroy，定时器被取消不再重连', async () => {
  const player = new WebRtcPlayer({
    RTCPeerConnectionImpl: FakePC,
    signalChannel: makeChannel(['A']),
    backoffBaseMs: 200, // 较长退避，确保测试窗口内不自然触发
    maxReconnectAttempts: 3,
  });
  await player.play('https://e/whep', {});
  const firstPc = player.pc;
  firstPc.setConnectionState('connected');
  assert.equal(player.state, WebRtcState.CONNECTED);

  // 触发掉线 → 进入 RECONNECTING 并排程重连定时器
  firstPc.setConnectionState('failed');
  assert.equal(player.state, WebRtcState.RECONNECTING);
  const offersBeforeDestroy = player.channel.exchangedOffers.length;

  // 立刻销毁：应清除重连定时器
  await player.destroy();
  assert.equal(player.state, WebRtcState.CLOSED);

  // 等待原本退避窗口过去，断言未再发起协商
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(player.channel.exchangedOffers.length, offersBeforeDestroy, 'destroy 后不应再 exchange');
  assert.equal(player.pc, null, '重连创建的 pc 不应存在');
});
