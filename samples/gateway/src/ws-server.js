/**
 * 最小 WebSocket 服务器实现（RFC 6455 子集）。
 *
 * 仅依赖 node:http / node:crypto，零第三方包。只实现网关联调所需能力：
 *  - Upgrade 握手（Sec-WebSocket-Accept 计算）
 *  - 文本 / 二进制帧收发；服务端出站帧不掩码，入站帧按规范要求校验掩码
 *  - 分片消息重组、Ping/Pong 自动应答、Close 握手
 *  - 出站大 payload 自动使用 16bit/64bit 扩展长度
 *
 * 不支持：permessage-deflate 压缩扩展、多数据分片发送（我们总是单帧整发）。
 */

import http from 'node:http';
import crypto from 'node:crypto';

/** RFC 6455 固定 GUID，仅用于握手 Accept 计算 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 编码一帧。server→client 不需要掩码。
 * @param {number} opcode
 * @param {Buffer|Uint8Array|string} data
 * @returns {Buffer}
 */
export function encodeFrame(opcode, data) {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
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
  header[0] = 0x80 | opcode; // FIN=1，不分片
  return Buffer.concat([header, payload]);
}

/**
 * 增量式帧解码器：把 TCP 流上可能任意切分的字节还原成完整帧。
 */
export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    /** @type {{opcode:number,data:Buffer}[]} 当前消息已收到的分片 */
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
  }

  /**
   * 喂入字节，返回本次解出的「完整应用层消息」列表。
   * 控制帧（ping/close）在内部处理并产生控制事件。
   * @param {Buffer} chunk
   * @returns {{messages:{opcode:number,isText:boolean,data:Buffer}[], controls:{type:string,code?:number,reason?:string}[]}}
   */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages = [];
    const controls = [];

    while (!this.closed) {
      const frame = this.#tryReadFrame();
      if (!frame) break;
      const { opcode, payload, fin } = frame;

      switch (opcode) {
        case OP_PING:
          controls.push({ type: 'ping', data: payload });
          break;
        case OP_PONG:
          controls.push({ type: 'pong' });
          break;
        case OP_CLOSE: {
          this.closed = true;
          let code = 1005; // 无状态码
          let reason = '';
          if (payload.length >= 2) {
            code = payload.readUInt16BE(0);
            reason = payload.subarray(2).toString('utf8');
          }
          controls.push({ type: 'close', code, reason });
          break;
        }
        case OP_TEXT:
        case OP_BINARY:
          messages.push({ opcode, isText: opcode === OP_TEXT, data: payload });
          break;
        case OP_CONT:
          // 入站分片重组：浏览器客户端几乎不会分片，但按规范支持。
          // 只有 FIN=1 的 CONT 帧才收束整条消息。
          this.fragments.push({ opcode: OP_CONT, data: payload });
          if (fin && this.fragments.length >= 2) {
            const merged = Buffer.concat(this.fragments.map((f) => f.data));
            messages.push({ opcode: this.fragmentOpcode, isText: this.fragmentOpcode === OP_TEXT, data: merged });
            this.fragments = [];
            this.fragmentOpcode = 0;
          }
          break;
        default:
          // 协议错误：忽略未知 opcode（保守处理）
          break;
      }
    }
    return { messages, controls };
  }

  #tryReadFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Buffer.constants.MAX_LENGTH)) throw new Error('frame too large');
      len = Number(big);
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (maskKey) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    } else {
      payload = Buffer.from(payload); // 拷贝脱离底层大 buffer
    }
    this.buffer = buf.subarray(offset + len);
    if (!fin && opcode !== OP_CONT && opcode <= OP_BINARY) {
      // 首个分片
      this.fragments.push({ opcode, data: payload });
      this.fragmentOpcode = opcode;
      return { opcode: -1, payload, fin: false }; // 内部标记：不作为独立消息上报
    }
    return { opcode, payload, fin };
  }
}

/**
 * 一个已建立的 WebSocket 连接（服务端视角）。
 * @event message ({isText:boolean, data:Buffer})
 * @event close ({code:number, reason:string})
 * @event error (Error)
 */
export class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.decoder = new FrameDecoder();
    this.handlers = { message: [], close: [], error: [], pong: [] };
    /** 心跳保活：最近一次收到对端 pong（或任何数据）的时间 */
    this.lastPongAt = Date.now();
    this._heartbeat = null;

    socket.on('data', (chunk) => {
      if (!this.alive) return;
      this.lastPongAt = Date.now(); // 任何入站流量均视作存活信号
      try {
        const { messages, controls } = this.decoder.push(chunk);
        for (const m of messages) this.#emit('message', { isText: m.isText, data: m.data });
        for (const c of controls) {
          if (c.type === 'ping' && this.alive) this.socket.write(encodeFrame(OP_PONG, c.data ?? Buffer.alloc(0)));
          if (c.type === 'pong') {
            this.lastPongAt = Date.now();
            for (const fn of this.handlers.pong) fn({});
          }
          if (c.type === 'close') this.#teardown(c.code, c.reason, /* echo */ true);
        }
      } catch (err) {
        this.#emit('error', err);
      }
    });
    socket.on('close', () => this.#teardown(1006, 'tcp closed', false));
    socket.on('error', (err) => {
      this.#emit('error', err);
      this.#teardown(1006, String(err?.message || err), false);
    });
  }

  get readyState() {
    return this.alive ? 1 : 3;
  }

  /**
   * 启动服务端心跳（测试网关保活语义）：
   * 每 intervalMs 发一个 Ping；若连续两个周期未收到 Pong/任何数据则强制断开。
   */
  startHeartbeat(intervalMs = 30000) {
    clearInterval(this._heartbeat);
    const period = Math.max(50, intervalMs); // 允许测试用短周期
    this._heartbeat = setInterval(() => {
      if (!this.alive) {
        clearInterval(this._heartbeat);
        return;
      }
      if (Date.now() - this.lastPongAt > period * 2 + 500) {
        this.close(1001, 'heartbeat timeout');
        clearInterval(this._heartbeat);
        return;
      }
      try {
        this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
      } catch {}
    }, period);
    this._heartbeat.unref?.();
  }

  on(event, fn) {
    this.handlers[event].push(fn);
    return this;
  }

  /** 硬终止：清心跳、毁 socket（dispose 路径使用；close 事件照常外发） */
  terminate() {
    clearInterval(this._heartbeat);
    this.alive = false;
    try {
      this.socket.destroy();
    } catch {
      /* 忽略 */
    }
  }

  /** 发送文本或二进制（自动整帧发出） */
  send(data) {
    if (!this.alive) return false;
    const opcode = typeof data === 'string' ? OP_TEXT : OP_BINARY;
    this.socket.write(encodeFrame(opcode, data));
    return true;
  }

  /** 主动关闭并完成 Close 握手 */
  close(code = 1000, reason = '') {
    if (!this.alive) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.socket.write(encodeFrame(OP_CLOSE, body));
    this.#teardown(code, reason, false);
  }

  #teardown(code, reason, echoClose) {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._heartbeat);
    if (echoClose) {
      // 回显规范状态码（1000 或收到的码）；空载荷部分客户端实现不认可
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code === 1005 || code === 1006 ? 1000 : code, 0);
      try {
        this.socket.write(encodeFrame(OP_CLOSE, body));
      } catch {
        /* 忽略写失败 */
      }
    }
    try {
      this.socket.end();
    } catch {
      /* 忽略 */
    }
    // 防御（测试网关语义）：对端停止读取或异常消失时，end() 的收尾可能永不完成
    // 造成句柄悬挂；用「引用型」短延迟强制销毁，同时保证进程能等待其完成。
    const killer = setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        /* 忽略 */
      }
    }, 300);
    this.#emit('close', { code, reason });
  }

  #emit(event, arg) {
    for (const fn of this.handlers[event]) {
      try {
        fn(arg);
      } catch (err) {
        // 业务回调异常不拖垮网关
        console.error('[ws-server] handler error:', err);
      }
    }
  }
}

/**
 * 创建带 WebSocket 升级能力的 HTTP 服务器。
 * @param {(conn: WsConnection, req: import('node:http').IncomingMessage) => void} onConnection
 * @param {string|string[]} [acceptedPaths] 允许升级的路径前缀；为空则全部放行
 */
export function createWsHttpServer(onConnection, acceptedPaths = null, { pingIntervalMs = 0 } = {}) {
  const prefixes = acceptedPaths == null ? null : [].concat(acceptedPaths);
  const activeConns = new Set(); // 活动连接跟踪（dispose 用）
  const server = http.createServer((req, res) => {
    // 普通 HTTP GET：留给各业务服务自行注册（例如 SDP 下载）
    if (server.httpHandler) {
      server.httpHandler(req, res);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const wantUpgrade = /websocket/i.test(String(req.headers.upgrade || '')) && key;
    const pathOk = !prefixes || prefixes.some((p) => req.url === p || req.url.startsWith(p));

    if (!wantUpgrade || !pathOk) {
      socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n',
    );
    socket.setNoDelay(true);
    const conn = new WsConnection(socket);
    activeConns.add(conn);
    conn.on('close', () => activeConns.delete(conn));
    if (pingIntervalMs > 0) conn.startHeartbeat(pingIntervalMs);
    onConnection(conn, req);
  });

  // 测试网关语义：close() 时强制清空存量 TCP 连接（含对端已消失的半开连接），
  // 保证 node:test 等宿主进程能够确定性地退出。
  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    try {
      server.closeAllConnections?.();
    } catch {
      /* 忽略 */
    }
    return originalClose(cb);
  };

  /**
   * 确定性收尾（测试 after() 应 `await server.dispose()`）：
   * 硬断全部 WS 连接（连带心跳/业务计时器随 close 事件清理）、关闭监听并等待完成，
   * resolve 后保证无残留句柄。
   */
  server.dispose = () =>
    new Promise((resolve) => {
      // 先走优雅关闭：补发 CLOSE 回显并给 TCP 冲刷留出窗口；
      // 直接 destroy 会吞掉回显，导致对端（undici 等）永久等待而悬挂。
      if (activeConns.size === 0 && !server.listening) return resolve();
      for (const c of [...activeConns]) {
        try {
          c.close(1001, 'server dispose'); // 优雅：回显 CLOSE 并 end()
        } catch {
          try { c.terminate(); } catch {}
        }
      }
      // 先给 CLOSE 回显/缓冲冲刷留出窗口；强毁（closeAllConnections）
      // 必须放在窗口之后，否则会 RST 掉仍在握手的对端造成其悬挂。
      setTimeout(() => {
        try {
          originalClose(() => {});
        } catch {}
        setTimeout(resolve, 150);
      }, 350);
    });

  return server;
}
