/**
 * player.js —— WebRTC 低延迟播放器
 *
 * 职责：
 *  - webrtc:// URL 抽象 → 信令通道（WHEP 标准或自定义适配点）
 *  - RTCPeerConnection 收流挂 <video>/<audio> 元素
 *  - 连接状态机与自动重连（指数退避 + 抖动）
 *  - 延迟统计（getStats，见 stats.js）
 *
 * 浏览器专属能力（RTCPeerConnection）全部经构造器注入，
 * Node 下仅可运行纯逻辑单测——契约 §0.3。
 */

import { createSignalChannel } from './signaling.js';
import { StatsCollector } from './stats.js';
import { notSupported, stateError, parseError } from '../../core/src/errors.js';

/** 播放器状态机（封闭集合，非法迁移抛错） */
export const WebRtcState = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  CLOSED: 'closed',
});

/** 合法迁移表 */
const TRANSITIONS = {
  [WebRtcState.IDLE]: [WebRtcState.CONNECTING, WebRtcState.CLOSED],
  [WebRtcState.CONNECTING]: [
    WebRtcState.CONNECTED, WebRtcState.RECONNECTING, WebRtcState.FAILED, WebRtcState.CLOSED,
  ],
  [WebRtcState.CONNECTED]: [
    WebRtcState.RECONNECTING, WebRtcState.FAILED, WebRtcState.CLOSED,
  ],
  [WebRtcState.RECONNECTING]: [
    // 重连即重新走 CONNECTING 流程
    WebRtcState.CONNECTING, WebRtcState.CONNECTED,
    WebRtcState.RECONNECTING, WebRtcState.FAILED, WebRtcState.CLOSED,
  ],
  [WebRtcState.FAILED]: [WebRtcState.CONNECTING, WebRtcState.CLOSED],
  [WebRtcState.CLOSED]: [],
};

/**
 * 重连退避计算（纯函数，Node 可测）。
 * 第 n 次重试延迟 = min(cap, base * 2^n) ± 20% 抖动。
 * @param {number} attempt 从 0 计的重试序号
 * @param {{baseMs?:number, capMs?:number, jitterRatio?:number, rand?:()=>number}} [opts]
 */
export function computeBackoffMs(attempt, opts = {}) {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 15000;
  const ratio = opts.jitterRatio ?? 0.2;
  const rand = opts.rand || Math.random;
  const raw = base * Math.pow(2, Math.max(0, attempt));
  const jitter = raw * ratio * (rand() * 2 - 1);
  // 封顶在加抖动之后：最终延迟不超过 capMs
  return Math.max(50, Math.min(cap, Math.round(raw + jitter)));
}

/**
 * 解析播放地址为信令通道参数。
 * 支持：http(s)://（WHEP）、ws(s)://（自定义）、webrtc://host/app/stream（映射为 https WHEP 端点）。
 * @returns {{channelUrl:string, kind:'whep'|'custom'}}
 */
export function parsePlayerUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw parseError('播放地址必须是非空字符串');
  if (/^https?:\/\//i.test(url)) return { channelUrl: url, kind: 'whep' };
  if (/^wss?:\/\//i.test(url)) return { channelUrl: url, kind: 'custom' };
  const m = /^webrtc:\/\/([^/]+)(\/[^?#]*)?/i.exec(url);
  if (m) {
    // 约定：webrtc://host/path → https://host/path/whep（服务端按此暴露端点时可零配置直用）
    const host = m[1];
    const path = (m[2] || '').replace(/\/+$/, '');
    return { channelUrl: `https://${host}${path}/whep`, kind: 'whep' };
  }
  throw parseError(`无法识别的播放地址: ${url}`);
}

export class WebRtcPlayer {
  /**
   * @param {object} [options]
   * @param {Function}  [options.RTCPeerConnectionImpl] 注入 PC 构造器（默认全局）
   * @param {object}    [options.signalChannel] 预构建的信令通道（否则按 URL 工厂创建）
   * @param {number}    [options.maxReconnectAttempts=5]
   * @param {number}    [options.statsIntervalMs=2000]
   * @param {(type:string,payload:object)=>void} [options.onEvent] 统一事件回调
   */
  constructor(options = {}) {
    this.PCImpl =
      options.RTCPeerConnectionImpl ||
      (typeof globalThis.RTCPeerConnection === 'function' ? globalThis.RTCPeerConnection : null);
    this.onEvent = options.onEvent || (() => {});
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.statsIntervalMs = options.statsIntervalMs ?? 2000;
    /** 重连退避参数（可注入以便测试用短延迟） */
    this.backoffOptions = {
      baseMs: options.backoffBaseMs ?? 1000,
      capMs: options.backoffCapMs ?? 15000,
      jitterRatio: 0,
    };

    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    this.channel = options.signalChannel || null;
    this.state = WebRtcState.IDLE;
    this.stream = null; // ontrack 得到的 MediaStream
    /** @type {StatsCollector|null} */
    this.statsCollector = null;

    this._videoEl = null;
    this._audioEl = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._destroyed = false;
    this._pendingCandidates = []; // trickle 候选缓冲（answer 到达前收到时暂存）
  }

  _setState(next) {
    if (!TRANSITIONS[this.state].includes(next)) {
      throw stateError(`非法状态迁移: ${this.state} -> ${next}`);
    }
    const prev = this.state;
    this.state = next;
    this.onEvent('statechange', { from: prev, to: next });
  }

  /**
   * 开始播放。
   * @param {string} url 播放地址（http(s)=WHEP / ws(s)=自定义 / webrtc://）
   * @param {{video?:HTMLVideoElement, audio?:HTMLAudioElement}} [elements]
   */
  async play(url, elements = {}) {
    if (!this.PCImpl) {
      throw notSupported('当前环境不支持 RTCPeerConnection');
    }
    this._videoEl = elements.video || null;
    this._audioEl = elements.audio || null;
    this._destroyed = false;

    const parsed = parsePlayerUrl(url);
    if (!this.channel) {
      this.channel = createSignalChannel(parsed.channelUrl);
    }
    await this._connect();
  }

  async _connect() {
    this._setState(WebRtcState.CONNECTING);

    const pc = new this.PCImpl({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;

    // 只收不发
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (ev) => {
      this.stream = ev.streams[0] || new MediaStream([ev.track]);
      this.onEvent('track', { kind: ev.track.kind, stream: this.stream });
      if (this._videoEl && ev.track.kind === 'video') this._videoEl.srcObject = this.stream;
      if (this._audioEl && ev.track.kind === 'audio') this._audioEl.srcObject = this.stream;
    };

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if (cs === 'connected') {
        this._reconnectAttempts = 0;
        if (this.state !== WebRtcState.CONNECTED) this._setState(WebRtcState.CONNECTED);
        this._startStats();
      } else if (cs === 'failed' || cs === 'disconnected') {
        this.onEvent('connectionlost', { connectionState: cs });
        this._scheduleReconnect();
      } else if (cs === 'closed') {
        if (this.state !== WebRtcState.CLOSED && !this._destroyed) {
          try { this._setState(WebRtcState.CLOSED); } catch { /* 迁移冲突忽略 */ }
        }
      }
    };

    // —— SDP 协商（默认非 trickle：等 ICE gathering 完成再交换，兼容最广服务端）——
    const offer = await pc.createOffer();
    await this._waitForIceGathering(pc, offer);
    const finalOffer = pc.localDescription ? pc.localDescription.sdp : offer.sdp;

    await this.channel.connect?.();
    const { sdp: answerSdp } = await this.channel.exchange(finalOffer);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // 自定义信令可能在协商期间收到远端候选
    for (const c of this.channel.drainRemoteCandidates?.() || []) {
      await this._addIceCandidate(c);
    }
  }

  _waitForIceGathering(pc, offer) {
    if (pc.iceGatheringState === 'complete') {
      return pc.setLocalDescription(offer);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => finish(), 3000); // 兜底：3s 后带部分候选也继续
      const finish = () => {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve(pc.setLocalDescription(offer));
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
      // 先 setLocal 再等 gathering 也可以；这里先 set 保证 localDescription 存在
      pc.setLocalDescription(offer).catch(() => finish());
    });
  }

  async _addIceCandidate(candidate) {
    try {
      await this.pc?.addIceCandidate(candidate);
    } catch (e) {
      this.onEvent('warn', { message: `候选添加失败: ${e.message}` });
    }
  }

  /* ---------------- 重连 ---------------- */

  _scheduleReconnect() {
    if (this._destroyed) return;
    if (this.state === WebRtcState.FAILED || this.state === WebRtcState.CLOSED) return;
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      this._setState(WebRtcState.FAILED);
      this.onEvent('error', { fatal: true, message: `重连 ${this.maxReconnectAttempts} 次仍失败` });
      return;
    }
    if (this.state !== WebRtcState.RECONNECTING) this._setState(WebRtcState.RECONNECTING);
    const delay = computeBackoffMs(this._reconnectAttempts, this.backoffOptions);
    this._reconnectAttempts += 1;
    this.onEvent('reconnecting', { attempt: this._reconnectAttempts, delayMs: delay });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this._destroyed) return;
      try {
        await this._teardownPc();
        await this._connect();
      } catch (err) {
        this.onEvent('warn', { message: `重连失败: ${err.message}` });
        this._scheduleReconnect();
      }
    }, delay);
  }

  /* ---------------- 统计 ---------------- */

  _startStats() {
    if (this.statsCollector) return; // 已在采集
    this.statsCollector = new StatsCollector(this.pc, this.statsIntervalMs);
    this.statsCollector.start((metrics) => this.onEvent('stats', metrics));
  }

  get stats() {
    return this.statsCollector?.latest || null;
  }

  /* ---------------- 生命周期 ---------------- */

  pause() {
    if (this._videoEl) this._videoEl.pause();
    if (this._audioEl) this._audioEl.pause();
  }

  resume() {
    if (this._videoEl) this._videoEl.play().catch(() => {});
    if (this._audioEl) this._audioEl.play().catch(() => {});
  }

  async _teardownPc() {
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch { /* 忽略 */ }
      this.pc = null;
    }
    this.statsCollector?.stop();
    this.statsCollector = null;
  }

  /** 销毁：关闭连接并尽力通知服务端释放资源（WHEP DELETE） */
  async destroy() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    await this._teardownPc();
    try {
      await this.channel?.close?.();
    } catch { /* 服务端释放失败不阻断销毁 */ }
    if (this._videoEl) this._videoEl.srcObject = null;
    if (this._audioEl) this._audioEl.srcObject = null;
    if (this.state !== WebRtcState.CLOSED) {
      try {
        this._setState(WebRtcState.CLOSED);
      } catch { /* 已是终态 */ }
    }
  }
}
