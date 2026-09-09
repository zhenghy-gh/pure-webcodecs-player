import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createChannelRelay } from '../src/server-relay.js';

let PORT;
let server;

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

before(async () => {
  server = createChannelRelay({ host: '127.0.0.1', port: 0 });
  PORT = await server.ready;
});

after(async () => server.dispose());

test('§9.1：POST /publish 二进制边收边转到订阅端（保序）', async () => {
  const sub = await connectStream('ch1');
  const got = collector(sub);
  const res = await fetch(`http://127.0.0.1:${PORT}/publish/ch1`, {
    method: 'POST',
    body: new Uint8Array([1, 2, 3, 4, 5]),
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(res.status, 204);
  await until(() => got.binary.length >= 1);
  // 增强①：publish 结束应合成 eos
  await until(() => got.texts.some((t) => t.includes('"eos"')));
  assert.deepEqual(Array.from(got.binary[0]), [1, 2, 3, 4, 5]);
  sub.close();
});

test('增强③：?meta= 首推注入并广播 meta 信令', async () => {
  const sub = await connectStream('ch2');
  const got = collector(sub);
  const meta = encodeURIComponent(JSON.stringify({ container: 'flv', live: true }));
  await fetch(`http://127.0.0.1:${PORT}/publish/ch2?meta=${meta}`, { method: 'PUT', body: 'xx' });
  await until(() => got.texts.some((t) => t.includes('"meta"')));
  const metaMsg = JSON.parse(got.texts.find((t) => t.includes('"meta"')));
  assert.equal(metaMsg.container, 'flv');
  sub.close();
});

test('增强②：新订阅者 join 时补发频道记忆的最近 meta', async () => {
  // ch3 先推流注入 meta（先无订阅者，验证 meta 被记忆）
  const meta = encodeURIComponent(JSON.stringify({ container: 'flv', codecs: ['avc1.42c01e'] }));
  await fetch(`http://127.0.0.1:${PORT}/publish/ch3?meta=${meta}`, { method: 'POST', body: 'a' });
  // 后加入的订阅者应立即收到补发
  const late = await connectStream('ch3');
  const got = collector(late);
  await until(() => got.texts.length >= 1);
  assert.ok(got.texts[0].includes('"meta"'), 'join 补发 meta');
  late.close();
});

test('§9.2/9.1：文本信令原样广播且含发送者自身回声；未知 JSON 类型不拦截', async () => {
  const a = await connectStream('ch4');
  const b = await connectStream('ch4');
  const ga = collector(a);
  const gb = collector(b);
  a.send(JSON.stringify({ type: 'hello', ua: 'test-client' }));
  a.send('这不是JSON'); // 非法 JSON 网关不解析、照转（客户端负责静默忽略）
  await until(() => ga.texts.length >= 2 && gb.texts.length >= 2);
  assert.equal(ga.texts[0], gb.texts[0], '发送者也收到回声');
  assert.match(ga.texts[1], /这不是JSON/);
  a.close();
  b.close();
});

test('GET /status 返回频道列表', async () => {
  const ws = await connectStream('ch5');
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.channels.some((c) => c.name === 'ch5'));
  } finally {
    ws.close();
  }
});
