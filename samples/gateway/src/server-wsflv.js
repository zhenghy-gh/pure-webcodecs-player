/**
 * ws-flv 网关：接受 WebSocket 连接，按实时速率循环推送内置 FLV 流。
 *
 * 路径约定：
 *   ws://host:port/live/<任意流名>[?参数]
 * 参数：
 *   speed=fast     不按真实时间节流，尽快推送（压测/测试用）
 *   frames=N       推送 N 帧后以 1000 正常关闭（重连逻辑测试钩子）
 *   intervalMs=X   覆盖帧间隔毫秒数
 */

import { createWsHttpServer } from './ws-server.js';
import { FlvLoopSource } from './flv-builder.js';
import { VIDEO_FPS } from './media/h264-pcm.js';

export function createWsFlvGateway({ host = '127.0.0.1', port = 8321 } = {}) {
  const server = createWsHttpServer(onConnection, ['/live/', '/healthz']);
  const stats = { connections: 0, framesSent: 0 };
  const pumpTimers = new Set(); // 每连接推流计时器（dispose 时兜底清理）

  function onConnection(conn, req) {
    stats.connections++;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const speedFast = url.searchParams.get('speed') === 'fast';
    const maxFrames = Number(url.searchParams.get('frames') ?? Infinity);
    const intervalMs = Number(url.searchParams.get('intervalMs') ?? 0) || Math.floor(1000 / VIDEO_FPS);

    conn.on('close', () => {
      stats.connections--;
    });

    // 首块：FLV 文件头 + sequence header + metadata
    let source;
    try {
      source = new FlvLoopSource();
      conn.send(source.initChunk());
    } catch (err) {
      conn.close(1011, String(err?.message || err));
      return;
    }

    let sentFrames = 0;
    let closed = false;

    const pump = () => {
      if (closed || !conn.alive) return;
      try {
        for (const chunk of source.take(1)) {
          conn.send(chunk);
          sentFrames++;
          stats.framesSent++;
        }
        if (sentFrames >= maxFrames) {
          closed = true;
          clearInterval(timer);
          conn.close(1000, 'frame limit reached');
        }
      } catch (err) {
        closed = true;
        clearInterval(timer);
        conn.close(1011, String(err?.message || err));
      }
    };

    const timer = setInterval(pump, speedFast ? 0 : intervalMs);
    pumpTimers.add(timer);
    if (speedFast) setImmediate(pump);

    conn.on('close', () => {
      clearInterval(timer);
      pumpTimers.delete(timer);
    });
    conn.on('error', () => {
      clearInterval(timer);
      pumpTimers.delete(timer);
    });
  }

  server.httpHandler = (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'ws-flv-gateway', ...stats }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ws-flv 网关：请用 WebSocket 连接 ws://host:port/live/<stream>');
  };

  server.stats = stats;
  /** 确定性收尾：清推流计时器 → 断连接 → 关监听；resolve 后无残留句柄 */
  const baseDispose = server.dispose.bind(server);
  server.dispose = async () => {
    for (const t of [...pumpTimers]) clearInterval(t);
    pumpTimers.clear();
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
