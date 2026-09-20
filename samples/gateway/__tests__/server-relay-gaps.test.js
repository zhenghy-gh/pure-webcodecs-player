/**
 * server-relay 残余分支补测（137 波）：
 *   - metaFromQuery 非法 JSON catch 兜底（31-32）
 *   - 慢消费 onDrop 聚合统计（56-57）
 *   - OPTIONS 预检 204（87-90）
 *   - publish 请求流 error → 500（120-124，含 writeHead 抛错吞噬）
 *   - HTTP 404 兜底（144-146）
 *   - 非 /stream 路径 WS 升级 → close(1008)（153-155）
 *   - 订阅端二进制上行转发（168-170）
 * 另：原 19-21 行 signalFrame() 为模块内私有死代码（全仓零调用、未导出），
 * 本波同 130 波 readSectionFromPayload 先例直接删除，全文件 100%。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createChannelRelay, metaFromQuery } from '../src/server-relay.js';

let PORT;
let server;

// maxQueuedBytes 压到 16B 便于触发慢消费丢旧；pingIntervalMs=0 关闭心跳避免噪声
before(async () => {
  server = createChannelRelay({ host: '127.0.0.1', port: 0, maxQueuedBytes: 16, pingIntervalMs: 0 });
  PORT = await server.ready;
});
after(async () => server.dispose());

function connectStream(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream/${name}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('connect failed'));
  });
}

/** 收集消息直到条件满足 */
function collector(ws) {
  const got = { binary: [], texts: [] };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') got.texts.push(ev.data);
    else got.binary.push(new Uint8Array(ev.data));
  };
  return got;
}

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 8));
  }
}

/* ------------------------------ metaFromQuery ------------------------------ */

test('metaFromQuery：非法 JSON 走 catch → null（31-32）', () => {
  assert.equal(metaFromQuery(new URL('http://x/?meta=%7Bbad')), null); // '{bad' 解析抛错
  assert.equal(metaFromQuery(new URL('http://x/?meta=%5B1%5D')), null); // 数组同样判非法
});

/* ------------------------------ HTTP 层残余分支 ------------------------------ */

test('OPTIONS 预检 → 204 空体（87-90）', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/publish/anything`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
});

test('未匹配任何端点 → 404 纯文本兜底（144-146）', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/definitely-not-here`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /404/);
});

test("publish 请求流 'error' → 500；writeHead 抛错被 catch 吞噬（120-124）", () => {
  // ① 假 req/res 直调 httpHandler，注入 error 事件：走 121-123 正常 500 响应
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/publish/err-ch-a';
  req.headers = { host: 'localhost' };
  const heads = [];
  server.httpHandler(req, {
    setHeader: () => {},
    writeHead: (...a) => heads.push(a),
    end: () => {},
  });
  req.emit('error', new Error('stream boom'));
  assert.equal(heads[0][0], 500);

  // ② 响应头已不可写（writeHead 抛错）→ 124 的 catch 吞噬不外泄
  const req2 = new EventEmitter();
  req2.method = 'POST';
  req2.url = '/publish/err-ch-b';
  req2.headers = { host: 'localhost' };
  assert.doesNotThrow(() => {
    server.httpHandler(req2, {
      setHeader: () => {},
      writeHead: () => {
        throw new Error('head down');
      },
      end: () => {},
    });
    req2.emit('error', new Error('stream boom 2'));
  });
});

/* ------------------------------ 慢消费 onDrop 统计 ------------------------------ */

test('慢消费订阅者积压超限 → onDrop 计入全局统计（56-57）', async () => {
  const name = 'drop-ch';
  // 假订阅者：底层永远写不动（send=false），迫使队列积压滞留
  const fakeConn = { send: () => false };
  server.channels.set(name, { subscribers: new Set([fakeConn]), lastMeta: null, publishers: 0 });
  const drops0 = server.stats.droppedForSlowConsumer;
  const bytes0 = server.stats.droppedBytes;

  // 块 10B、上限 16B：第一块滞留队列（drain 失败），第二块挤掉最旧块 → onDrop(10)
  await fetch(`http://127.0.0.1:${PORT}/publish/${name}`, { method: 'POST', body: new Uint8Array(10).fill(1) });
  await fetch(`http://127.0.0.1:${PORT}/publish/${name}`, { method: 'POST', body: new Uint8Array(10).fill(2) });

  assert.equal(server.stats.droppedForSlowConsumer - drops0, 1);
  assert.equal(server.stats.droppedBytes - bytes0, 10);
  server.channels.get(name).subscribers.delete(fakeConn); // 清理，避免影响后续广播
});

/* ------------------------------ WS 订阅路径残余分支 ------------------------------ */

test("升级到 /status（过白名单但非 /stream/ 正则）→ close(1008, 'bad path')（153-155）", async () => {
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/status`);
    ws.onclose = (ev) => resolve(ev.code);
    ws.onerror = () => reject(new Error('upgrade failed'));
  });
  assert.equal(code, 1008);
});

test('订阅端上行二进制帧 → 按通道语义转发给频道内订阅者（171-173）', async () => {
  const a = await connectStream('bin-ch');
  const b = await connectStream('bin-ch');
  const got = collector(b);
  a.send(new Uint8Array([7, 8, 9])); // 二进制帧（非信令）
  await until(() => got.binary.length >= 1);
  assert.deepEqual([...got.binary[0]], [7, 8, 9]);
  a.close();
  b.close();
});

/*
 * 死代码处置登记：
 *   - 原 19-21 行 signalFrame() 为模块内私有死代码——全仓库零调用点且未导出，
 *     不存在任何可达入口；本波（137）按 130 波 readSectionFromPayload 先例
 *     直接从 server-relay.js 删除（不改任何行为），全文件 100%。
 */
