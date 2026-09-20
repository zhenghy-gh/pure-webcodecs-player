/**
 * ws-server 残余分支补测（129 波）：
 * FrameDecoder 控制帧/分片重组/64bit 长度/超大帧拒绝/未掩码拷贝、
 * WsConnection ping-pong 应答/pong 处理器/readyState/心跳两分支/terminate/
 * teardown 三级写异常吞噬/error 事件/业务回调异常隔离、
 * createWsHttpServer HTTP 404 与 Upgrade 400 拒绝、close 覆盖层。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { encodeFrame, FrameDecoder, WsConnection, createWsHttpServer } from '../src/ws-server.js';

/** fake 双工 socket：记录写出字节，write/end/destroy 可注入失败 */
function fakeSocket(fails = {}) {
  const s = new EventEmitter();
  s.written = [];
  s.write = (d) => {
    if (fails.write) throw new Error('write down');
    s.written.push(Buffer.from(d));
    return true;
  };
  s.end = () => {
    if (fails.end) throw new Error('end down');
    return s;
  };
  s.destroy = () => {
    if (fails.destroy) throw new Error('destroy down');
    s.destroyed = true;
  };
  s.setNoDelay = () => {};
  return s;
}

/** 未掩码帧（解码器不强制校验掩码，直喂单元层足够） */
function rawFrame(opcode, payload, { fin = true } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

/* ------------------------------ encodeFrame ------------------------------ */

test('encodeFrame：64bit 扩展长度（≥65536）且 FrameDecoder 可往返解出', () => {
  const payload = Buffer.alloc(70000, 0x5a);
  const frame = encodeFrame(0x2, payload);
  assert.equal(frame[1], 127);
  assert.equal(frame.readBigUInt64BE(2), 70000n);
  const { messages } = new FrameDecoder().push(frame);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.length, 70000);
  assert.equal(messages[0].isText, false);
});

/* ------------------------------ FrameDecoder ------------------------------ */

test('FrameDecoder：ping/pong 控制帧上报；未知 opcode 静默忽略', () => {
  const d = new FrameDecoder();
  const { messages, controls } = d.push(
    Buffer.concat([
      rawFrame(0x9, Buffer.from('hi')), // ping
      rawFrame(0xa, Buffer.alloc(0)), // pong
      rawFrame(0x3, Buffer.alloc(0)), // 保留 opcode
      rawFrame(0x1, Buffer.from('ok')),
    ]),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].isText, true);
  assert.deepEqual(controls.map((c) => c.type), ['ping', 'pong']);
  assert.deepEqual([...controls[0].data], [...Buffer.from('hi')]);
});

test('FrameDecoder：分片重组（TEXT fin=0 + CONT fin=1 → 合并消息）', () => {
  const d = new FrameDecoder();
  const first = d.push(rawFrame(0x1, Buffer.from('Hel'), { fin: false }));
  assert.deepEqual(first.messages, []); // 首分片不上报
  const done = d.push(rawFrame(0x0, Buffer.from('lo'), { fin: true }));
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].isText, true);
  assert.equal(done.messages[0].data.toString(), 'Hello');
});

test('FrameDecoder：二进制分片同样重组（fin=0 后 CONT fin=1）', () => {
  const d = new FrameDecoder();
  d.push(rawFrame(0x2, Buffer.from('A'), { fin: false }));
  const done = d.push(rawFrame(0x0, Buffer.from('B'), { fin: true }));
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].isText, false);
  assert.equal(done.messages[0].data.toString(), 'AB');
});

test('FrameDecoder：未掩码负载拷贝脱离底层 buffer（修改源不影响已解帧）', () => {
  const d = new FrameDecoder();
  const frame = rawFrame(0x1, Buffer.from('copy'));
  const { messages } = d.push(frame);
  frame.fill(0x00, 2);
  assert.equal(messages[0].data.toString(), 'copy');
});

test('FrameDecoder：64bit 长度声明超 MAX_LENGTH → 抛 frame too large', () => {
  const d = new FrameDecoder();
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeBigUInt64BE(2n ** 53n, 2);
  assert.throws(() => d.push(header), /frame too large/);
});

test('FrameDecoder：close 控制帧解析状态码与 reason；closed 后停帧', () => {
  const d = new FrameDecoder();
  const body = Buffer.alloc(2 + 5);
  body.writeUInt16BE(3001, 0);
  body.write('gone!', 2);
  const { controls, messages } = d.push(
    Buffer.concat([rawFrame(0x8, body), rawFrame(0x1, Buffer.from('after'))]),
  );
  assert.equal(controls.length, 1);
  assert.equal(controls[0].code, 3001);
  assert.equal(controls[0].reason, 'gone!');
  assert.deepEqual(messages, []); // closed 后不再解帧
});

/* ------------------------------ WsConnection ------------------------------ */

test('WsConnection：ping → 自动回 pong；入站 pong 触发 pong 处理器；readyState=1', () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  const pongs = [];
  conn.on('pong', (x) => pongs.push(x));
  socket.emit('data', Buffer.concat([rawFrame(0x9, Buffer.from('k')), rawFrame(0xa, Buffer.alloc(0))]));
  const pong = socket.written.find((b) => (b[0] & 0x0f) === 0xa);
  assert.ok(pong, '应写出 pong 帧');
  assert.deepEqual([...pong.subarray(pong.length - 1)], [...Buffer.from('k')]);
  assert.equal(pongs.length, 1);
  assert.equal(conn.readyState, 1);
});

test('WsConnection：decoder 抛错 → error 事件且不崩', () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  const errs = [];
  conn.on('error', (e) => errs.push(e));
  conn.decoder.push = () => {
    throw new Error('decode boom');
  };
  socket.emit('data', Buffer.from('garbage'));
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /decode boom/);
});

test("WsConnection：socket 'error' → error 事件 + teardown(1006)，send 后续返回 false", () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  const events = { errors: [], closes: [] };
  conn.on('error', (e) => events.errors.push(e));
  conn.on('close', (c) => events.closes.push(c));
  socket.emit('error', new Error('tcp reset'));
  assert.equal(events.errors.length, 1);
  assert.equal(events.closes[0].code, 1006);
  assert.equal(conn.readyState, 3);
  assert.equal(conn.send('x'), false); // 已不存活
});

test('WsConnection：收到对端 close → 回显 CLOSE（1005→1000）并触发 close 事件', () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  const closes = [];
  conn.on('close', (c) => closes.push(c));
  socket.emit('data', rawFrame(0x8, Buffer.alloc(0))); // 无状态码 → 1005
  assert.equal(closes[0].code, 1005);
  const echo = socket.written.find((b) => (b[0] & 0x0f) === 0x8);
  assert.ok(echo, '应回显 CLOSE 帧');
  assert.equal(echo.readUInt16BE(echo.length - 2), 1000);
});

test('WsConnection：teardown 三级写异常（write/end/destroy）全部吞噬，close 事件照发', () => {
  const socket = fakeSocket({ write: true, end: true, destroy: true });
  const conn = new WsConnection(socket);
  const closes = [];
  conn.on('close', (c) => closes.push(c));
  socket.emit('data', rawFrame(0x8, Buffer.alloc(0)));
  assert.equal(closes.length, 1);
  assert.equal(conn.alive, false);
});

test('WsConnection：业务回调抛错 → console.error 隔离，后续处理器照常执行', () => {
  const orig = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a);
  try {
    const socket = fakeSocket();
    const conn = new WsConnection(socket);
    let second = 0;
    conn.on('message', () => {
      throw new Error('handler bomb');
    });
    conn.on('message', () => {
      second++;
    });
    socket.emit('data', rawFrame(0x1, Buffer.from('x')));
    assert.equal(second, 1);
    assert.ok(captured.some((a) => String(a[a.length - 1]).includes('handler bomb')));
  } finally {
    console.error = orig;
  }
});

test('WsConnection：terminate 硬终止（socket.destroy）；startHeartbeat 对已终止连接自清', async () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  conn.startHeartbeat(50);
  conn.terminate();
  assert.equal(socket.destroyed, true);
  await new Promise((r) => setTimeout(r, 120)); // 心跳周期触发时 alive=false → clearInterval 分支
  assert.equal(conn.readyState, 3);
});

test('WsConnection：terminate 时 socket.destroy 抛错 → 吞噬不外泄', () => {
  const socket = fakeSocket({ destroy: true });
  const conn = new WsConnection(socket);
  assert.doesNotThrow(() => conn.terminate());
  assert.equal(conn.alive, false);
});

test('WsConnection：心跳超时（连续两周期无 pong/数据）→ close(1001)', async () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  const closes = [];
  conn.on('close', (c) => closes.push(c));
  conn.startHeartbeat(50); // 超时阈值 50*2+500=600ms
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(closes[0]?.code, 1001, JSON.stringify(closes));
  assert.equal(socket.written.some((b) => (b[0] & 0x0f) === 0x8), true);
});

test('WsConnection：send 文本/二进制整帧写出', () => {
  const socket = fakeSocket();
  const conn = new WsConnection(socket);
  assert.equal(conn.send('hi'), true);
  assert.equal(conn.send(new Uint8Array([1, 2]).buffer), true);
  const texts = socket.written.filter((b) => (b[0] & 0x0f) === 0x1);
  const bins = socket.written.filter((b) => (b[0] & 0x0f) === 0x2);
  assert.equal(texts.length, 1);
  assert.equal(bins.length, 1);
});

/* ------------------------------ createWsHttpServer ------------------------------ */

const server = createWsHttpServer(() => {}, ['/ws']);
const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
after(() => server.close());

test('普通 HTTP GET 无 httpHandler → 404 not found', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

test('Upgrade 路径不匹配 → 400 Bad Request 并断开', async () => {
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('400')) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on('error', reject);
    sock.write(
      'GET /bad HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: aaaa\r\n\r\n',
    );
  });
  assert.match(reply, /400 Bad Request/);
});

test('Upgrade 缺 Sec-WebSocket-Key → 400 Bad Request', async () => {
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('400')) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on('error', reject);
    sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  assert.match(reply, /400 Bad Request/);
});

test('close 覆盖层：closeAllConnections 被调用且监听关闭', async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(server.listening, false);
});

test('close 覆盖层：closeAllConnections 抛错 → 吞噬，close 仍完成', async () => {
  const server2 = createWsHttpServer(() => {}, null);
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  server2.closeAllConnections = () => {
    throw new Error('reap down');
  };
  await assert.doesNotReject(() => new Promise((resolve) => server2.close(resolve)));
  assert.equal(server2.listening, false);
});
