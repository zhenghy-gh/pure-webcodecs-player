/**
 * segment-loader.js —— HLS 分片加载器
 *
 * 基于 fetch + ReadableStream 的流式下载：
 *  - 支持普通分片与 BYTERANGE 分片（Range 请求头）
 *  - 流式进度回调（onProgress），便于大分片展示下载速度
 *  - AbortController 取消，供清晰度切换 / 销毁时中断在途请求
 *
 * 注意：跨域地址要求服务端返回 CORS 头（Access-Control-Allow-Origin）；
 *       Range 跨域还依赖 Access-Control-Expose-Headers: Content-Length 等。
 */

import { logger } from './utils.js';
import { PlayerError, ErrorCode } from '../../core/src/errors.js';
import { assertSafeUrl } from '../../core/src/url-guard.js';
import { DEFAULT_MAX_READ_BYTES, assertByteLength } from '../../core/src/limits.js';


const log = logger('loader');

/** fetch credentials 合法取值（fetch 规范 RequestCredentials） */
const CREDENTIALS_MODES = new Set(['omit', 'same-origin', 'include']);

/**
 * 网络层错误：继承契约 PlayerError，code 取封闭十码语义
 * （4xx → SOURCE_ERROR；超时 → TIMEOUT；其余网络类 → NETWORK_ERROR）。
 */
export class LoadError extends PlayerError {
  /**
   * @param {string} code PlayerError 封闭码
   * @param {string} message
   * @param {{url?: string, status?: number, fatal?: boolean, network?: boolean}} info
   */
  constructor(code, message, info = {}) {
    super(code, message);
    this.name = 'LoadError';
    this.url = info.url || '';
    this.status = info.status ?? 0;
    this.fatal = !!info.fatal;
    this.network = !!info.network;
  }
}

export class SegmentLoader {
  /**
   * @param {{maxRetry?:number, retryDelayMs?:number, timeoutMs?:number, credentials?:('omit'|'same-origin'|'include'), fetchImpl?:typeof fetch}} [options]
   *   fetchImpl：注入自定义获取器（单测离线 / 代理场景），缺省全局 fetch；
   *   credentials：请求凭据策略（评审 §17.3，旧实现硬编码 'omit' 导致带 Cookie 的
   *   授权源无法接入），缺省 'omit' 维持既有行为；非法取值构造期即抛 STATE_ERROR。
   *   maxBytes：单资源字节上界（默认 64MB），防畸形清单指向超大资源或超大分片撑爆内存。
   */
  constructor(options = {}) {
    this.maxRetry = options.maxRetry ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    /** 单次请求超时（毫秒）；超时按可重试网络错误处理并产出 TIMEOUT 码 */
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (options.credentials != null && !CREDENTIALS_MODES.has(options.credentials)) {
      throw new PlayerError(
        ErrorCode.STATE_ERROR,
        `非法 credentials 配置: ${options.credentials}（应为 omit / same-origin / include）`
      );
    }
    this.credentials = options.credentials ?? 'omit';
    // I3 缺陷：webidl fetch 以成员方法调用会因 receiver 非 Window 抛 Illegal invocation，
    // 存储时必须 bind 到 globalThis（http-range-source 已同法处理）。
    this._fetch = options.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : globalThis.fetch);
    if (typeof this._fetch !== 'function') {
      // 延迟到首次请求时报错，避免构造期破坏 Node 纯逻辑用法
      this._fetch = null;
    }
  }

  /** 组合外部 signal 与超时定时器的 AbortSignal */
  _boundedSignal(url, external) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`请求超时(${this.timeoutMs}ms)`)), this.timeoutMs);
    const onOuterAbort = () => ctrl.abort(external?.reason);
    if (external) {
      if (external.aborted) {
        clearTimeout(timer);
        throw new LoadError(ErrorCode.ABORTED, '请求已在外部取消', { url, fatal: true });
      }
      external.addEventListener('abort', onOuterAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      done: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onOuterAbort);
      },
    };
  }

  /**
   * 加载一个资源为 Uint8Array。
   * @param {string} url 绝对地址
   * @param {object} [opts]
   * @param {{length:number, offset:number}} [opts.byteRange] BYTERANGE 分片
   * @param {AbortSignal}     [opts.signal]
   * @param {(loaded:number, total:number|null)=>void} [opts.onProgress]
   * @returns {Promise<{data:Uint8Array, byteLength:number}>}
   */
  async load(url, opts = {}) {
    const { byteRange, signal, onProgress } = opts;
    if (!this._fetch) {
      throw new LoadError(ErrorCode.NOT_SUPPORTED, '当前环境无 fetch 且未注入 fetchImpl', { url, fatal: true });
    }
    // I5：协议白名单——清单里的 URI 可能指向 file:/blob:/data:/javascript:
    try {
      assertSafeUrl(url, { what: 'HLS 资源', base: this.baseUrl });
    } catch (err) {
      throw new LoadError(ErrorCode.NETWORK_ERROR, err.message, { url, fatal: true, network: true });
    }
    let lastErr = null;

    for (let attempt = 0; attempt <= this.maxRetry; attempt++) {
      let bounded = null;
      try {
        bounded = this._boundedSignal(url, signal);
        const headers = {};
        if (byteRange && byteRange.length > 0) {
          headers['Range'] = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
        }
        const res = await this._fetch(url, { headers: { ...headers }, signal: bounded.signal, mode: 'cors', credentials: this.credentials });
        if (!res.ok && res.status !== 206) {
          // 4xx 视为不可恢复资源错误，5xx 允许重试
          const fatal = res.status >= 400 && res.status < 500;
          throw new LoadError(
            fatal ? ErrorCode.SOURCE_ERROR : ErrorCode.NETWORK_ERROR,
            `HTTP ${res.status} ${url}`,
            { url, status: res.status, fatal }
          );
        }

        const totalHeader = Number(res.headers.get('content-length')) || null;
        let data;
        if (res.body && typeof res.body.getReader === 'function') {
          data = await readStream(res.body, (loaded) => onProgress && onProgress(loaded, totalHeader), {
            maxBytes: this.maxBytes,
            url,
          });
        } else {
          // 极老环境无 ReadableStream：退化为一次性 buffer()
          const buf = await res.arrayBuffer();
          assertByteLength(buf.byteLength, this.maxBytes, `HLS 资源 ${url}`);
          data = new Uint8Array(buf);
          if (onProgress) onProgress(data.byteLength, totalHeader);
        }
        return { data, byteLength: data.byteLength };
      } catch (err) {
        bounded?.done();
        // 外部主动取消：透传 ABORTED，不重试
        if (err instanceof LoadError && err.code === ErrorCode.ABORTED) throw err;
        if (err && err.name === 'AbortError' && signal?.aborted) {
          throw new LoadError(ErrorCode.ABORTED, '请求已被外部取消', { url, fatal: true });
        }
        // 超时识别：内部 controller 的 abort 转为 TIMEOUT（可重试）
        if (err && err.name === 'AbortError') {
          lastErr = new LoadError(ErrorCode.TIMEOUT, `请求超时(${this.timeoutMs}ms): ${url}`, { url, network: true });
        } else {
          lastErr = err;
        }
        if (lastErr instanceof LoadError && lastErr.fatal) break;
        if (attempt < this.maxRetry) {
          log.warn(`加载失败(${attempt + 1}/${this.maxRetry})，${this.retryDelayMs}ms 后重试:`, lastErr.message);
          await delay(this.retryDelayMs * Math.pow(2, attempt), signal);
        }
      } finally {
        bounded?.done();
      }
    }
    if (lastErr instanceof LoadError) throw lastErr;
    throw new LoadError(ErrorCode.NETWORK_ERROR, `网络错误: ${lastErr && lastErr.message}`, {
      url,
      network: true,
      fatal: false,
    });
  }

  /** 加载 m3u8 文本 */
  async loadText(url, signal) {
    const { data } = await this.load(url, { signal });
    return new TextDecoder().decode(data);
  }
}

/**
 * 流式读取并按上界熔断：累计超过 maxBytes 立即取消流并抛 SOURCE_ERROR，
 * 避免畸形清单/被劫持的响应把整个进程内存吃满。
 */
async function readStream(body, onChunk, { maxBytes = DEFAULT_MAX_READ_BYTES, url = '' } = {}) {
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > maxBytes) {
      chunks.length = 0;
      try {
        await reader.cancel();
      } catch {
        /* 忽略取消异常，原错误优先 */
      }
      throw new LoadError(
        ErrorCode.SOURCE_ERROR,
        `资源超过字节上界(${maxBytes}): ${url}`,
        { url, fatal: true },
      );
    }
    chunks.push(value);
    onChunk(loaded);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
