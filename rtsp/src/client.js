/**
 * RtspWsClient —— WebSocket 中继 RTSP 播放器客户端。
 *
 * 两种帧协议：
 *   - framing:'interleaved'（默认）：WS 承载 RTSP/TCP 线上字节（$ 块 + 内联响应），
 *     客户端可执行完整 OPTIONS→DESCRIBE→SETUP→PLAY 握手；
 *   - framing:'rtp'：每条 WS 二进制消息即一个 RTP 包，控制面带外
 *     （SDP 由 sdp / sdpUrl 选项提供，或从 SDP 文本解析）。
 *
 * 事件（on() 订阅）：
 *   open        连接建立
 *   sdp         SDP 解析完成 ({sdp, track})
 *   frame       一帧视频 ({codec, annexB, nals, keyframe, ptsMs, dtsMs, timestamp})
 *   state       状态机变化 ({from, to})
 *   stats       统计（周期性）
 *   close       关闭 ({code, reason})
 *   error       错误
 */

import { parseRtp } from './rtp.js';
import { assertSafeWsUrl } from '../../core/src/url-guard.js';
import { parseSdp, pickVideoTrack } from './sdp.js';
import { InterleavedWireParser, splitBareRtpMessage } from './framing.js';
import { H264Depacketizer } from './depacketize-h264.js';
import { H265Depacketizer } from './depacketize-h265.js';
import { toAnnexb } from './nal.js';
import { errors } from './errors.js';

/** 指数退避重连器 */
export class Backoff {
  constructor({ baseMs = 500, factor = 2, maxMs = 30000, jitter = 0.3 } = {}) {
    this.baseMs = baseMs;
    this.factor = factor;
    this.maxMs = maxMs;
    this.jitter = jitter;
    this.attempt = 0;
  }

  next() {
    const raw = Math.min(this.baseMs * Math.pow(this.factor, this.attempt), this.maxMs);
    const j = raw * this.jitter * (Math.random() * 2 - 1);
    this.attempt++;
    return Math.max(50, Math.round(raw + j));
  }

  reset() {
    this.attempt = 0;
  }
}

export const STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  DESCRIBING: 'describing',
  SETTING_UP: 'setting-up',
  PLAYING: 'playing',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
});

const CRLF = '\r\n';

export class RtspWsClient {
  constructor(options = {}) {
    this.opts = {
      // I5：RTSP-over-WS 隧道地址只允许 ws/wss
      url: options.url ? assertSafeWsUrl(options.url, { what: 'RTSP WebSocket 隧道' }) : '',
      framing: options.framing ?? 'interleaved', // 'interleaved' | 'rtp'
      autoPlay: options.autoPlay !== false,
      // interleaved 模式下是否执行 RTSP 握手（passive 网关可关）
      handshake: options.handshake !== false,
      /** 外部提供的 SDP 文本（rtp 模式必填，interleaved 可省略走 DESCRIBE） */
      sdp: options.sdp ?? null,
      sdpUrl: options.sdpUrl ?? null,
      payloadType: options.payloadType ?? null,
      reconnect: options.reconnect !== false,
      /** 重连退避参数（对象形式传入，内部实例化为 Backoff） */
      backoff: new Backoff(options.backoff ?? {}),
      keepAliveMs: options.keepAliveMs ?? 25000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10000,
      clockRate: options.clockRate ?? 90000,
    };
    this.state = STATES.IDLE;
    this.handlers = new Map();
    this.stats = {
      packets: 0,
      lost: 0,
      frames: 0,
      reconnects: 0,
      bytes: 0,
    };
    this.ws = null;
    this.wire = null;
    this.depacketizer = null;
    this.track = null; // pickVideoTrack 结果
    this.session = '';
    this.cseq = 0;
    this.pendingResolve = null; // 简单请求-响应配对
    this.firstTs = null;
    this.keepAliveTimer = null;
    this.closedByUser = false;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  #emit(event, arg) {
    const fns = this.handlers.get(event) ?? [];
    for (const fn of fns) {
      try {
        fn(arg);
      } catch (err) {
        console.error(`[rtsp-ws] ${event} 处理器异常:`, err);
      }
    }
  }

  #setState(to) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.#emit('state', { from, to });
  }

  async start() {
    if (!this.opts.url) throw errors.state('缺少 url，无法启动');
    if (this.state !== STATES.IDLE && this.state !== STATES.CLOSED) throw errors.state(`当前状态 ${this.state} 不允许重复 start`);
    this.closedByUser = false;
    await this.#connect();
  }

  stop() {
    this.closedByUser = true;
    clearInterval(this.keepAliveTimer);
    clearTimeout(this.#reqTimer);
    if (this.ws && this.ws.readyState <= 1) this.ws.close(1000, 'client stop');
    this.#setState(STATES.CLOSED);
  }

  // ---------- 连接与协议 ----------

  async #connect() {
    this.#setState(this.state === STATES.PLAYING ? STATES.RECONNECTING : STATES.CONNECTING);
    await new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.opts.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const to = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(errors.timeout('WebSocket 连接超时'));
        }
      }, this.opts.connectTimeoutMs ?? 10000);

      ws.onopen = () => {
        clearTimeout(to);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(to);
        if (!settled) {
          settled = true;
          reject(errors.network('WebSocket 连接失败'));
        }
      };
      ws.onclose = (ev) => this.#onClose(ev?.code ?? 1006, ev?.reason ?? '');
      ws.onmessage = (ev) => this.#onMessage(ev.data);
    });

    this.#emit('open', {});
    this.stats.reconnects += this.state === STATES.RECONNECTING ? 1 : 0;
    this.opts.backoff.reset();

    if (this.opts.framing === 'interleaved') {
      this.wire = new InterleavedWireParser();
      this.wire.onInterleaved = (channel, bytes) => this.#onInterleaved(channel, bytes);
      this.wire.onResponse = (resp) => this.#onResponse(resp);
    } else {
      this.wire = null;
    }

    clearInterval(this.keepAliveTimer);

    if (this.opts.framing === 'interleaved' && this.opts.handshake) {
      // 完整握手流程。注意：每条连接都必须完整走一遍（服务端会话状态不跨连接），
      // this.track 只是解码参数缓存，不能作为「已握手」依据。
      this.session = '';
      await this.request('OPTIONS', '*', {});
      if (this.opts.sdp) {
        this.#consumeSdp(this.opts.sdp);
      } else {
        const describe = await this.request('DESCRIBE', this.opts.url, { Accept: 'application/sdp' });
        this.#consumeSdp(describe.body);
      }
      const transport =
        `RTP/AVP/TCP;interleaved=0-1` +
        (this.track ? `;profile=${this.track.packetizationMode ?? 1}` : '');
      const setup = await this.request('SETUP', `${this.opts.url}/trackID=0`, { Transport: transport });
      this.session = setup.headers['session']?.split(';')[0] ?? '';
      await this.request('PLAY', this.opts.url, { Session: this.session });
    } else {
      // rtp 模式或免握手：SDP 必须已可用
      if (this.opts.sdp) this.#consumeSdp(this.opts.sdp);
      else if (this.opts.sdpUrl) {
        const text = await fetchText(this.opts.sdpUrl);
        this.#consumeSdp(text);
      }
    }

    if (!this.track) {
      // 无 SDP 也无握手时按 H264/96 兜底（纯 RTP 直推场景）
      this.#setupTrack({ codec: 'h264', pt: this.opts.payloadType ?? 96, clock: this.opts.clockRate, parameterSets: { sps: [], pps: [] }, maxDonDiff: 0, packetizationMode: 1 }, null);
    }
    this.#setState(STATES.PLAYING);
    this.startKeepAlive();
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    if (this.opts.framing !== 'interleaved' || !this.opts.handshake) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === 1) {
        this.request('OPTIONS', '*', {}).catch(() => {});
      }
    }, this.opts.keepAliveMs);
  }

  /** 发送 RTSP 请求并等待匹配 CSeq 的响应 */
  request(method, target, extraHeaders = {}, body = '') {
    return new Promise((resolve, reject) => {
      if (this.opts.framing !== 'interleaved') {
        reject(errors.state(`${method} 仅在 interleaved 模式可用`));
        return;
      }
      const cseq = ++this.cseq;
      const lines = [
        `${method} ${target} RTSP/1.0`,
        `CSeq: ${cseq}`,
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        ...(body ? ['Content-Type: application/sdp', `Content-Length: ${body.length}`] : []),
      ];
      // 每行自带 CRLF，再补一个空行；body 为空时不得产生多余换行
      const text = lines.map((l) => l + CRLF).join('') + CRLF + body;
      const entry = { cseq, resolve, reject };
      this.pendingResolve = entry;
      try {
        this.#sendRawText(text);
      } catch (err) {
        this.pendingResolve = null;
        reject(err);
        return;
      }
      clearTimeout(this.#reqTimer);
      this.#reqTimer = setTimeout(() => {
        if (this.pendingResolve === entry) {
          this.pendingResolve = null;
          reject(errors.timeout(`${method} 响应超时`));
        }
      }, 8000);
    });
  }

  #reqTimer = null;

  #sendRawText(text) {
    if (this.ws?.readyState !== 1) throw errors.state('连接未就绪（尚未 start 或连接已断开）');
    // 以二进制发送：与 TCP 字节流语义一致；网关同时兼容文本
    this.ws.send(new TextEncoder().encode(text));
  }

  #onResponse(resp) {
    this.lastResponse = resp;
    const p = this.pendingResolve;
    if (p && Number(resp.headers['cseq'] ?? NaN) === p.cseq) {
      clearTimeout(this.#reqTimer); // 响应已匹配：撤销超时定时器，避免钉住事件循环
      this.pendingResolve = null;
      if (resp.code >= 200 && resp.code < 300) p.resolve(resp);
      else p.reject(resp.code >= 500
        ? errors.network(`RTSP ${resp.code} ${resp.reason}`)
        : errors.parse(`RTSP ${resp.code} ${resp.reason}`));
    }
  }

  #consumeSdp(text) {
    const sdp = parseSdp(text);
    const track = pickVideoTrack(sdp);
    this.#emit('sdp', { sdp, text, track });
    if (track) this.#setupTrack(track, text);
  }

  #setupTrack(track, sdpText) {
    this.track = track;
    const pt = this.opts.payloadType ?? track.pt ?? 96;
    this.depacketizer = track.codec === 'h265'
      ? new H265Depacketizer({ donl: (track.maxDonDiff ?? 0) > 0 })
      : new H264Depacketizer();
    void pt;
    void sdpText;
  }

  #onInterleaved(channel, bytes) {
    if (channel % 2 !== 0) return; // RTCP：当前仅透传计数
    this.#handleRtpBytes(bytes);
  }

  #onMessage(data) {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
    this.stats.bytes += u8.length;
    if (this.opts.framing === 'rtp') {
      for (const pkt of splitBareRtpMessage(u8)) this.#handleRtpBytes(pkt);
      return;
    }
    if (this.wire) this.wire.push(u8);
  }

  #handleRtpBytes(bytes) {
    if (!this.depacketizer) {
      // 未完成 SDP 协商前先兜底建轨
      this.#setupTrack({ codec: 'h264', pt: this.opts.payloadType ?? 96, clock: this.opts.clockRate, parameterSets: { sps: [], pps: [] }, maxDonDiff: 0, packetizationMode: 1 }, null);
    }
    let rtp;
    try {
      rtp = parseRtp(bytes);
    } catch (err) {
      this.#emit('error', err);
      return;
    }
    if (this.opts.payloadType != null && rtp.payloadType !== this.opts.payloadType) return;

    this.stats.packets++;
    const out = this.depacketizer.push(rtp.payload, rtp.marker, rtp.sequence, rtp.timestamp);
    this.stats.lost = this.depacketizer.stats.lost;

    if (out.nals && out.nals.length) {
      this.stats.frames++;
      if (this.firstTs === null) this.firstTs = rtp.timestamp;
      // 契约边界时间基 = 整数微秒（CONTRACTS §0.5）；ptsMs 仅为迁移期兼容别名
      const offsetTicks = rtp.timestamp - this.firstTs;
      const ptsUs = Math.max(0, Math.round((offsetTicks * 1_000_000) / (this.track?.clock ?? 90000)));
      this.#emit('frame', {
        codec: this.track?.codec ?? 'h264',
        annexB: toAnnexb(out.nals),
        nals: out.nals,
        keyframe: !!out.keyframe,
        dtsUs: ptsUs, // 无 B 帧场景 DTS=PTS
        ptsUs,
        ptsMs: Math.round(ptsUs / 1000),
        timestamp: rtp.timestamp,
        sequence: rtp.sequence,
      });
    }
  }

  #onClose(code, reason) {
    clearInterval(this.keepAliveTimer);
    this.#emit('close', { code, reason });
    if (this.closedByUser || !this.opts.reconnect) {
      this.#setState(STATES.CLOSED);
      return;
    }
    const delay = this.opts.backoff.next();
    this.#setState(STATES.RECONNECTING);
    const t = setTimeout(() => {
      if (!this.closedByUser) this.#connect().catch(() => {});
    }, delay);
    t.unref?.(); // Node 下不因待重连而钉住进程退出；浏览器环境无此 API 不受影响
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw res.status >= 500
      ? errors.network(`获取 SDP 失败: HTTP ${res.status}`)
      : errors.parse(`获取 SDP 失败: HTTP ${res.status}`);
  }
  return res.text();
}
