import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createWsFlvGateway } from '../../samples/gateway/src/server-wsflv.js';
import { WsFlvPlayer, PLAYER_STATES } from '../src/player.js';
import { Backoff } from '../src/backoff.js';

let PORT; // listen(0) 系统分配
let server;

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`until 超时（条件长时间未满足）`);
    await new Promise((r) => setTimeout(r, 8));
  }
}

before(async () => {
  server = createWsFlvGateway({ host: '127.0.0.1', port: 0 });
  PORT = await server.ready;
});

after(async () => server.dispose());

test('完整管线（无头模式）：header→track→sample 全链路 + µs 时间基', async () => {
  const p = new WsFlvPlayer({ backoff: { baseMs: 50 } });
  const got = { tracks: [], samples: [], metadata: null };
  p.on('metadata', (m) => (got.metadata = m));
  p.on('track', (t) => got.tracks.push(t));
  p.on('sample', (s) => got.samples.push(s));

  await p.start(`ws-flv://127.0.0.1:${PORT}/live/test?speed=fast&frames=10&intervalMs=1`);
  await until(() => got.samples.length >= 10);
  p.stop();

  assert.ok(got.metadata && got.metadata.width === 16);
  assert.equal(got.tracks[0].codec, 'h264');
  assert.equal(got.tracks[0].codecString, 'avc1.42c01e');
  assert.ok(Number.isInteger(got.samples[0].dtsUs));
  assert.ok(p.stats.bytesIn > 1000);
});

test('sink 接线：onInitSegment/onFragment/onSample 回调齐全，init 可被 box 遍历', async () => {
  const sinkCalls = { init: [], frag: [], samples: 0 };
  const p = new WsFlvPlayer({
    backoff: { baseMs: 50 },
    flushIntervalMs: 40,
    sink: {
      onInitSegment: (b) => sinkCalls.init.push(b),
      onFragment: (b) => sinkCalls.frag.push(b),
      onSample: () => sinkCalls.samples++,
    },
  });
  await p.start(`ws://127.0.0.1:${PORT}/live/test?speed=fast&frames=12&intervalMs=1`);
  await until(() => sinkCalls.frag.length >= 1 && sinkCalls.init.length >= 1);
  p.stop();

  assert.equal(sinkCalls.init.length, 1);
  // init 段以 ftyp 开头
  const init = sinkCalls.init[0];
  assert.equal(String.fromCharCode(init[4], init[5], init[6], init[7]), 'ftyp');
  // 片段以 moof 开头
  assert.equal(String.fromCharCode(sinkCalls.frag[0][4], sinkCalls.frag[0][5], sinkCalls.frag[0][6], sinkCalls.frag[0][7]), 'moof');
  assert.ok(sinkCalls.samples >= 12);
});

test('断流重连：服务端 frames=N 关闭后自动重连并继续收流', async () => {
  const p = new WsFlvPlayer({ backoff: { baseMs: 60, maxMs: 200 }, flushIntervalMs: 30 });
  const states = [];
  let reconnectEvents = 0;
  const samples = [];
  p.on('statechange', ({ to }) => states.push(to));
  p.on('will-reconnect', () => reconnectEvents++);
  p.on('sample', (s) => samples.push(s.dtsUs));

  await p.start(`ws-flv://127.0.0.1:${PORT}/live/test?speed=fast&frames=5&intervalMs=1`);
  await until(() => samples.length >= 15 && reconnectEvents >= 1, 12000);
  p.stop();
  assert.ok(states.includes(PLAYER_STATES.RECONNECTING), '应经历重连态');
  // 重连后的样本时间戳从头开始（新周期）——数量增长即证明续流
  assert.ok(samples.length >= 15);
});

test('退避节奏：连续失败时延迟按 base*factor^n 增长（含抖动界内）', () => {
  const b = new Backoff({ baseMs: 100, factor: 2, maxMs: 5000, jitter: 0 });
  expectSeq([100, 200, 400, 800, 1600]);
  b.reset();
  expectSeq([100]);
  function expectSeq(expected) {
    for (const e of expected) {
      const v = b.next();
      assert.equal(v, e, `第 ${b.attempt} 次退避应=${e}`);
    }
  }
  // maxMs 封顶
  b.reset();
  let last = 0;
  for (let i = 0; i < 8; i++) last = b.next();
  assert.equal(last, 5000);
});

test('连接拒绝 → error(NETWORK_ERROR) 且状态机进入重连/错误路径而非崩溃', async () => {
  const p = new WsFlvPlayer({ backoff: { baseMs: 50, maxReconnectAttempts: 2 }, maxReconnectAttempts: 2 });
  const errors = [];
  p.on('error', (e) => errors.push(e));
  try {
    await p.start('ws-flv://127.0.0.1:1/live/x');
    assert.fail('应抛出 NETWORK_ERROR');
  } catch (e) {
    assert.equal(e.code, 'NETWORK_ERROR');
  }
  p.stop();
  void errors;
});

test('stop() 幂等：重复 stop 不抛错且不再触发重连', async () => {
  const p = new WsFlvPlayer({ backoff: { baseMs: 40 } });
  await p.start(`ws-flv://127.0.0.1:${PORT}/live/test?speed=fast&frames=3&intervalMs=1`);
  await until(() => p.state === PLAYER_STATES.PLAYING || p.stats.bytesIn > 0);
  p.stop();
  p.stop();
  assert.equal(p.state, PLAYER_STATES.STOPPED);
  const reconnectsAfterStop = p.stats.reconnects;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.stats.reconnects, reconnectsAfterStop, '停止后不应再有重连');
});
