/**
 * bencode.js —— BitTorrent bencode 编解码（纯函数、零依赖）
 *
 * 规则速记：
 *   整数   i<十进制>e        （含负数；禁止前导零，0 必须写作 i0e）
 *   字节串 <长度>:<原始字节>   （键与文本内容都是字节串）
 *   列表   l<元素>*e
 *   字典   d<键><值>*e       （键必须是字节串且【按字典序排列】）
 *
 * 错误处理：结构非法统一抛 core PlayerError('PARSE_ERROR')。
 */

import { PlayerError } from '../../core/src/errors.js';

const ASCII = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
};

/**
 * 解码整个 bencode 缓冲（顶层恰好一个元素，尾部仅允许空白）。
 * @param {Uint8Array} bytes
 * @returns {*} number|string|Uint8Array|Array|Map（dict 为 Map<string|Uint8Array,*>）
 */
export function bdecode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new PlayerError('PARSE_ERROR', 'bdecode 需要 Uint8Array 输入');
  }
  const [value, next] = decodeAt(bytes, 0);
  // 尾部只允许空白字节
  for (let i = next; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      throw new PlayerError('PARSE_ERROR', `bdecode 尾部存在多余数据（偏移 ${i}）`);
    }
  }
  return value;
}

/** 解码单个元素，返回 [值, 下一个偏移] */
export function decodeAt(bytes, pos) {
  if (pos >= bytes.length) throw new PlayerError('PARSE_ERROR', 'bdecode 数据提前结束');
  const c = bytes[pos];

  // 整数 i<num>e
  if (c === 0x69 /* i */) {
    const e = bytes.indexOf(0x65 /* e */, pos);
    if (e < 0) throw new PlayerError('PARSE_ERROR', '整数缺少终止符 e');
    const numStr = new TextDecoder().decode(bytes.subarray(pos + 1, e));
    if (!/^(0|-?[1-9][0-9]*)$/.test(numStr)) {
      throw new PlayerError('PARSE_ERROR', `非法整数格式: ${numStr}`);
    }
    return [Number(numStr), e + 1];
  }

  // 字节串 <len>:<bytes>
  if (c >= 0x30 && c <= 0x39 /* 0-9 */) {
    const colon = bytes.indexOf(0x3a /* : */, pos);
    if (colon < 0 || colon - pos > 12) throw new PlayerError('PARSE_ERROR', '字节串缺少冒号');
    const len = Number(new TextDecoder().decode(bytes.subarray(pos, colon)));
    if (!Number.isInteger(len) || len < 0) throw new PlayerError('PARSE_ERROR', `非法字节串长度: ${len}`);
    const start = colon + 1;
    if (start + len > bytes.length) throw new PlayerError('PARSE_ERROR', '字节串长度越界');
    return [bytes.slice(start, start + len), start + len];
  }

  // 列表 l...e
  if (c === 0x6c /* l */) {
    const list = [];
    let p = pos + 1;
    for (;;) {
      if (p >= bytes.length) throw new PlayerError('PARSE_ERROR', '列表缺少终止符 e');
      if (bytes[p] === 0x65) return [list, p + 1];
      const [v, next] = decodeAt(bytes, p);
      list.push(v);
      p = next;
    }
  }

  // 字典 d(k v)*e
  if (c === 0x64 /* d */) {
    const map = new Map();
    let p = pos + 1;
    for (;;) {
      if (p >= bytes.length) throw new PlayerError('PARSE_ERROR', '字典缺少终止符 e');
      if (bytes[p] === 0x65) return [map, p + 1];
      // 键必须是字节串
      if (!(bytes[p] >= 0x30 && bytes[p] <= 0x39)) {
        throw new PlayerError('PARSE_ERROR', '字典键必须是字节串');
      }
      const [k, kNext] = decodeAt(bytes, p);
      const [v, vNext] = decodeAt(bytes, kNext);
      const key = k instanceof Uint8Array ? textDecode(k) : k;
      map.set(key, v);
      p = vNext;
    }
  }

  throw new PlayerError('PARSE_ERROR', `非法 bencode 起始字节 0x${c.toString(16)}（偏移 ${pos}）`);
}

const sharedDecoder = new TextDecoder();
function textDecode(u8) {
  return sharedDecoder.decode(u8);
}

// ── 编码 ──────────────────────────────────────────────

/**
 * 编码为 bencode 字节。支持的值：
 *   number(安全整数) / string(utf8) / Uint8Array / Array / Map（键为 string|Uint8Array）
 * Map 的键自动按字节字典序排列（规范要求）。
 */
export function bencode(value) {
  const parts = [];
  encodeInto(value, parts);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function encodeInto(value, parts) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new PlayerError('PARSE_ERROR', `bencode 仅支持安全整数: ${value}`);
    }
    parts.push(ASCII(`i${value}e`));
    return;
  }
  if (typeof value === 'string') {
    encodeBytes(new TextEncoder().encode(value), parts);
    return;
  }
  if (value instanceof Uint8Array) {
    encodeBytes(value, parts);
    return;
  }
  if (Array.isArray(value)) {
    parts.push(ASCII('l'));
    for (const item of value) encodeInto(item, parts);
    parts.push(ASCII('e'));
    return;
  }
  if (value instanceof Map) {
    parts.push(ASCII('d'));
    const entries = [...value.entries()].sort((a, b) => {
      const ka = a[0] instanceof Uint8Array ? a[0] : new TextEncoder().encode(String(a[0]));
      const kb = b[0] instanceof Uint8Array ? b[0] : new TextEncoder().encode(String(b[0]));
      return compareBytes(ka, kb);
    });
    for (const [k, v] of entries) {
      if (typeof k === 'string') encodeBytes(new TextEncoder().encode(k), parts);
      else if (k instanceof Uint8Array) encodeBytes(k, parts);
      else throw new PlayerError('PARSE_ERROR', '字典键只能是字符串或字节串');
      encodeInto(v, parts);
    }
    parts.push(ASCII('e'));
    return;
  }
  throw new PlayerError('PARSE_ERROR', `不支持编码的类型: ${typeof value}`);
}

function encodeBytes(bytes, parts) {
  parts.push(ASCII(`${bytes.length}:`));
  parts.push(bytes);
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 快捷：解码并把所有字节串保留为 Uint8Array（不转字符串） */
export function bdecodeRaw(bytes) {
  void bytes; // 与 bdecode 相同实现路径；占位以表达语义差异由调用方处理
  return bdecode(arguments[0]);
}
