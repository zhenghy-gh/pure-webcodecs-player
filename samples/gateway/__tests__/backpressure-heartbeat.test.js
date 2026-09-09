import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import net from 'node:net';
import crypto from 'node:crypto';

import { SlowConsumerQueue } from '../src/slow-consumer.js';
import { createChannelRelay } from '../src/server-relay.js';

// ---------- SlowConsumerQueue 单元 ----------

function fakeSink() {
  const calls = [];
  return {
    calls,
    send(chunk) {
      calls.push(Buffer.from(chunk));
      return true;
    },
  };
}

test('背压：积压超限丢弃最旧块并计数（丢旧不丢新）', () => {
  const sink = fakeSink();
  const q = new SlowConsumerQueue(sink, { maxQueuedBytes: 100 });
  const drops = [];
  q.onDrop = (len) => drops.push(len);

  // 每个 60B：入队第 3 块时超限 → 第 1 块被丢
  q.enqueueBinary(new Uint8Array(60).fill(1));
  q.enqueueBinary(new Uint8Array(60).fill(2));
  assert.equal(q.droppedChunks, 1, '第 1 块应被挤出');
  assert.equal(drops.length, 1);
  // 排空后队列里应是 [2]
  q.clear();
  assert.equal(q.queuedBytes, 0);
});

test('背压：单块超过总上限直接丢弃不入队', () => {
  const sink = fakeSink();
  const q = new SlowConsumerQueue(sink, { maxQueuedBytes: 50 });
  q.enqueueBinary(new Uint8Array(64));
  assert.equal(q.queue.length, 0);
  assert.equal(q.droppedChunks, 1);
});

test('信令直发：sendText 不经过队列', () => {
  const sink = fakeSink();
  const q = new SlowConsumerQueue(sink, { maxQueuedBytes: 10 });
  q.sendText('{"type":"meta"}');
  assert.deepEqual(sink.calls.map((c) => c.toString()), ['{"type":"meta"}']);
  assert.equal(q.queue.length, 0);
});

test('sink 写失败时保留队列待重试', () => {
  let failNext = true;
  const q = new SlowConsumerQueue(
    { send() { if (failNext) return false; return true; } },
    { maxQueuedBytes: 100 },
  );
  q.enqueueBinary(new Uint8Array(10));
  assert.equal(q.queue.length, 1, '写失败应保留');
});

// ---------- 网关心跳集成 ----------

let PORT;
let server;

/** 完成握手但不回应 Ping 的「死连接」 */
function deadSocket(port) {
  const key = crypto.randomBytes(16).toString('base64');
  const s = net.connect(port, '127.0.0.1', () => {
    s.write([
      'GET /stream/heartbeat-test HTTP/1.1', 'Host: x', 'Upgrade: websocket',
      'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
  });
  return s;
}

before(async () => {
  server = createChannelRelay({ host: '127.0.0.1', port: 0, pingIntervalMs: 250 });
  PORT = await server.ready;
});

after(async () => server.dispose());

test('心跳：不回应 Ping 的连接在超时后被服务端断开', async () => {
  const s = deadSocket(PORT);
  await new Promise((r) => setTimeout(r, 200)); // 等握手完成

  let gotPing = false;
  let sawCloseFromServer = false;
  s.on('data', (d) => {
    // 扫描是否出现 Opcode 9（Ping）帧：服务端心跳
    for (let i = 0; i + 1 < d.length; i++) {
      if ((d[i] & 0x0f) === 9) gotPing = true;
    }
  });
  s.on('close', () => (sawCloseFromServer = true));

  await new Promise((r) => setTimeout(r, 2200)); // > 4 个心跳周期（阈值=2 周期+余量）
  assert.ok(gotPing, '服务端应发出 Ping');
  assert.ok(sawCloseFromServer, '未回 Pong 的连接应被断开');
  s.destroy(); // 清理客户端句柄，避免测试进程悬挂
});
