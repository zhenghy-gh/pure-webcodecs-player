/**
 * rtsp-ws 模拟中继：在 WebSocket 之上模拟一台「RTSP over TCP(interleaved)」服务器。
 *
 * 两种帧协议（与 rtsp/ 客户端一一对应）：
 *  1. /rtsp   —— interleaved 模式：整条 WS 二进制消息等价于 RTSP/TCP 线上字节。
 *     - 入站：客户端把 RTSP 请求文本（OPTIONS/DESCRIBE/SETUP/PLAY/TEARDOWN）
 *       作为一条 WS 二进制消息发出（也可发文本消息，服务端同样解析）；
 *     - 出站：RTSP 响应为一条 WS 二进制消息（原始响应文本字节），
 *       媒体数据为 $ interleaved 块（0x24 + channel + len + RTP），偶数信道 0 走
 *       RTP，奇数信道 1 周期性发送 RTCP SR。
 *  2. /rtp    —— 纯 RTP-over-WS 模式：无握手，每条 WS 二进制消息恰为一个完整
 *       RTP 包；SDP 通过 HTTP GET /sdp 带外获取。
 *
 * 公共查询参数：
 *   mode=passive      连接后立即推流，跳过 RTSP 握手
 *   frames=N          推送 N 个 RTP 包后正常关闭（重连测试钩子）
 *   chaos=dropEvery:N 每 N 个 RTP 包丢弃 1 个（丢包容错测试钩子）
 *   intervalMs=X      覆盖包间隔毫秒数（默认按帧率节流）
 */

import { createWsHttpServer } from './ws-server.js';
import {
  packetizeAccessUnit,
  makeSenderReport,
  interleaveFrame,
} from './rtp-packer.js';
import {
  makeParameterSets,
  makeIdrFrame,
  VIDEO_FPS,
  CLOCK_RATE,
  spropParameterSets,
  profileLevelIdHex,
} from './media/h264-pcm.js';

const SSRC = 0x1234abcd;
const PAYLOAD_TYPE = 96;

/** 生成 SDP 文本（DESCRIBE 响应体与 GET /sdp 共用） */
export function makeSdpText({ host = '127.0.0.1' } = {}) {
  return [
    'v=0',
    `o=- 20260825 1 IN IP4 ${host}`,
    's=Gateway Test Stream (H264 I_PCM)',
    't=0 0',
    'm=video 5004 RTP/AVP 96',
    'c=IN IP4 127.0.0.1',
    'a=control:trackID=0',
    `a=rtpmap:96 H264/${CLOCK_RATE}`,
    'a=fmtp:96 packetization-mode=1;' +
      `profile-level-id=${profileLevelIdHex()};` +
      `sprop-parameter-sets=${spropParameterSets()}`,
    '',
  ].join('\r\n');
}

function rtpTimestampFor(frameIndex) {
  return ((frameIndex % 65536) * Math.floor(CLOCK_RATE / VIDEO_FPS)) >>> 0;
}

/**
 * 创建 rtsp-ws 中继服务器。
 */
export function createRtspWsRelay({ host = '127.0.0.1', port = 8322 } = {}) {
  const server = createWsHttpServer(onConnection, ['/rtsp', '/rtp', '/healthz']);
  const stats = { connections: 0, rtpSent: 0 };
  const mediaTimers = new Set(); // 每连接推流/SR 计时器（dispose 兜底清理）

  server.httpHandler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sdp') {
      res.writeHead(200, { 'content-type': 'application/sdp' });
      res.end(makeSdpText());
      return;
    }
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'rtsp-ws-relay', ...stats }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  };

  function onConnection(conn, req) {
    stats.connections++;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const passive = url.searchParams.get('mode') === 'passive';
    const maxPackets = Number(url.searchParams.get('frames') ?? Infinity);
    const dropEvery = Number(url.searchParams.get('chaos')?.split(':')[1] ?? 0);
    const intervalMs = Number(url.searchParams.get('intervalMs') ?? 0) || Math.floor(1000 / VIDEO_FPS);

    conn.on('close', () => stats.connections--);

    const session = {
      state: passive ? 'playing' : 'idle', // idle → described → setup → playing/paused
      seq: Math.floor(Math.random() * 1000),
      frameIndex: 0,
      packetsSent: 0,
      generated: 0,
      timer: null,
      replyAsText: false, // 客户端用文本请求则回文本；二进制请求回二进制
      sessionId: 'CAFE0001',
    };

    // ---- 出站工具 ----
    const sendRaw = (bytesLike) => {
      if (!conn.alive) return;
      if (typeof bytesLike === 'string' && !session.replyAsText) {
        conn.send(Buffer.from(bytesLike, 'utf8'));
      } else {
        conn.send(bytesLike);
      }
    };

    const sendInterleaved = (channel, bytes) => sendRaw(Buffer.from(interleaveFrame(channel, bytes)));

    const startStreaming = () => {
      if (session.timer) return;
      const tick = () => {
        if (!conn.alive) {
          stopStreaming();
          return;
        }
        const { sps, pps } = makeParameterSets();
        // 首帧携带 SPS/PPS（IDR 前置参数集，符合直播惯例）
        const nals = session.frameIndex === 0 ? [sps, pps, makeIdrFrame(session.frameIndex)] : [makeIdrFrame(session.frameIndex)];
        const packets = packetizeAccessUnit(nals, {
          mtu: 350, // 故意较小，迫使 16x16 帧(~400B)产生 FU-A 分片，覆盖分片路径
          payloadType: PAYLOAD_TYPE,
          sequence: session.seq,
          timestamp: rtpTimestampFor(session.frameIndex),
          ssrc: SSRC,
        });
        let reachedLimit = false;
        for (const p of packets) {
          session.seq = (session.seq + 1) & 0xffff; // 无论是否发送都消耗序号
          session.generated++;
          // chaos：按「已生成」包计数逐包丢弃（被丢包同样编号，接收端可见跳变）。
          const willDrop = dropEvery > 0 && session.generated % dropEvery === 0;
          if (willDrop) continue;
          if (session.packetsSent >= maxPackets) {
            reachedLimit = true;
            break;
          }
          if (url.pathname === '/rtp') {
            sendRaw(p.bytes); // 纯 RTP-over-WS：一包一消息
          } else {
            sendInterleaved(0, p.bytes);
          }
          session.packetsSent++;
          stats.rtpSent++;
        }
        session.frameIndex++;
        if (reachedLimit) {
          stopStreaming();
          conn.close(1000, 'frame limit reached');
        }
      };
      if (url.pathname === '/rtsp') {
        // interleaved 模式额外周期性发送 RTCP SR（信道 1），覆盖奇数信道解析路径
        session.srTimer = setInterval(() => {
          if (conn.alive) {
            sendInterleaved(
              1,
              makeSenderReport({
                ssrc: SSRC,
                rtpTimestamp: rtpTimestampFor(session.frameIndex),
                packetCount: session.packetsSent,
                octetCount: 0,
                ntpSec: Math.floor(Date.now() / 1000),
                ntpFrac: 0,
              }),
            );
          }
        }, 2000);
        session.srTimer.unref();
      }
      session.timer = setInterval(tick, url.searchParams.get('speed') === 'fast' ? 0 : intervalMs);
      mediaTimers.add(session.timer);
      if (session.srTimer) mediaTimers.add(session.srTimer);
      if (url.searchParams.get('speed') === 'fast') setImmediate(tick);
    };

    const stopStreaming = () => {
      if (session.timer) {
        clearInterval(session.timer);
        mediaTimers.delete(session.timer);
        session.timer = null;
      }
      if (session.srTimer) {
        clearInterval(session.srTimer);
        mediaTimers.delete(session.srTimer);
        session.srTimer = null;
      }
    };

    if (passive) startStreaming();
    conn.on('close', stopStreaming);

    // ---- RTSP 文本协议处理 ----
    let pending = '';
    const handleRequest = (text) => {
      pending += text;
      pending = pending.replace(/^(?:\r\n)+/, ''); // 防御：吞掉孤儿空行
      let idx;
      while ((idx = pending.indexOf('\r\n\r\n')) >= 0) {
        const raw = pending.slice(0, idx + 4);
        pending = pending.slice(idx + 4);
        respondTo(parseRequest(raw));
      }
    };

    function parseRequest(raw) {
      const lines = raw.split('\r\n');
      const [method, target, version] = lines[0].split(' ');
      const headers = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(':');
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      return { method, target, version, headers, cseq: headers['cseq'] ?? '0' };
    }

    function respond(req, statusLine, extraHeaders = [], body = '') {
      const head = [
        statusLine,
        `CSeq: ${req.cseq}`,
        ...extraHeaders,
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n');
      sendRaw(head);
    }

    function respondTo(r) {
      if (!r.method) return;
      switch (r.method.toUpperCase()) {
        case 'OPTIONS':
          respond(r, 'RTSP/1.0 200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN']);
          break;
        case 'DESCRIBE': {
          const sdp = makeSdpText();
          respond(
            r,
            'RTSP/1.0 200 OK',
            ['Content-Type: application/sdp', 'Content-Base: rtsp://gateway/test/'],
            sdp,
          );
          session.state = 'described';
          break;
        }
        case 'SETUP':
          if (session.state !== 'setup' && session.state !== 'described' && session.state !== 'playing') {
            respond(r, 'RTSP/1.0 455 Method Not Valid In This State');
            break;
          }
          session.state = 'setup';
          respond(r, 'RTSP/1.0 200 OK', [
            `Session: ${session.sessionId};timeout=60`,
            'Transport: RTP/AVP/TCP;interleaved=0-1;ssrc=' + SSRC.toString(16).padStart(8, '0'),
          ]);
          break;
        case 'PLAY': {
          if (session.state !== 'setup' && session.state !== 'paused' && session.state !== 'playing') {
            respond(r, 'RTSP/1.0 455 Method Not Valid In This State');
            break;
          }
          session.state = 'playing';
          respond(r, 'RTSP/1.0 200 OK', [
            `Session: ${session.sessionId}`,
            `RTP-Info: url=rtsp://gateway/test/trackID=0;seq=${session.seq};rtptime=${rtpTimestampFor(session.frameIndex)}`,
          ]);
          startStreaming();
          break;
        }
        case 'PAUSE':
          session.state = 'paused';
          stopStreaming();
          respond(r, 'RTSP/1.0 200 OK', [`Session: ${session.sessionId}`]);
          break;
        case 'TEARDOWN':
          stopStreaming();
          respond(r, 'RTSP/1.0 200 OK', [`Session: ${session.sessionId}`]);
          setTimeout(() => conn.close(1000, 'teardown'), 50);
          break;
        default:
          respond(r, 'RTSP/1.0 501 Not Implemented');
      }
    }

    conn.on('message', ({ isText, data }) => {
      if (isText) {
        session.replyAsText = true;
        handleRequest(data.toString('utf8'));
      } else {
        // 二进制消息可能是纯文本请求，也可能已带 $ 前缀（透传场景）；两者都兼容
        const first = data.length ? data[0] : 0;
        if (first === 0x24) {
          // 客户端不该向网关发 $ 块；忽略
          return;
        }
        handleRequest(data.toString('utf8'));
      }
    });
  }

  server.stats = stats;
  /** 确定性收尾：清媒体计时器 → 断连接 → 关监听 */
  const baseDispose = server.dispose.bind(server);
  server.dispose = async () => {
    for (const t of [...mediaTimers]) clearInterval(t);
    mediaTimers.clear();
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
