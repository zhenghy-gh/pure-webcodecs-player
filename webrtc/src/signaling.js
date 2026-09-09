/**
 * signaling.js —— WebRTC 信令抽象
 *
 * 统一信令通道接口（适配点）：
 *   {
 *     connect(): Promise<void>
 *     exchange(localSdp, {signalCandidates}): Promise<{sdp:string, resourceUrl?:string}>
 *     sendCandidate?(candidate): Promise<void>       // trickle 场景
 *     close(): Promise<void>                          // 释放服务端资源（如 WHEP DELETE）
 *   }
 *
 * 内置两个实现：
 *  - WhepSignal：WHEP 标准（RFC 9725：HTTP POST SDP offer → 201 answer + Location）
 *  - WebSocketSignal：自定义 JSON 信令适配示例（{type:'offer'|'answer'|'candidate'}）
 *
 * fetch/WebSocket 均可注入，Node 单测零网络依赖。
 */

import { notSupported, networkError, parseError, stateError, timeoutError } from '../../core/src/errors.js';
import { assertSafeUrl, assertSafeWsUrl, isSafeUrl } from '../../core/src/url-guard.js';

/** 信令消息允许的类型白名单（未知 type 一律丢弃） */
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate', 'bye', 'error']);

/** 单条信令文本上界：8MB（正常 SDP 几 KB，JSON 信令更小） */
const MAX_SIGNAL_TEXT = 8 << 20;

/** 单个 SDP 字符串上界：1MB */
const MAX_SDP_LENGTH = 1 << 20;

/**
 * WS 信令消息 schema 校验（评审 I5：schema 校验后再取字段）。
 *
 * 校验点：类型白名单 → sdp 必须是有限长字符串 → candidate 必须是普通对象。
 * 注意 `__proto__`：`JSON.parse` 走 DefineOwnProperty 不会触发 setter 污染，
 * 但下游若把 candidate 直接 merge 进配置对象仍有风险，故在此拒绝带危险键的对象。
 *
 * @param {unknown} msg 已解析的 JSON 值
 * @returns {boolean} 是否可信
 */
export function isValidSignalMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (typeof msg.type !== 'string' || !SIGNAL_TYPES.has(msg.type)) return false;
  if ('sdp' in msg && typeof msg.sdp !== 'string') return false;
  if (typeof msg.sdp === 'string' && msg.sdp.length > MAX_SDP_LENGTH) return false;
  if ('candidate' in msg) {
    const c = msg.candidate;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    if (Object.keys(c).some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
      return false;
    }
  }
  return true;
}

/** 默认全局 fetch 的引用封装（便于测试替换） */
function defaultFetch(url, init) {
  if (typeof fetch !== 'function') {
    throw notSupported('当前环境无 fetch；请注入自定义 transport');
  }
  return fetch(url, init);
}

/* ------------------------------------------------------------------ */
/* WHEP（RFC 9725）                                                    */
/* ------------------------------------------------------------------ */

export class WhepSignal {
  /**
   * @param {string} endpointUrl WHEP 服务端点
   * @param {{fetchImpl?:Function, authToken?:string}} [options]
   */
  constructor(endpointUrl, options = {}) {
    this.endpointUrl = endpointUrl;
    this.fetchImpl = options.fetchImpl || defaultFetch;
    this.authToken = options.authToken || null;
    /** 服务端返回的资源地址（ICE restart / DELETE 用） */
    this.resourceUrl = null;
  }

  async connect() {
    /* WHEP 无独立连接阶段 */
  }

  /**
   * POST offer 换 answer。
   * @param {string} offerSdp 本地 offer
   * @returns {Promise<{sdp:string, resourceUrl:string|null}>}
   */
  async exchange(offerSdp) {
    const headers = {
      'Content-Type': 'application/sdp',
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    const res = await this.fetchImpl(this.endpointUrl, {
      method: 'POST',
      headers,
      body: offerSdp,
    });

    if (res.status !== 201 && res.status !== 200) {
      // 4xx/5xx：携带 SDP 的错误响应也应读出便于定位
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch { /* 忽略 */ }
      throw res.status >= 500
        ? networkError(`WHEP 协商失败: HTTP ${res.status} ${detail}`)
        : parseError(`WHEP 协商失败: HTTP ${res.status} ${detail}`);
    }

    const answer = await res.text();
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('sdp')) {
      throw parseError(`WHEP 响应 Content-Type 异常: ${contentType}`);
    }
    // Location 头指向资源端点（相对地址按端点解析）
    const location = res.headers.get('location');
    this.resourceUrl = null;
    if (location) {
      // I5：Location 头由服务端给出，必须过协议白名单后再使用（防被诱导到 file:/data:）
      if (isSafeUrl(location, { base: this.endpointUrl })) {
        try {
          this.resourceUrl = new URL(location, this.endpointUrl).href;
        } catch {
          this.resourceUrl = location;
        }
      } else {
        throw networkError(`WHEP Location 指向了不允许的协议: ${location}`);
      }
    }
    return { sdp: answer, resourceUrl: this.resourceUrl };
  }

  /**
   * Trickle ICE（可选增强）：PATCH 半成品 SDP 片段。
   * @param {string} sdpFragment application/trickle-ice-sdpfrag 文本
   */
  async sendCandidate(sdpFragment) {
    if (!this.resourceUrl) throw stateError('WHEP 尚未完成协商，无资源地址可 PATCH');
    await this.fetchImpl(this.resourceUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': '*',
      },
      body: sdpFragment,
    });
  }

  /** DELETE 资源：通知服务端释放会话 */
  async close() {
    if (!this.resourceUrl) return;
    try {
      await this.fetchImpl(this.resourceUrl, { method: 'DELETE' });
    } finally {
      this.resourceUrl = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 自定义 WebSocket JSON 信令（适配点示例）                             */
/* ------------------------------------------------------------------ */

/**
 * 自定义信令适配示例。消息协议（可按服务端实际调整——这正是适配点的意义）：
 *   客户端 → 服务端：{"type":"offer","sdp":...}
 *   服务端 → 客户端：{"type":"answer","sdp":...}
 *   双向          ：{"type":"candidate","candidate":{...}}
 */
export class WebSocketSignal {
  /**
   * @param {string} url ws:// 或 wss:// 地址
   * @param {{WebSocketImpl?:Function}} [options]
   */
  constructor(url, options = {}) {
    // I5：信令通道只允许 ws/wss
    this.url = assertSafeWsUrl(url, { what: 'WebRTC 信令' });
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket || null;
    /** @type {WebSocket|null} */
    this.ws = null;
    this._answerResolve = null;
    this._candidates = [];
    if (!this.WebSocketImpl) {
      // Node 环境未注入实现时延迟报错（connect 时），构造不抛——契约 §0.3
      this.WebSocketImpl = null;
    }
  }

  connect() {
    if (!this.WebSocketImpl) {
      return Promise.reject(notSupported('当前环境无 WebSocket 实现；请通过 WebSocketImpl 注入'));
    }
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(networkError(`WebSocket 连接失败: ${this.url}`));
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        // I5：先按长度熔断，再解析，最后做 schema 校验（防超大消息与字段类型欺骗）
        if (ev.data.length > MAX_SIGNAL_TEXT) return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return; // 非法 JSON 静默忽略
        }
        if (!isValidSignalMessage(msg)) return;
        if (msg.type === 'answer' && this._answerResolve) {
          this._answerResolve(msg.sdp);
          this._answerResolve = null;
        } else if (msg.type === 'candidate') {
          this._candidates.push(msg.candidate);
        }
        // 未知 type 静默忽略
      };
    });
  }

  /**
   * 发送 offer 并等待 answer。
   * @param {string} offerSdp
   */
  exchange(offerSdp) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(stateError('WebSocket 未连接'));
        return;
      }
      const timeout = setTimeout(() => {
        this._answerResolve = null;
        reject(timeoutError('等待 answer 超时（10s）'));
      }, 10000);
      this._answerResolve = (sdp) => {
        clearTimeout(timeout);
        resolve({ sdp, resourceUrl: null });
      };
      this.ws.send(JSON.stringify({ type: 'offer', sdp: offerSdp }));
    });
  }

  /** 转发 ICE 候选 */
  sendCandidate(candidate) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'candidate', candidate }));
    }
  }

  /** 取走期间收到的远端候选 */
  drainRemoteCandidates() {
    const out = this._candidates;
    this._candidates = [];
    return out;
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* 忽略 */ }
      this.ws = null;
    }
    return Promise.resolve();
  }
}

/** 按协议前缀选择信令实现的工厂 */
export function createSignalChannel(url, options = {}) {
  if (/^https?:/i.test(url)) return new WhepSignal(url, options);
  if (/^wss?:/i.test(url)) return new WebSocketSignal(url, options);
  throw parseError(`无法识别的信令地址协议: ${url}（支持 http(s)=WHEP / ws(s)=自定义）`);
}
