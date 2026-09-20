/**
 * rtmp-player-gaps.test.js —— WsFlvPlayer 残余分支补测（wave 141）
 *
 * 覆盖：
 *   - demuxer 'track'（video）：setVideoTrack 抛错 → #fail（ERROR 态 + error 事件）；
 *   - demuxer 'track'（audio）：正常路径（audioTrack 赋值 / mediaInfo.tracks / 启动冲刷循环）
 *     与 setAudioTrack 抛错路径（原型注入，finally 还原）；
 *   - demuxer 'sample'：addSample 抛错 → #fail；
 *   - #onStable：稳定运行超过 stableMs 后复位退避节奏（_backoffAttempt 归零）。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
import { Fmp4Remuxer } from '../src/mp4-mux.js';
import { FlvLoopSource } from '../../samples/gateway/src/index.js';

/* ------------------------------------------------------------------ FakeWS */

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.binaryType = '';
    this.readyState = 0;
    this.sent = [];
    this.onopen = this.onerror = this.onclose = this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }
}
const RealWebSocket = globalThis.WebSocket;
before(() => { globalThis.WebSocket = FakeWebSocket; });
after(() => { globalThis.WebSocket = RealWebSocket; });
beforeEach(() => { FakeWebSocket.instances = []; });

function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function feed(ws, buf) { ws.onmessage?.({ data: ab(buf) }); }
function join(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function initAndFrames(n = 3) {
  const src = new FlvLoopSource({ frameCount: Math.max(n, 1) });
  return { init: src.initChunk(), frames: join(src.take(n)) };
}
const latest = () => FakeWebSocket.instances.at(-1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 临时替换原型方法抛错，finally 还原 */
async function withThrowingProto(methodName, message, fn) {
  const original = Fmp4Remuxer.prototype[methodName];
  Fmp4Remuxer.prototype[methodName] = () => { throw new Error(message); };
  try { return await fn(); } finally { Fmp4Remuxer.prototype[methodName] = original; }
}

const AUDIO_TRACK = {
  kind: 'audio', codec: 'mp4a.40.2', codecString: 'mp4a.40.2',
  sampleRate: 48000, numberOfChannels: 2, description: Uint8Array.from([0x12, 0x10]),
};

test('track(video)：setVideoTrack 抛错 → #fail ERROR 态', async () => {
  const p = new WsFlvPlayer({ flushIntervalMs: 40 });
  const errorsGot = [];
  p.on('error', (e) => errorsGot.push(e));
  await withThrowingProto('setVideoTrack', 'inject: bad video track', async () => {
    const pr = p.start('ws-flv://gw/live/x');
    latest()._open();
    await pr;
    const { init, frames } = initAndFrames(1);
    feed(latest(), join([init, frames]));
    await sleep(30);
  });
  assert.equal(p.state, PLAYER_STATES.ERROR);
  assert.ok(errorsGot.some((e) => e.message.includes('inject: bad video track')));
  p.stop();
});

test('track(audio)：正常路径赋值 audioTrack 并入 mediaInfo.tracks + 启动冲刷循环', async () => {
  const p = new WsFlvPlayer({ flushIntervalMs: 40 });
  const tracks = [];
  p.on('track', (t) => tracks.push(t));
  try {
    const pr = p.start('ws-flv://gw/live/x');
    latest()._open();
    await pr;
    const { init } = initAndFrames(1);
    feed(latest(), init); // 先建 video 轨（remuxer ready）
    await sleep(20);
    assert.ok(p._flushTimer, 'video 轨事件后冲刷循环应已启动');
    p._demuxer.emit('track', AUDIO_TRACK);
    await sleep(20);
    assert.ok(p.audioTrack, 'audioTrack 应被赋值');
    assert.ok(tracks.some((t) => t.kind === 'audio'));
    assert.ok(p.mediaInfo.tracks.some((t) => t.kind === 'audio'), 'mediaInfo.tracks 应含 audio');
    assert.ok(p._flushTimer, '冲刷循环应已启动');
  } finally {
    p.stop();
  }
});

test('track(audio)：setAudioTrack 抛错 → #fail ERROR 态', async () => {
  const p = new WsFlvPlayer({ flushIntervalMs: 40 });
  const errorsGot = [];
  p.on('error', (e) => errorsGot.push(e));
  await withThrowingProto('setAudioTrack', 'inject: bad audio track', async () => {
    const pr = p.start('ws-flv://gw/live/x');
    latest()._open();
    await pr;
    p._demuxer.emit('track', AUDIO_TRACK);
    await sleep(20);
  });
  assert.equal(p.state, PLAYER_STATES.ERROR);
  assert.ok(errorsGot.some((e) => e.message.includes('inject: bad audio track')));
  p.stop();
});

test('sample：addSample 抛错 → #fail ERROR 态', async () => {
  const p = new WsFlvPlayer({ flushIntervalMs: 40 });
  const errorsGot = [];
  p.on('error', (e) => errorsGot.push(e));
  await withThrowingProto('addSample', 'inject: bad sample', async () => {
    const pr = p.start('ws-flv://gw/live/x');
    latest()._open();
    await pr;
    const { init, frames } = initAndFrames(1);
    feed(latest(), join([init, frames]));
    await sleep(30);
  });
  assert.equal(p.state, PLAYER_STATES.ERROR);
  assert.ok(errorsGot.some((e) => e.message.includes('inject: bad sample')));
  p.stop();
});

test('#onStable：稳定运行超过 stableMs 后复位退避节奏', async () => {
  const p = new WsFlvPlayer({ stableMs: 30, flushIntervalMs: 40 });
  try {
    const pr = p.start('ws-flv://gw/live/x');
    p._backoffAttempt = 3; // 模拟此前经历过多轮重连
    latest()._open();
    await pr;
    const { init, frames } = initAndFrames(1);
    feed(latest(), join([init, frames])); // 首数据 → PLAYING + #onStable
    assert.equal(p.state, PLAYER_STATES.PLAYING);
    assert.equal(p._backoffAttempt, 3);
    await sleep(80);
    assert.equal(p._backoffAttempt, 0, 'stableMs 后退避节奏应复位');
  } finally {
    p.stop();
  }
});
