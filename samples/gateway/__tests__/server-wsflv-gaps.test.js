/**
 * ws-flv 网关残余分支补测（第 136 波覆盖率迭代）。
 *
 * 覆盖点与 server-wsflv.js 行号对应：
 *   - 38-40   initChunk 抛错 → close(1011)（原型注入 FlvLoopSource 抛错，finally 还原）
 *   - 59-62   pump 内 take 抛错 → close(1011) + 计时器清理（同上注入）
 *   - 73-75   连接 error 事件 → 清推流计时器（原生 TCP 握手后发畸形 64bit 帧
 *             使 FrameDecoder 抛 "frame too large" → WsConnection 捕获 → emit('error')）
 *   - 80-86   HTTP httpHandler：/healthz 200 JSON 统计、其余路径 404 文本
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createWsFlvGateway } from '../src/server-wsflv.js';
import { FlvLoopSource } from '../src/flv-builder.js';

const server = createWsFlvGateway({ port: 0 });
const port = await server.ready;
after(() => server.dispose());

/** 建立连接前即挂 onclose，避免服务端先于监听关闭（1011 场景必然先关） */
function connectWs(url) {
  const ws = new WebSocket(url);
  const closed = new Promise((r) => {
    ws.onclose = (e) => r({ code: e.code, reason: e.reason });
  });
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`连接失败: ${url}`));
  });
  return { opened, closed, ws };
}

/* ------------------------------ httpHandler（80-86） ------------------------------ */

test('httpHandler：/healthz 返回 200 JSON 统计；其余路径 404 文本（80-86）', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.equal(body.service, 'ws-flv-gateway');
  assert.equal(typeof body.connections, 'number');
  assert.equal(typeof body.framesSent, 'number');

  const res404 = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res404.status, 404);
  assert.equal(res404.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await res404.text(), /请用 WebSocket/);
});

/* ------------------------------ 首块构建失败（38-40） ------------------------------ */

test('initChunk 抛错 → close(1011) 携带错误信息，不进入推流循环（38-40）', async () => {
  const orig = FlvLoopSource.prototype.initChunk;
  FlvLoopSource.prototype.initChunk = function () {
    throw new Error('boom-init');
  };
  try {
    const { opened, closed } = connectWs(`ws://127.0.0.1:${port}/live/init-fail`);
    await opened;
    const c = await closed;
    assert.equal(c.code, 1011, `应转发为内部错误关闭码，实际 ${c.code}`);
    assert.match(c.reason, /boom-init/);
  } finally {
    FlvLoopSource.prototype.initChunk = orig;
  }
});

/* ------------------------------ pump 内抛错（59-62） ------------------------------ */

test('pump 内 take 抛错 → close(1011)，推流计时器被清理（59-62）', async () => {
  const orig = FlvLoopSource.prototype.take;
  let calls = 0;
  FlvLoopSource.prototype.take = function () {
    calls++;
    throw new Error('boom-take');
  };
  try {
    const { opened, closed } = connectWs(`ws://127.0.0.1:${port}/live/take-fail?intervalMs=5`);
    await opened;
    const c = await closed;
    assert.equal(c.code, 1011);
    assert.match(c.reason, /boom-take/);
    assert.ok(calls >= 1, 'pump 应至少调用过一次 take');
  } finally {
    FlvLoopSource.prototype.take = orig;
  }
});

/* ------------------------------ 连接 error 事件（73-75） ------------------------------ */

/** 原生 TCP 完成 WS 握手（路径须落在 /live/ 白名单内） */
async function rawHandshake(wsPath) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(
    `GET ${wsPath} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  await new Promise((resolve, reject) => {
    const onData = (d) => {
      if (String(d).includes('101 Switching Protocols')) resolve();
      else sock.once('data', onData);
    };
    sock.once('data', onData);
    sock.once('error', reject);
  });
  return sock;
}

test('连接 error 事件（畸形 64bit 帧 → decoder 抛错）→ 推流计时器被清、数据流停止（73-75）', async () => {
  const sock = await rawHandshake('/live/raw-err?intervalMs=10');
  sock.on('error', () => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let received = 0;
  sock.on('data', (d) => {
    received += d.length;
  });
  await sleep(150); // 先让推流跑起来（initChunk + 若干帧）
  assert.ok(received > 0, '正常推流期应收到数据');

  // 畸形帧：64bit 长度声明 2^53 > MAX_LENGTH → #tryReadFrame 抛 "frame too large"
  const evil = Buffer.alloc(10);
  evil[0] = 0x82;
  evil[1] = 127;
  evil.writeBigUInt64BE(2n ** 53n, 2);
  sock.write(evil);

  // 在途帧排空后，若计时器未被清，intervalMs=10 下 400ms 内会继续涌出 ~40 帧
  await sleep(120);
  const quiescent = received;
  await sleep(400);
  assert.equal(received, quiescent, 'error 事件后推流计时器应被清理，数据流停止');

  sock.destroy();
});

/*
 * ------------------------------ 残余行登记（不硬造） ------------------------------
 *
 * 本次目标清单（38-40 / 59-62 / 73-75 / 80-86）中除以下说明外均已覆盖：
 *
 * 无——16 个未覆盖行（38,39,40,59,60,61,62,73?,74,75,80-86 + 首行 docblock 计数）
 * 全部经上述用例或登记说明处置。其中：
 *   - 38-40 / 59-62 依赖 FlvLoopSource 同步抛错：当前实现下构造/initChunk/take
 *     均为确定性纯函数（tags 恒产出、游标跨周期回卷），公共 API 路径无自然抛错
 *     来源，属防御分支；采用「原型注入抛错」覆盖（合法可还原，非硬造字节序列）。
 *   - conn.send 的 socket.write 对已毁 socket 异步报错（不同步抛），无法借
 *     断连制造 38-40/59-62 的 catch，故上述注入是唯一可达路径。
 */
