/**
 * url-guard.js —— 网络地址安全校验（评审第二轮 I5 安全项）
 *
 * 背景：本仓大量入口直接把调用方/清单里给出的地址交给 `fetch` / `WebSocket` / `import()`。
 * 在此之前全仓没有任何协议白名单——清单里写 `URI="file:///etc/passwd"`、
 * `URI="javascript:..."`、`data:` 甚至 `blob:` 都会被原样发出（或抛出非 PlayerError 的
 * TypeError，违反 G9 错误封闭）。本模块把「哪些协议允许出网」收敛为唯一权威。
 *
 * 设计取舍：
 *  - **可解析才判定**：`new URL()` 解析失败（相对地址、宿主自造 scheme 如 `memory:`）时
 *    宽松放行，交给调用方/运行时解析，避免误伤既有用法；
 *  - **可解析即严格**：一旦能确定协议，非白名单一律拒绝并抛封闭错误码；
 *  - 协议比较用 `URL.protocol`（含尾冒号、自动小写）。
 */

import { networkError, sourceError } from './errors.js';

/** 允许发起 fetch/XHR 的协议（契约 I5：file:/blob:/data:/javascript: 一律拒绝） */
export const FETCH_PROTOCOLS = Object.freeze(['http:', 'https:']);

/** 允许建立 WebSocket 的协议 */
export const WS_PROTOCOLS = Object.freeze(['ws:', 'wss:']);

/** 允许动态 import() 的协议（CDN 加载器用；data:/blob: 会被拒） */
export const IMPORT_PROTOCOLS = Object.freeze(['http:', 'https:']);

/**
 * 解析地址；失败返回 null（相对地址或非法串）。
 * @param {string} url
 * @param {string} [base] 基准地址
 * @returns {URL|null}
 */
export function parseUrl(url, base) {
  try {
    return new URL(String(url ?? ''), base || undefined);
  } catch {
    return null;
  }
}

/**
 * 取协议（含尾冒号，小写）；无法解析返回 null。
 * @param {string} url
 * @param {string} [base]
 * @returns {string|null}
 */
export function urlProtocol(url, base) {
  return parseUrl(url, base)?.protocol ?? null;
}

/**
 * 地址是否安全（协议在白名单内，或无法解析而宽松放行）。
 * @param {string} url
 * @param {{protocols?: readonly string[], base?: string}} [options]
 * @returns {boolean}
 */
export function isSafeUrl(url, options = {}) {
  const { protocols = FETCH_PROTOCOLS, base } = options;
  const protocol = urlProtocol(url, base);
  if (protocol === null) return true;
  return protocols.includes(protocol);
}

/**
 * 校验地址；不合法抛 PlayerError（NETWORK_ERROR 或 SOURCE_ERROR）。
 * 合法时原样返回输入串，便于 `this.url = assertSafeUrl(url, …)` 就地赋值。
 *
 * @param {string} url
 * @param {{
 *   protocols?: readonly string[],
 *   base?: string,
 *   what?: string,
 *   code?: 'network'|'source',
 * }} [options]
 * @returns {string}
 */
export function assertSafeUrl(url, options = {}) {
  const {
    protocols = FETCH_PROTOCOLS,
    base,
    what = '地址',
    code = 'network',
  } = options;
  const raw = String(url ?? '');
  const protocol = urlProtocol(raw, base);
  if (protocol !== null && !protocols.includes(protocol)) {
    const allow = protocols.map((p) => p.replace(/:$/, '')).join('/');
    const message =
      `${what}协议不允许: ${protocol}（仅允许 ${allow}；file: / blob: / data: / javascript: 一律拒绝）`;
    throw code === 'source' ? sourceError(message) : networkError(message);
  }
  return raw;
}

/** WebSocket 地址校验（ws/wss）。 */
export function assertSafeWsUrl(url, options = {}) {
  return assertSafeUrl(url, { what: 'WebSocket 地址', ...options, protocols: WS_PROTOCOLS });
}

/** 动态 import 地址校验（http/https）。 */
export function assertSafeImportUrl(url, options = {}) {
  return assertSafeUrl(url, { what: '动态 import 地址', ...options, protocols: IMPORT_PROTOCOLS });
}
