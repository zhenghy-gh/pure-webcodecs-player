/**
 * WsFlvPlayer 状态机 / 生命周期 / 重连恢复 正向管线（零网络）。
 *
 * 注入点：player 直接 `new GatewayChunkSource(...)`，而后者仅依赖全局 `WebSocket`；
 * 故用可驱动的 FakeWebSocket 替换 globalThis.WebSocket，并以网关同款纯字节构建器
 * （FlvLoopSource：FLV 头 + AVC 序列头 + onMetaData + NALU Tag）喂流。
 * 覆盖：状态迁移链、事件与 stats、sink 接线/冲刷、非法转移、stop 幂等与复用、
 * 断线重连续流、重连上限 error、首数据超时 TIMEOUT、解析错误降级 warn。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
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
  serverClose(code = 1006, reason = 'gone') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
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

/** Buffer/Uint8Array → 独立 ArrayBuffer（模拟真实 WebSocket 的 arraybuffer 交付） */
function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
/** 向最新连接投递 FLV 字节 */
function feed(ws, buf) {
  ws.onmessage?.({ data: ab(buf) });
}
/** 拼合 FLV 分块 */
function join(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
/** 生成 init（头+配置）与 n 帧的完整字节流 */
function initAndFrames(n = 5) {
  const src = new FlvLoopSource({ frameCount: Math.max(n, 1) });
  return { init: src.initChunk(), frames: join(src.take(n)) };
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

/* ------------------------------------------------------------------- tests */

test('生命周期：idle→connecting→playing→stopped，open/metadata/track/sample 全链路 + stats', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  const states = [];
  const got = { open: null, metadata: null, tracks: [], samples: [], signaling: [] };
  p.on('statechange', ({ from, to }) => states.push(`${from}->${to}`));
  p.on('open', (h) => (got.open = h));
  p.on('metadata', (m) => (got.metadata = m));
  p.on('track', (t) => got.tracks.push(t));
  p.on('sample', (s) => got.samples.push(s));
  p.on('signaling', (m) => got.signaling.push(m));

  assert.equal(p.state, PLAYER_STATES.IDLE);
  const pr = p.start('ws-flv://gw/live/x');
  assert.equal(p.state, PLAYER_STATES.CONNECTING, 'start 同步即进入 connecting');
  latest()._open();
  await pr;

  // 文本信令透传
  latest().onmessage?.({ data: JSON.stringify({ type: 'meta', container: 'flv' }) });
  assert.equal(got.signaling.length, 1);

  const { init, frames } = initAndFrames(5);
  feed(latest(), init);
  assert.equal(p.state, PLAYER_STATES.PLAYING, '首个二进制分块后进入 playing');
  assert.equal(got.open.hasVideo, true);
  assert.equal(p.mediaInfo.container, 'flv');
  assert.equal(p.mediaInfo.live, true);
  assert.equal(p.mediaInfo.seekable, false);
  assert.equal(got.metadata.width, 16);
  assert.equal(got.tracks[0].kind, 'video');
  assert.equal(got.tracks[0].codec, 'h264');
  assert.equal(p.videoTrack.codecString, 'avc1.42c01e');

  feed(latest(), frames);
  assert.equal(got.samples.length, 5);
  assert.equal(p.stats.samples, 5);
  assert.equal(p.stats.connects, 1);
  assert.ok(p.stats.bytesIn >= init.length + frames.length);
  assert.equal(Number.isInteger(got.samples[0].dtsUs), true);
  assert.ok(got.samples[0].keyframe);

  // tracksSnapshot 只暴露公开字段
  const snap = p.tracksSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].kind, 'video');
  assert.equal(snap[0].width, 16);
  assert.equal(snap[0].description, undefined, '快照不应泄露大字段 description');

  p.stop();
  assert.equal(p.state, PLAYER_STATES.STOPPED);
  assert.deepEqual(states, ['idle->connecting', 'connecting->playing', 'playing->stopped']);
});

test('非法状态转移：连接中二次 start → STATE_ERROR；非法 URL → TypeError 且状态不变', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF });
  const first = p.start('ws-flv://gw/live/x');
  await assert.rejects(
    () => p.start('ws-flv://gw/live/y'),
    (e) => e.code === 'STATE_ERROR',
  );
  latest()._open();
  await first;

  const q = new WsFlvPlayer({ backoff: BACKOFF });
  await assert.rejects(() => q.start('ftp://nope/x'), (e) => e instanceof TypeError);
  assert.equal(q.state, PLAYER_STATES.IDLE, '解析失败不应改变状态');
  p.stop();
  q.stop();
});

test('stop 幂等 + stopped 后可重新 start（connects 累加）', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  let pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  const { init, frames } = initAndFrames(2);
  feed(latest(), init);
  feed(latest(), frames);
  await until(() => p.stats.samples >= 2);

  p.stop();
  p.stop();
  assert.equal(p.state, PLAYER_STATES.STOPPED);
  const samplesAfterStop = p.stats.samples;
  await sleep(60);
  assert.equal(p.stats.samples, samplesAfterStop, 'stop 后不应再收样本');

  // stopped 是允许 start 的合法前驱
  pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  assert.equal(p.stats.connects, 2);
  p.stop();
});

test('断线重连：server close → will-reconnect → 新连接续流', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40, firstDataTimeoutMs: 5000 });
  const willReconnect = [];
  let samples = 0;
  p.on('will-reconnect', (i) => willReconnect.push(i));
  p.on('sample', () => samples++);

  let pr = p.start('ws-flv://gw/live/x');
  const ws0 = latest();
  ws0._open();
  await pr;
  let s = initAndFrames(3);
  feed(ws0, s.init);
  feed(ws0, s.frames);
  await until(() => samples >= 3);

  ws0.serverClose(1006, 'drop');
  await until(() => willReconnect.length >= 1);
  assert.equal(willReconnect[0].attempt, 1, 'attempt 为递增后的下次尝试序号');
  assert.equal(willReconnect[0].delayMs, 30);
  assert.match(willReconnect[0].reason, /关闭/);

  await until(() => FakeWebSocket.instances.length >= 2);
  const ws1 = latest();
  assert.notEqual(ws1, ws0, '重连应建立全新连接');
  ws1._open();
  s = initAndFrames(3);
  feed(ws1, s.init);
  feed(ws1, s.frames);
  await until(() => samples >= 6);
  assert.equal(p.state, PLAYER_STATES.PLAYING, '续流后回到 playing');
  p.stop();
});

test('重连上限：maxReconnectAttempts=1，二次断开 → error(重连次数已达上限) 且状态 error', async () => {
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    maxReconnectAttempts: 1,
    firstDataTimeoutMs: 5000,
    flushIntervalMs: 40,
  });
  const errors = [];
  p.on('error', (e) => errors.push(e));

  let pr = p.start('ws-flv://gw/live/x');
  const ws0 = latest();
  ws0._open();
  await pr;
  let s = initAndFrames(2);
  feed(ws0, s.init);
  feed(ws0, s.frames);
  await until(() => p.stats.samples >= 2);

  ws0.serverClose(1006);
  await until(() => FakeWebSocket.instances.length >= 2);
  const ws1 = latest();
  ws1._open();
  s = initAndFrames(2);
  feed(ws1, s.init);
  feed(ws1, s.frames);
  await until(() => p.stats.samples >= 4);

  ws1.serverClose(1006);
  await until(() => errors.length >= 1);
  assert.equal(errors[0].code, 'NETWORK_ERROR');
  assert.match(errors[0].message, /重连次数已达上限/);
  assert.equal(p.state, PLAYER_STATES.ERROR);
  p.stop();
});

test('首数据超时：连接成功但无媒体数据 → error(TIMEOUT) 并进入重连', async () => {
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    firstDataTimeoutMs: 60,
    flushIntervalMs: 40,
  });
  const errors = [];
  p.on('error', (e) => errors.push(e));
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;

  await until(() => errors.length >= 1);
  assert.equal(errors[0].code, 'TIMEOUT');
  assert.match(errors[0].message, /firstDataTimeout/);
  assert.equal(p.state, PLAYER_STATES.RECONNECTING, '应转入重连态而非终止');
  p.stop();
});

test('解析错误降级：坏 Tag → warn 事件，播放不终止（状态仍 playing）', async () => {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40 });
  const warns = [];
  p.on('warn', (w) => warns.push(w));
  const pr = p.start('ws-flv://gw/live/x');
  const ws = latest();
  ws._open();
  await pr;
  const { init } = initAndFrames(1);
  feed(ws, init);
  assert.equal(p.state, PLAYER_STATES.PLAYING);

  // 声明 dataSize=0xffffff（> 8MB 上限）的 Tag → demuxer PARSE_ERROR
  feed(ws, Uint8Array.from([9, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0]));
  assert.ok(
    warns.some((w) => w?.code === 'PARSE_ERROR'),
    '解析层错误应经 warn 外抛',
  );
  assert.equal(p.state, PLAYER_STATES.PLAYING, '解析错误不得终止播放');
  p.stop();
});

test('sink 接线：onMetadata/onTrack/onSample/onInitSegment/onFragment 齐全，flushPending 幂等', async () => {
  const calls = { init: [], frag: [], meta: 0, track: 0, sample: 0 };
  const p = new WsFlvPlayer({
    backoff: BACKOFF,
    flushIntervalMs: 40,
    sink: {
      onMetadata: () => calls.meta++,
      onTrack: () => calls.track++,
      onSample: () => calls.sample++,
      onInitSegment: (b) => calls.init.push(b),
      onFragment: (b) => calls.frag.push(b),
    },
  });
  const pr = p.start('ws-flv://gw/live/x');
  const ws = latest();
  ws._open();
  await pr;
  const { init, frames } = initAndFrames(4);
  feed(ws, init);
  feed(ws, frames);

  await until(() => calls.init.length >= 1 && calls.frag.length >= 1, 4000);
  assert.equal(calls.meta, 1);
  assert.equal(calls.track, 1);
  assert.equal(calls.sample, 4);
  assert.equal(calls.init.length, 1, 'init segment 只发一次');
  const seg = calls.init[0];
  assert.equal(String.fromCharCode(seg[4], seg[5], seg[6], seg[7]), 'ftyp');
  assert.equal(
    String.fromCharCode(calls.frag[0][4], calls.frag[0][5], calls.frag[0][6], calls.frag[0][7]),
    'moof',
  );

  p.flushPending(); // 队列已空：不应重复发 init、不抛错
  assert.equal(calls.init.length, 1);
  assert.doesNotThrow(() => p.flushPending());
  p.stop();
});

// ── 第七批修复回归（reconnects / will-reconnect.attempt）──────────

/** 启动到 playing 态并返回便捷句柄 */
async function mkPlaying(opts = {}) {
  const p = new WsFlvPlayer({ backoff: BACKOFF, flushIntervalMs: 40, ...opts });
  const events = [];
  p.on('will-reconnect', (i) => events.push({ type: 'will-reconnect', ...i }));
  const pr = p.start('ws-flv://gw/live/x');
  latest()._open();
  await pr;
  const s = initAndFrames(2);
  feed(latest(), s.init);
  feed(latest(), s.frames);
  return { player: p, events };
}

test('stats.reconnects 随每次重连调度自增（此前恒 0）', async () => {
  const { player } = await mkPlaying({ maxReconnectAttempts: 3 });
  assert.equal(player.stats.connects, 1);
  assert.equal(player.stats.reconnects, 0, '首次连接不计数');

  latest().serverClose(1006, 'drop');
  await until(() => FakeWebSocket.instances.length >= 2);
  assert.equal(player.stats.reconnects, 1, '首次重连后计数 1');
  // 打开重连连接，使其 source.start() 真正成功 → connects 累加
  const ws1 = latest();
  ws1._open();
  await until(() => player.stats.connects >= 2);
  assert.equal(player.stats.connects, 2, '重连成功后 connects 亦累加');

  ws1.serverClose(1006, 'drop again');
  await until(() => FakeWebSocket.instances.length >= 3);
  assert.equal(player.stats.reconnects, 2, '第二次重连后计数 2');
  player.stop();
});

test('will-reconnect.attempt 为本轮重连序号（1 起，非 0）', async () => {
  const { player, events } = await mkPlaying({ maxReconnectAttempts: 3 });

  latest().serverClose(1006, 'drop');
  await until(() => events.length >= 1);
  assert.equal(events[0].attempt, 1, '第 1 次重连 attempt=1');

  await until(() => FakeWebSocket.instances.length >= 2);
  latest()._open();
  latest().serverClose(1006, 'drop again');
  await until(() => events.length >= 2);
  assert.equal(events[1].attempt, 2, '第 2 次重连 attempt=2');
  player.stop();
});
