/**
 * play() 无预置 signalChannel → createSignalChannel 工厂分支（第二百零三波）
 * ------------------------------------------------------------
 * player.js 145-146：构造时不给 signalChannel，play(ws://…) 应按 URL 工厂建通道。
 * 用抛错 WebSocket stub 让 _connect 在 channel.connect() 处快速失败：
 * 只验证通道已按 URL 创建（工厂调用即覆盖），后续连接失败属 signaling 模块职责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebRtcPlayer } from '../src/player.js';
import { WebSocketSignal } from '../src/signaling.js';

class FakePC {
  constructor() {
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this._listeners = new Map();
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.iceGatheringState = 'complete';
    for (const f of this._listeners.get('icegatheringstatechange') || []) f();
  }
  addEventListener(t, f) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(f);
  }
  removeEventListener(t, f) {
    const list = this._listeners.get(t) || [];
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
  }
  async setRemoteDescription() {}
  close() {}
}

/** 临时替换 globalThis.WebSocket（描述符还原） */
async function withWebSocket(stub, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  try {
    Object.defineProperty(globalThis, 'WebSocket', { value: stub, configurable: true, writable: true });
    return await fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'WebSocket', desc);
    else delete globalThis.WebSocket;
  }
}

test('play：未注入 signalChannel 时按 ws:// URL 工厂创建 WebSocketSignal', async () => {
  function BoomSocket() {
    throw new Error('socket-boom');
  }
  const player = new WebRtcPlayer({ RTCPeerConnectionImpl: FakePC });
  await withWebSocket(BoomSocket, async () => {
    await assert.rejects(
      () => player.play('ws://sig.example/live'),
      /socket-boom/,
    );
  });
  assert.ok(player.channel instanceof WebSocketSignal, '145-146 工厂分支应已建通道');
  assert.equal(player.channel.url, 'ws://sig.example/live');
  player.destroy();
});

test('play：已有 channel 时不重复工厂（保持注入引用）', async () => {
  const sentinel = { async connect() {}, async exchange() { return { sdp: 'A' }; } };
  const player = new WebRtcPlayer({ RTCPeerConnectionImpl: FakePC, signalChannel: sentinel });
  await player.play('ws://sig.example/live');
  assert.equal(player.channel, sentinel);
  player.destroy();
});
