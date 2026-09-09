/**
 * GatewayChunkSource —— rtmp/ws-flv 桥接的传输源（CONTRACTS §9.4 / §10）。
 *
 * 职责边界（传输层不碰 Sample，§2.1）：
 *   - WS 二进制消息 = FLV 字节流分块 → 原样 emit('data', chunk)；
 *   - WS 文本消息 = §9.2 JSON 信令：meta/eos/error/hello；
 *     · 容忍自回声（§9.1 硬性义务）：忽略自己发出的 hello/未知回显不产生副作用；
 *     · meta 缺席时不伪造（消费端须对首个二进制分块做 probe 嗅探）——仅透传真实收到的 meta；
 *     · eos 缺席时以空闲超时判定断流（默认 30s，可配），发 'stall' 事件并继续等待重推
 *       （「上游被杀 → 自动续播」的语义基础）；真正的 WS 关闭走 'end'/'error'。
 *
 * ChunkSource 形状（§2.1 typedef）：本对象可被下游以 write/end 驱动，
 * 也可作为事件源驱动下游（on('data'|'end'|'error')），两种用法等价。
 */

import { MiniEmitter } from './mini-emitter.js';
import { errors } from './errors.js';
import { assertSafeWsUrl } from '../../core/src/url-guard.js';

/** §9.2 信令类型集合；未知 type 静默忽略 */
const KNOWN_SIGNALS = new Set(['meta', 'eos', 'error', 'hello']);

/** 单条 JSON 信令文本上界：1MB（meta 通常几 KB） */
const MAX_SIGNAL_TEXT = 1 << 20;

export class GatewayChunkSource extends MiniEmitter {
  constructor(options = {}) {
    super();
    this.opts = {
      // I5：网关地址只允许 ws/wss（rtmp:// 需先经 resolveSourceUrl 映射），
      // 拒绝 file:/data:/javascript: 等被诱导的协议
      url: options.url ? assertSafeWsUrl(options.url, { what: 'rtmp/ws-flv 网关' }) : '',
      /** 空闲超时毫秒（eos 缺席时的断流判定，§9.2 建议 30s） */
      idleTimeoutMs: options.idleTimeoutMs ?? 30000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10000,
    };
    this.ws = null;
    this.meta = null; // 仅来自真实信令，绝不伪造
    this.bytesIn = 0;
    this.stopped = false;
    this._idleTimer = null;
    this._connectTimer = null;
    this._lastDataAt = 0;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  async start() {
    if (this.started) throw errors.state('source 已启动');
    this.started = true;
    const url = this.opts.url;

    await new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      this._connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(errors.timeout(`连接网关超时: ${url}`));
      }, this.opts.connectTimeoutMs);

      ws.onopen = () => {
        clearTimeout(this._connectTimer);
        if (!settled) {
          settled = true;
          resolve();
        }
        // 订阅方握手自报（§9.2 可选）；服务端会广播回来，必须容忍自身回声
        try {
          ws.send(JSON.stringify({ type: 'hello', ua: 'pureplay-rtmp/0.1' }));
        } catch {}
        this.#armIdleTimer();
      };
      ws.onerror = () => {
        clearTimeout(this._connectTimer);
        if (!settled) {
          settled = true;
          reject(errors.network(`网关连接失败: ${url}`));
        }
      };
      ws.onclose = ({ code, reason }) => this.#onClose(code, reason);
      ws.onmessage = (ev) => this.#onMessage(ev.data);
    });

    this.emit('open');
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this._idleTimer);
    clearTimeout(this._connectTimer);
    if (this.ws && this.ws.readyState <= 1) {
      try {
        this.ws.close(1000, 'client stop');
      } catch {}
    }
    this.emit('end', { byUser: true });
  }

  #onMessage(data) {
    if (this.stopped) return;
    if (typeof data === 'string') {
      this.#onSignal(data);
      return;
    }
    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
    this.bytesIn += chunk.length;
    this._lastDataAt = Date.now();
    this.#armIdleTimer();
    // ChunkSource 形状：write(chunk)
    this.emit('data', chunk);
    this.emit('write', chunk);
  }

  #onSignal(text) {
    // I5：先按长度熔断再解析（防超大文本消息撑爆内存 / 长时间占用主线程）
    if (typeof text !== 'string' || text.length > MAX_SIGNAL_TEXT) return;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      // 非 JSON 文本（例如网关原样转发的其他控制串）：静默忽略
      return;
    }
    if (!obj || typeof obj !== 'object' || !KNOWN_SIGNALS.has(obj.type)) {
      // §9.2：未知 type 或非法结构静默忽略
      return;
    }
    switch (obj.type) {
      case 'meta':
        // 自回声防御：内容相同的 meta 可能因频道补发重复到达，幂等处理
        this.meta = obj;
        this.emit('meta', obj);
        break;
      case 'eos':
        clearTimeout(this._idleTimer);
        this.emit('end', { reason: 'eos' });
        break;
      case 'error':
        this.emit('error', errors.network(obj.message ?? '发布侧异常', { code: obj.code }));
        break;
      case 'hello':
        // 自身或其他订阅者的握手回声：无副作用
        break;
    }
  }

  #armIdleTimer() {
    clearTimeout(this._idleTimer);
    if (this.stopped || !this.connected) return;
    this._idleTimer = setTimeout(() => {
      if (this.stopped) return;
      // eos 缺席 + 空闲超时 ⇒ 判定断流，但不主动关闭：等待上游重推自动续播
      this.emit('stall', { idleMs: this.opts.idleTimeoutMs });
      this.#armIdleTimer();
    }, Math.max(50, this.opts.idleTimeoutMs));
    this._idleTimer.unref?.();
  }

  #onClose(code, reason) {
    clearTimeout(this._idleTimer);
    if (this.stopped) return;
    this.emit('close', { code, reason });
    this.emit('end', { reason: 'closed', code });
  }
}

/**
 * 工厂（CONTRACTS §10 传输模块形状）。
 * @param {{url:string}} options resolveSourceUrl 的产出地址
 * @returns {Promise<GatewayChunkSource>} resolve 于 WS 就绪
 */
export async function createSource(options = {}) {
  const source = new GatewayChunkSource(options);
  await source.start();
  return source;
}
