/**
 * WS 之上的两种「帧协议」解析：
 *
 * 1. InterleavedWireParser —— 等价于 RTSP over TCP 的字节流语义。
 *    字节流由两类单元交错组成：
 *      - '$' 块：0x24 + channel(1B) + length(2B, 大端) + 载荷(RTP/RTCP)
 *      - RTSP 消息：ASCII 文本，以 \r\n\r\n 结束（可带 body，按 Content-Length 读取）
 *    输入可以任意切分（半包/粘包均可），输出结构化事件。
 *
 * 2. BareRtpParser —— 纯 RTP-over-WS：每条二进制消息恰为一个完整 RTP 包
 *    （同时容忍一条消息内多个连续 RTP 包的拼接形态）。
 */

import { errors } from './errors.js';

export class InterleavedWireParser {
  constructor() {
    this.buffer = [];
    this.bufferLen = 0;
    this.maxBuffer = 4 * 1024 * 1024; // 防御异常流
    this.onInterleaved = null; // (channel, bytes) => void
    this.onResponse = null; // ({statusLine, headers, body}) => void
    // 文本消息累积状态
    this.textState = null; // {headersDone, headerText, contentLength}
  }

  /** 喂入一段字节（WS 二进制消息或其片段） */
  push(bytes) {
    if (!bytes || bytes.length === 0) return;
    this.buffer.push(bytes);
    this.bufferLen += bytes.length;
    if (this.bufferLen > this.maxBuffer) throw errors.source('interleaved 流缓冲超限');
    this.#drain();
  }

  #drain() {
    for (;;) {
      const view = flatten(this.buffer);
      if (view.length === 0) return;
      if (view[0] === 0x24) {
        if (view.length < 4) return; // 头不全
        const len = (view[2] << 8) | view[3];
        if (view.length < 4 + len) return;
        const payload = view.subarray(4, 4 + len);
        consume(this.buffer, 4 + len);
        const channel = view[1];
        if (this.onInterleaved) this.onInterleaved(channel, payload);
      } else {
        // 寻找 \r\n\r\n
        let headEnd = -1;
        for (let i = 0; i + 3 < view.length; i++) {
          if (view[i] === 13 && view[i + 1] === 10 && view[i + 2] === 13 && view[i + 3] === 10) {
            headEnd = i;
            break;
          }
        }
        if (headEnd < 0) return; // 头未完整
        const headerBytes = view.subarray(0, headEnd);
        const headerText = latinize(headerBytes);
        const contentLength = parseContentLength(headerText);
        const total = headEnd + 4 + contentLength;
        if (view.length < total) return; // body 未完整
        const body = view.subarray(headEnd + 4, total);
        consume(this.buffer, total);
        if (this.onResponse) {
          this.onResponse(parseResponse(headerText, latinize(body)));
        }
      }
    }
  }
}

/**
 * 纯 RTP-over-WS：约定一条二进制消息恰为一个完整 RTP 包。
 * RTP 头本身无长度字段，无法可靠切分拼接流，因此不做多包拆分；
 * 返回 [整条消息] 供上层统一走 parseRtp。
 */
export function splitBareRtpMessage(msg) {
  return [msg];
}

function flatten(parts) {
  if (parts.length === 1) return parts[0];
  const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}

function consume(parts, n) {
  while (n > 0 && parts.length) {
    const p = parts[0];
    if (p.length <= n) {
      n -= p.length;
      parts.shift();
    } else {
      parts[0] = p.subarray(n);
      n = 0;
    }
  }
}

function latinize(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parseContentLength(headerText) {
  const m = /content-length:\s*(\d+)/i.exec(headerText);
  return m ? Number(m[1]) : 0;
}

/** 解析 RTSP 响应头文本 */
export function parseResponse(headerText, bodyText = '') {
  const lines = headerText.split('\r\n').filter(Boolean);
  const statusLine = lines.shift() ?? '';
  const headers = {};
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  const sm = /^RTSP\/(\d\.\d)\s+(\d+)\s*(.*)$/.exec(statusLine);
  return {
    statusLine,
    version: sm?.[1] ?? '1.0',
    code: sm ? Number(sm[2]) : 0,
    reason: sm?.[3]?.trim() ?? '',
    headers,
    body: bodyText,
  };
}
