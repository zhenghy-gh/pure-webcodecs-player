/**
 * magnet.js —— magnet URI 解析与构造（离线纯函数，无网络行为）
 *
 * 职责（对齐派发口径）：
 *   - btih 提取：xt=urn:btih:<HASH>，HASH 兼容 40 位十六进制与 32 位 Base32；
 *   - base32 ↔ hex 双向转换（RFC 4648 字母表 A-Z2-7，无填充）；
 *   - dn（显示名）/ tr（tracker 列表，多值）/ xl（长度）字段收集。
 *
 * 设计说明：
 *   - 本模块只做「解析与规范化」，announce 通信属后续里程碑；
 *     网络路径仍把原始 magnet 交给 webtorrent 库，本层先行校验以给出
 *     明确的 PlayerError('PARSE_ERROR')，而不是让库报模糊错误。
 *   - 查询串解析用 URLSearchParams（浏览器/Node≥10 双端内建）。
 */

import { PlayerError } from '../../core/src/errors.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_LOOKUP = new Map([...BASE32_ALPHABET].map((c, i) => [c, i]));

/** Base32 解码（无填充；小写自动转大写；非法字符抛 PARSE_ERROR） */
export function base32Decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new PlayerError('PARSE_ERROR', `Base32 输入为空: ${JSON.stringify(str)}`);
  }
  const clean = str.toUpperCase();
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const val = B32_LOOKUP.get(ch);
    if (val === undefined) {
      throw new PlayerError('PARSE_ERROR', `Base32 非法字符: ${ch}`);
    }
    acc = (acc << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Base32 编码（RFC 4648 无填充；仅接受字节数组，字符串一律拒绝） */
export function base32Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new PlayerError('PARSE_ERROR', 'base32Encode 仅接受 Uint8Array');
  }
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function assertHex(hex) {
  return /^[0-9a-f]{40}$/i.test(hex);
}
function assertBase32(s) {
  return /^[a-z2-7]{32}$/i.test(s);
}

/** hex(40位) → base32(32位) */
export function hexToBase32(hex) {
  const h = String(hex).toLowerCase();
  if (!assertHex(h)) throw new PlayerError('PARSE_ERROR', `infohash 需为 40 位十六进制: ${hex}`);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return base32Encode(bytes);
}

/** base32(32位) → hex(40位小写) */
export function base32ToHex(b32) {
  if (!assertBase32(b32)) throw new PlayerError('PARSE_ERROR', `infohash 需为 32 位 Base32: ${b32}`);
  const bytes = base32Decode(b32);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * 解析 magnet URI。
 * @param {string} uri
 * @returns {{
 *   infoHash: string,        // 规范化 40 位小写 hex
 *   infoHashRaw: string,     // URI 中原样哈希段
 *   wasBase32: boolean,      // 原始是否 Base32 形态
 *   dn: string|null,         // 显示名
 *   xl: number|null,         // 总长度（字节）
 *   tr: string[],            // tracker 列表（去重保序）
 *   raw: string,
 * }}
 */
export function parseMagnet(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('magnet:?')) {
    throw new PlayerError('PARSE_ERROR', `非 magnet 链接: ${String(uri).slice(0, 40)}`);
  }
  const query = uri.slice('magnet:?'.length);
  let params;
  try {
    params = new URLSearchParams(query);
  } catch (err) {
    throw new PlayerError('PARSE_ERROR', `magnet 查询串非法: ${err?.message ?? err}`);
  }

  // 收集全部 xt，取第一个可识别的 urn:btih
  let infoHashRaw = null;
  let wasBase32 = false;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:(.+)$/i.exec(xt.trim());
    if (!m) continue;
    const hash = m[1];
    if (assertHex(hash)) {
      infoHashRaw = hash.toLowerCase();
      wasBase32 = false;
      break;
    }
    if (assertBase32(hash)) {
      infoHashRaw = hash.toUpperCase();
      wasBase32 = true;
      break;
    }
    // 形似 btih 但格式不对：记录并继续尝试下一个 xt
  }
  if (!infoHashRaw) {
    throw new PlayerError('PARSE_ERROR', 'magnet 缺少可识别的 xt=urn:btih:<40位hex|32位base32>');
  }

  const infoHash = wasBase32 ? base32ToHex(infoHashRaw) : infoHashRaw;

  const dnParam = params.get('dn');
  const xlParam = params.get('xl');
  const tr = [...new Set(params.getAll('tr').filter(Boolean))];

  return {
    infoHash,
    infoHashRaw,
    wasBase32,
    dn: dnParam || null,
    xl: xlParam !== null && /^\d+$/.test(xlParam) ? Number(xlParam) : null,
    tr,
    raw: uri,
  };
}

/**
 * 构造 magnet URI（infoHash 接受 hex 或 base32，内部规范化为 hex 输出）。
 * @param {{infoHash:string, dn?:string|null, tr?:string[], xl?:number|null}} spec
 */
export function buildMagnet({ infoHash, dn = null, tr = [], xl = null }) {
  let hex;
  if (assertHex(String(infoHash))) hex = String(infoHash).toLowerCase();
  else if (assertBase32(String(infoHash))) hex = base32ToHex(infoHash);
  else throw new PlayerError('PARSE_ERROR', `infoHash 格式非法: ${infoHash}`);

  const params = new URLSearchParams();
  params.set('xt', `urn:btih:${hex}`);
  if (dn) params.set('dn', dn);
  for (const t of tr) if (t) params.append('tr', t);
  if (Number.isInteger(xl) && xl >= 0) params.set('xl', String(xl));
  return `magnet:?${params.toString()}`;
}
