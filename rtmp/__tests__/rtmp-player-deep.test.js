/**
 * WsFlvPlayer 深度补测（零网络，FakeWebSocket 注入）。
 *
 * 聚焦既有的 rtmp-player-fake.test.js 未覆盖的「纯调度」分支：
 *   - flushPending() 在尚未收到任何轨道（remuxer 未 ready）时为空操作、不回调 sink；
 *   - start() 在 PLAYING 态二次调用 → STATE_ERROR（除 CONNECTING 外的另一非法前驱）；
 *   - stop() 在未 start（IDLE）时直接转 STOPPED 且不抛错。
 *
 * 输入用程序化 serializeTag + makeAvcC 构造（与 flv-demuxer.test.js 同款），不依赖
 * FlvLoopSource 的 NALU 帧（其 Buffer 池别名导致跨分配非确定性，见上报缺陷）。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
import { flvFileHeader, serializeTag, makeAvcC } from '../../samples/gateway/src/index.js';

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
  send(d) {
    this.sent.push(d);
  }
  close(code, reason) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }
}

const RealWebSocket = globalThis.WebSocket;
before(() => {
  globalThis.WebSocket = FakeWebSocket;
});
after(() => {
  globalThis.WebSocket = RealWebSocket;
});
beforeEach(() => {
  FakeWebSocket.instances = [];
});

function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function feed(ws, buf) {
  ws.onmessage?.({ data: ab(buf) });
}
function join(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// 确定性 FLV 构造（不依赖 FlvLoopSource 的 NALU 帧）
const AVC_SEQ = () => join(Uint8Array.from([0x17, 0, 0, 0, 0]), makeAvcC());
const AVC_NALU = () => Uint8Array.from([0x17, 1, 0, 0, 0, 0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);
function flvInitAndFrames(frameCount = 3) {
  const tags = [flvFileHeader(), serializeTag(9, 0, AVC_SEQ())];
  for (let i = 0; i < frameCount; i++) tags.push(serializeTag(9, i * 33, AVC_NALU()));
  return join(...tags);
}

const BACKOFF = { baseMs: 30, factor: 1, maxMs: 30, jitter: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await sleep(5);
  }
}
const latest = () => FakeWebSocket.instances.at(-1);

test('flushPending 在尚无轨道（remuxer 未 ready）时为空操作，不回调 sink', async () => {
  const calls = { init: [], frag: [], sample: 0 };
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    sink: {
      onInitSegment: (b) => calls.init.push(b),
      onFragment: (b) => calls.frag.push(b),
      onSample: () => calls.sample++,
    },
  });

  // 构造后未 start 直接冲刷：ready=false → 直接 return
  assert.doesNotThrow(() => p.flushPending());
  assert.equal(calls.init.length, 0);
  assert.equal(calls.frag.length, 0);

  // 已连接但尚未收到 track（未喂 init）：依旧不应发 init
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  p.flushPending();
  assert.equal(calls.init.length, 0, '未配置轨道时不应发 init segment');
  assert.equal(calls.frag.length, 0);

  // 喂入 init+帧后轨道就绪，冲刷才生效（证明 ready 路径正常）
  feed(latest(), flvInitAndFrames(2));
  await until(() => calls.init.length >= 1, 2000);
  assert.equal(calls.init.length, 1, '配置轨道后新样本应触发 init');
  p.stop();
});

test('非法状态转移：PLAYING 态二次 start → STATE_ERROR（非 CONNECTING 的另一前驱）', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  feed(latest(), flvInitAndFrames(2));
  await until(() => p.state === PLAYER_STATES.PLAYING && p.stats.samples >= 1);

  await assert.rejects(
    () => p.start('ws-flv://gw/live/y'),
    (e) => e.code === 'STATE_ERROR' && /不能 start/.test(e.message),
    'PLAYING 态不应允许二次 start',
  );
  assert.equal(p.state, PLAYER_STATES.PLAYING, '被拒后状态不变');
  p.stop();
});

test('stop() 未 start（IDLE）→ 直接转 STOPPED 且不抛错', () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF });
  assert.equal(p.state, PLAYER_STATES.IDLE);
  assert.doesNotThrow(() => p.stop());
  assert.equal(p.state, PLAYER_STATES.STOPPED);
});
