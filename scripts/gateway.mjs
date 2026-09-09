#!/usr/bin/env node
// ⚠️【冻结·兼容入口】本文件已冻结不再演进（终裁#3 / CONTRACTS §9）。
// 全仓唯一权威网关实现 = samples/gateway（net-dev 维护），行为与本文件一致，
// 并按 §9.3 提供增强：publish 结束合成 eos、频道记忆 meta 新订阅补发、?meta= 注入、
// 慢消费背压(丢旧块+计数上报)、心跳保活。npm run gateway 入口保持可用。
// 本地测试网关（零依赖）：为浏览器无法直连的协议（RTMP/RTSP 等）提供 WebSocket 桥接通道。
// 纯 Node 标准库实现的极简 WebSocket 服务端（RFC6455 子集），仅供本机联调，无鉴权。
//
// 用法：
//   npm run gateway            # 默认 ws://127.0.0.1:8090
//   PORT=9000 npm run gateway
//
// 通道模型（约定见 docs/CONTRACTS.md，architect 定稿后以此为准）：
//   POST/PUT /publish/<name>   推流端：把原始字节流（如 FLV、MPEG-TS、自定义帧头流）按到达顺序转发
//   WS       /stream/<name>    订阅端：收到二进制帧 = 推流字节流的分块；文本帧保留作控制信令
//
// 典型链路：
//   ffmpeg -re -i rtsp://摄像头 -c copy -f flv http://127.0.0.1:8090/publish/cam1
//   浏览器: new WebSocket('ws://127.0.0.1:8090/stream/cam1') → flv.js 式解析 → MSE/WebCodecs
//
// 状态页：GET / 返回各通道订阅数 JSON。
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8090);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** name -> Set<conn> */
const channels = new Map();
function join(name, conn) {
  if (!channels.has(name)) channels.set(name, new Set());
  channels.get(name).add(conn);
}
function leave(conn) {
  if (conn.channel && channels.has(conn.channel)) {
    channels.get(conn.channel).delete(conn);
    if (channels.get(conn.channel).size === 0) channels.delete(conn.channel);
  }
}
function broadcast(channel, opcode, payload) {
  const set = channels.get(channel);
  if (!set) return 0;
  const frame = encodeFrame(opcode, payload);
  let n = 0;
  for (const conn of set) {
    if (conn.socket.writable) { conn.socket.write(frame); n++; }
    else { set.delete(conn); }
  }
  return n;
}

// ---------- RFC6455 最小实现 ----------
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 从累积缓冲解析客户端帧（客户端帧必须带掩码）；返回剩余未消费字节。msg = {fin,opcode,data} */
function decodeFrames(buf, onMessage) {
  let offset = 0;
  while (buf.length - offset >= 2) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) { if (buf.length - pos < 2) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (buf.length - pos < 8) break; const big = buf.readBigUInt64BE(pos); if (big > BigInt(64 * 1024 * 1024)) { onMessage({ error: new Error('frame too large') }); break; } len = Number(big); pos += 8; }
    if (!masked) { onMessage({ error: new Error('client frame must be masked') }); break; }
    if (buf.length - pos < 4 + len) break; // 等更多数据
    const mask = buf.subarray(pos, pos + 4); pos += 4;
    const data = Buffer.from(buf.subarray(pos, pos + len)); // 复制后再解掩码，安全
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    offset = pos + len;
    onMessage({ fin, opcode, data });
  }
  return buf.subarray(offset);
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://x');
  const m = /^\/stream\/(.+)$/.exec(url.pathname);
  if (!m || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
  const name = decodeURIComponent(m[1]);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`
  );
  const conn = { socket, channel: name, frag: null, rest: Buffer.alloc(0) };
  join(name, conn);
  console.log(`[gateway] 订阅 ${name} (${channels.get(name).size} 在线)`);

  socket.on('data', chunk => {
    conn.rest = decodeFrames(Buffer.concat([conn.rest, chunk]), msg => {
      if (msg.error) { socket.destroy(); return; }
      if (msg.opcode === 0x8) { socket.end(encodeFrame(0x8, msg.data.subarray(0, 2))); return; } // close
      if (msg.opcode === 0x9) { socket.write(encodeFrame(0xA, msg.data)); return; }               // ping→pong
      // 文本帧作为通道内控制信令广播给其他订阅者；二进制同样转发（教学用回显语义）
      broadcast(name, msg.opcode, msg.data);
    });
  });
  const cleanup = () => { leave(conn); console.log(`[gateway] 断开 ${name}`); socket.destroy(); };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ---------- HTTP：状态页与推流入口 ----------
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  const pub = /^\/publish\/(.+)$/.exec(url.pathname);

  if ((req.method === 'POST' || req.method === 'PUT') && pub) {
    const name = decodeURIComponent(pub[1]);
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; broadcast(name, 0x2, chunk); }); // 边收边转，低延迟
    req.on('end', () => {
      console.log(`[gateway] 推流结束 ${name}（共 ${bytes} 字节）`);
      res.writeHead(204); res.end();
    });
    req.on('error', () => { try { res.writeHead(500); res.end(); } catch {} });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      hint: '推流: POST /publish/<name>；订阅: ws://host:<port>/stream/<name>',
      channels: [...channels.entries()].map(([n, s]) => ({ name: n, subscribers: s.size }))
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404：可用端点 GET /status、POST /publish/<name>、WS /stream/<name>');
});
server.on('upgrade', handleUpgrade);
// 端口冲突：给出可操作的中文提示（网关默认 8090，演示服务器默认 8080）
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[gateway] 端口 ${PORT} 已被占用（可能是另一个 gateway/serve 实例）。`);
    console.error(`[gateway] 换端口启动： PORT=${PORT + 1} npm run gateway`);
    console.error(`[gateway] 查看占用进程： lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => console.log(`[gateway] ws://127.0.0.1:${PORT}/stream/<name> 就绪`));
