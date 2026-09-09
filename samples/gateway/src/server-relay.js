/**
 * 通道中继服务（CONTRACTS §9 网关 WS 通道协议的权威实现）。
 *
 * 吸收自 scripts/gateway.mjs（冻结兼容入口）的通道模型，并落实 §9.3 三项增强：
 *   - POST/PUT /publish/<name>            HTTP 推流入口，body 边收边转（低延迟）
 *   - ws://host:port/stream/<name>        订阅端：二进制帧=字节流分块；文本帧=信令广播
 *   - GET /status（或 /）                  频道列表 JSON
 *   增强① publish 结束向频道合成广播 {"type":"eos"}
 *   增强② 频道记忆最近一条 meta，新订阅者 join 时补发
 *   增强③ POST /publish/<name>?meta=<urlencoded json> 首推注入
 *
 * 信令格式见 §9.2：一帧一个 UTF-8 JSON 对象；网关不解析业务字段，
 * 仅识别 type=meta/eos/error/hello 用于生命周期记账；未知类型原样转发。
 */

import { createWsHttpServer } from './ws-server.js';
import { SlowConsumerQueue } from './slow-consumer.js';

function signalFrame(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

/** 从 URL 查询提取 ?meta=<urlencoded json>（非法则返回 null） */
export function metaFromQuery(url) {
  const raw = url.searchParams.get('meta');
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * @param {{host?:string, port?:number}} [opts] port 默认 8090（与 npm run gateway 对齐）
 */
export function createChannelRelay({
  host = '127.0.0.1',
  port = 8090,
  /** 每订阅者出站积压上限（字节），超出丢旧块（慢消费背压） */
  maxQueuedBytes = 2 * 1024 * 1024,
  /** 服务端心跳间隔；0 关闭 */
  pingIntervalMs = 30000,
} = {}) {
  /** name → { subscribers:Set<WsConnection>, lastMeta:object|null, publishers:int } */
  const channels = new Map();
  const stats = { publishes: 0, bytesRelayed: 0, droppedForSlowConsumer: 0, droppedBytes: 0 };
  const queues = new WeakMap(); // WsConnection → SlowConsumerQueue

  const queueOf = (conn) => {
    if (!queues.has(conn)) {
      const q = new SlowConsumerQueue(conn, {
        maxQueuedBytes,
        onDrop: (len) => {
          stats.droppedForSlowConsumer++;
          stats.droppedBytes += len;
        },
      });
      queues.set(conn, q);
    }
    return queues.get(conn);
  };

  const getChannel = (name) => {
    if (!channels.has(name)) channels.set(name, { subscribers: new Set(), lastMeta: null, publishers: 0 });
    return channels.get(name);
  };

  function broadcastText(channel, text) {
    // 信令不排队、不丢弃
    for (const conn of channel.subscribers) conn.send(text);
  }
  function broadcastBinary(channel, chunk) {
    for (const conn of channel.subscribers) {
      queueOf(conn).enqueueBinary(chunk); // 慢消费：积压超限自动丢旧并经 onDrop 计入全局统计
    }
  }

  const server = createWsHttpServer(onConnection, ['/stream/', '/status'], { pingIntervalMs });
  server.httpHandler = (req, res) => {
    // CORS：本机联调无鉴权，放开便于浏览器直接 POST 推流
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pub = /^\/publish\/(.+)$/.exec(url.pathname);

    if ((req.method === 'POST' || req.method === 'PUT') && pub) {
      const name = decodeURIComponent(pub[1]);
      const channel = getChannel(name);
      let bytes = 0;
      // 增强③：?meta= 首推注入
      const injectedMeta = metaFromQuery(url);
      if (injectedMeta) {
        channel.lastMeta = injectedMeta;
        broadcastText(channel, JSON.stringify({ type: 'meta', ...injectedMeta }));
      }
      channel.publishers++;
      stats.publishes++;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        stats.bytesRelayed += chunk.length;
        broadcastBinary(channel, chunk); // 边收边转，低延迟
      });
      req.on('end', () => {
        channel.publishers--;
        // 增强①：publish 结束合成 eos（仅当该频道再无其他发布者）
        if (channel.publishers <= 0) {
          broadcastText(channel, JSON.stringify({ type: 'eos' }));
        }
        res.writeHead(204);
        res.end();
      });
      req.on('error', () => {
        try {
          res.writeHead(500);
          res.end();
        } catch {}
      });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            ok: true,
            hint: '推流: POST /publish/<name>[?meta=<json>]；订阅: ws://host:<port>/stream/<name>；慢消费策略=丢旧块并在此上报',
            channels: [...channels.entries()].map(([n, c]) => ({ name: n, subscribers: c.subscribers.size, hasMeta: !!c.lastMeta })),
          },
          null,
          2,
        ),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404：可用端点 GET /status、POST /publish/<name>、WS /stream/<name>');
  };

  function onConnection(conn, req) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const m = /^\/stream\/(.+)$/.exec(url.pathname);
    if (!m) {
      conn.close(1008, 'bad path');
      return;
    }
    const name = decodeURIComponent(m[1]);
    const channel = getChannel(name);
    channel.subscribers.add(conn);
    conn.on('close', () => channel.subscribers.delete(conn));

    // 增强②：join 时补发频道记忆的最近 meta
    if (channel.lastMeta) {
      conn.send(JSON.stringify({ type: 'meta', ...channel.lastMeta }));
    }

    conn.on('message', ({ isText, data }) => {
      if (isText) {
        // 文本帧 = 控制信令：原样广播给频道内所有人（含发送者自身回声——§9.1 客户端须容忍）
        broadcastText(channel, data.toString('utf8'));
      } else {
        // 订阅端上行的二进制罕见；按通道语义同样转发（保持管道对称）
        broadcastBinary(channel, data);
      }
    });
  }

  server.channels = channels;
  server.stats = stats;
  const baseDispose = server.dispose.bind(server);
  server.dispose = async () => {
    await baseDispose();
  };
  server.listen(port, host);
  // 端口就绪可等待：测试 before() 应 await server.ready（resolve 实际端口，支持 0=系统分配）
  server.ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
  return server;
}
