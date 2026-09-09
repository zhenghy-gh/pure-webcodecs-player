/**
 * 播放地址解析与网关映射约定（rtmp 模块对外契约的一部分）。
 *
 * ── 支持的 URL 形态 ─────────────────────────────────────────────
 * 1) ws-flv://host[:port]/app/stream?query   → ws://host:port/app/stream?query
 *    wss-flv://host/path                      → wss://host/path（端口缺省 443）
 * 2) ws://… / wss://…                        → 原样透传（已是 WebSocket 地址）
 * 3) rtmp://host[:1935]/app/stream           → 网关映射（默认约定，均可配置）：
 *        scheme  rtmp→ws / rtmps→wss
 *        port    缺省 1935 → <gatewayPort>（默认 8000）
 *        path    追加 ".flv" 后缀（appendSuffix 可关）
 *    典型结果：rtmp://host/live/stream → ws://host:8000/live/stream.flv
 *
 * 另一种部署形态是 §9 通道中继（POST /publish + WS /stream）：
 *    resolveSourceUrl('rtmp://host/live/stream', { gatewayBase: 'ws://127.0.0.1:8090/stream' })
 *    → 'ws://127.0.0.1:8090/stream/live/stream'（此时不追加 .flv）
 */

const RTMP_DEFAULT_PORT = 1935;
const GATEWAY_DEFAULT_PORT = 8000;

/**
 * ws-flv:// 与 wss-flv:// → 标准 WebSocket URL。
 * @param {string} url
 * @returns {{ url:string, secure:boolean, host:string, port:number, path:string, query:string }}
 */
export function parseWsFlvUrl(url) {
  const m = /^(wss?-flv):\/\/([^/?#]+)([^?#]*)(\?.*)?$/.exec(String(url ?? '').trim());
  if (!m) return null;
  const [, scheme, authority, path = '', query = ''] = m;
  const secure = scheme === 'wss-flv';
  const colon = authority.lastIndexOf(':');
  let host = authority;
  let portStr = '';
  if (colon > -1 && /^\d+$/.test(authority.slice(colon + 1))) {
    host = authority.slice(0, colon);
    portStr = authority.slice(colon + 1);
  }
  const port = Number(portStr) || (secure ? 443 : 80);
  const normPath = path.startsWith('/') ? path : `/${path}`;
  const wsUrl = `${secure ? 'wss' : 'ws'}://${host}${portStr ? `:${portStr}` : `:${port}`}${normPath || '/'}${query}`;
  return { url: wsUrl, secure, host, port, path: normPath, query };
}

/** 是否为可直接使用的 WebSocket URL */
export function isWebSocketUrl(url) {
  return /^wss?:\/\//.test(String(url ?? '').trim());
}

/**
 * rtmp:// → ws-flv 网关地址映射（默认约定，见模块头注释）。
 * @param {string} rtmpUrl
 * @param {{gatewayPort?:number, appendSuffix?:boolean}} [opts]
 */
export function mapRtmpToGateway(rtmpUrl, opts = {}) {
  const m = /^(rtmps?):\/\/([^/?#]+)([^?#]*)(\?.*)?$/.exec(String(rtmpUrl ?? '').trim());
  if (!m) return null;
  const [, scheme, authority, rawPath = '', query = ''] = m;
  const secure = scheme === 'rtmps';
  const colon = authority.lastIndexOf(':');
  let host = authority;
  let portStr = '';
  if (colon > -1 && /^\d+$/.test(authority.slice(colon + 1))) {
    host = authority.slice(0, colon);
    portStr = authority.slice(colon + 1);
  }
  const gwPort = opts.gatewayPort ?? GATEWAY_DEFAULT_PORT;
  let path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if ((opts.appendSuffix ?? true) && !path.endsWith('.flv')) path += '.flv';
  const url =
    `${secure ? 'wss' : 'ws'}://${host}:${gwPort}${path || '/'}${query}`;
  return { url, host, sourcePort: Number(portStr) || RTMP_DEFAULT_PORT, gatewayPort: gwPort, path };
}

/**
 * 统一入口：任意受支持形态 → 最终 WebSocket 地址。
 * @param {string} input
 * @param {{
 *   gatewayPort?:number,
 *   appendSuffix?:boolean,
 *   gatewayBase?:string,          // §9 通道中继基址，如 'ws://127.0.0.1:8090/stream'
 * }} [opts]
 */
export function resolveSourceUrl(input, opts = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new TypeError('空 URL');

  if (parseWsFlvUrl(raw)) return parseWsFlvUrl(raw).url;
  if (isWebSocketUrl(raw)) return raw;

  if (opts.gatewayBase) {
    const mapped = mapRtmpToGateway(raw, { appendSuffix: false });
    if (mapped) {
      const base = opts.gatewayBase.replace(/\/+$/, '');
      const name = mapped.path.replace(/^\/+/, '');
      return `${base}/${name}`;
    }
  }

  const viaGateway = mapRtmpToGateway(raw, opts);
  if (viaGateway) return viaGateway.url;

  throw new TypeError(
    `不支持的地址形态: ${raw}（支持 ws-flv://、wss-flv://、ws(s)://、rtmp(s)://）`,
  );
}
