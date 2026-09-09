/**
 * ebml.js —— EBML 基础编解码：变长整数（VINT）、元素读写、值解码、Writer
 *
 * 纯 ESM，零依赖，浏览器与 Node 通用。
 * 关键规则速记：
 *   - VINT 首字节的「前导 1 个数」决定总字节数 n；数据位 = 后续 (8-n) 位 + 后续字节。
 *   - 元素 ID 的标记位是编码的一部分（如 0x1A45DFA3 首字节 0x1A=0001_1010，前导 1 有 2 个 → 4 字节）。
 *   - 元素 Size 掩掉标记位；所有数据位全为 1 表示「未知长度」（常见于流式 Segment/Cluster）。
 */

/** 各字节数下 Size 的数据位掩码（n=1..7） */
const SIZE_MASK = [0x7f, 0x3f, 0x1f, 0x0f, 0x07, 0x03, 0x01];

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class EbmlError extends Error {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'EbmlError';
  }
}

/**
 * 由首字节推断 VINT 总长（1~8）。
 * 规范规则：首字节中「第一个值为 1 的位」即标记位，其之前的位必须全 0；
 * 标记位在第 n 高位 → 总长 n 字节。例：0x80..0xFF=1 字节，0x40..0x7F=2 字节，
 * 0x18 开头=4 字节（Segment），全 1 首字节 0xFF=1 字节。
 */
export function vintLength(firstByte) {
  if (firstByte === undefined || Number.isNaN(firstByte)) {
    throw new EbmlError('VINT 首字节缺失');
  }
  if (firstByte === 0) throw new EbmlError('非法的 VINT 首字节: 0x00（无标记位）');
  for (let n = 1; n <= 8; n++) {
    if (firstByte & (1 << (8 - n))) return n;
  }
  throw new EbmlError(`非法的 VINT 首字节: 0x${firstByte.toString(16)}`);
}

/**
 * 读取元素 ID（保留标记位，返回规范数值）。
 * @returns {{id:number, length:number}|null} 流结束返回 null
 */
export function readId(bytes, pos, end = bytes.length) {
  if (pos >= end) return null;
  const first = bytes[pos];
  const len = vintLength(first);
  if (pos + len > end) throw new EbmlError(`ID 越界: 需要 ${len} 字节`);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + bytes[pos + i];
  return { id, length: len };
}

/**
 * 读取元素尺寸 VINT。
 * @returns {{value:number, length:number, unknown:boolean}}
 *   unknown=true 时 value 为 -1；8 字节超大值走 BigInt 兜底，超出安全整数即抛错。
 */
export function readSize(bytes, pos, end = bytes.length) {
  if (pos >= end) throw new EbmlError('Size 越界');
  const first = bytes[pos];
  const len = vintLength(first);
  if (pos + len > end) throw new EbmlError(`Size 越界: 需要 ${len} 字节`);

  if (len === 8) {
    // 8 字节：标记位独占首字节（0x01），数据位仅后 7 字节共 56 位，走 BigInt 防精度丢失
    let big = 0n;
    for (let i = 1; i < 8; i++) big = (big << 8n) | BigInt(bytes[pos + i]);
    if (big === ((1n << 56n) - 1n)) {
      return { value: -1, length: len, unknown: true }; // 数据位全 1
    }
    if (big > BigInt(MAX_SAFE)) {
      throw new EbmlError(`不支持的元素尺寸(>Number.MAX_SAFE_INTEGER): ${big}`);
    }
    return { value: Number(big), length: len, unknown: false };
  }

  // n<8：首字节数据位掩码 = 0xFF>>n（标记位之下的低位）
  const firstMask = len === 8 ? 0x01 : 0xff >> len;
  let value = first & firstMask;
  for (let i = 1; i < len; i++) value = value * 256 + bytes[pos + i];
  // 注意：不能用 (1<<(7n))-1——JS 位运算按 int32 截断，len=5 时得 7 会把合法
  // 元素误判为未知长度；必须走指数运算（值上限 2^49，Number 安全）。
  const maxOfLen = 2 ** (7 * len) - 1;
  const unknown = value === maxOfLen; // 数据位全 1 → 未知长度
  return { value: unknown ? -1 : value, length: len, unknown };
}

/** 编码尺寸 VINT（最小 n 满足 value ≤ 2^(7n)-2；全 1 数据位保留给「未知长度」） */
export function encodeSize(value, minLength = 0) {
  if (value < 0) throw new EbmlError('encodeSize 不接受负数');
  let len = Math.max(minLength, 1);
  while (value > 2 ** (7 * len) - 2) len++;
  if (len > 8) throw new EbmlError(`尺寸过大无法编码: ${value}`);
  const bytes = new Uint8Array(len);
  if (len === 8) {
    // 标记位独占首字节，数据写满后 7 字节（56 数据位）
    bytes[0] = 0x01;
    let v = value;
    for (let i = 7; i >= 1; i--) { bytes[i] = v & 0xff; v = Math.floor(v / 256); }
    if (v !== 0) throw new EbmlError(`尺寸超出 8 字节容量: ${value}`);
    return bytes;
  }
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  // 首字节仅保留低 (8-len) 个数据位，并把标记位置于第 len 高位
  bytes[0] &= 0xff >> len;
  bytes[0] |= (1 << (8 - len)) & 0xff;
  return bytes;
}

/** 编码「未知长度」VINT（该宽度数据位全 1），Segment/Cluster 流式场景使用 */
export function encodeUnknownSize(len = 1) {
  const bytes = new Uint8Array(len).fill(0xff);
  bytes[0] = (len === 8 ? 0x01 : 0xff >> len) | (1 << (8 - len) & 0xff);
  return bytes;
}

/** 编码元素 ID：合法 ID 自带标记位，按大端最小字节写回即可还原规范形式 */
export function encodeId(id) {
  let len = 1;
  while (id >= 2 ** (8 * len)) len++;
  const bytes = new Uint8Array(len);
  let v = id;
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = v & 0xff;
    v >>= 8;
  }
  return bytes;
}

/** 解码 Unsigned Integer（≤7 字节安全；8 字节经 BigInt 转换，超安全整数抛错） */
export function readUInt(bytes, pos = 0, end = bytes.length) {
  const width = end - pos;
  if (width <= 0) return 0;
  if (width > 8) throw new EbmlError(`UInt 宽度非法: ${width}`);
  if (width < 8) {
    let v = 0;
    for (let i = pos; i < end; i++) v = v * 256 + bytes[i];
    return v;
  }
  let big = 0n;
  for (let i = pos; i < end; i++) big = (big << 8n) | BigInt(bytes[i]);
  if (big > BigInt(MAX_SAFE)) throw new EbmlError(`UInt 超出安全整数: ${big}`);
  return Number(big);
}

/** 解码 Signed Integer（对 8*width 位做二补码） */
export function readInt(bytes, pos = 0, end = bytes.length) {
  const width = end - pos;
  if (width <= 0) return 0;
  if (width > 8) throw new EbmlError(`Int 宽度非法: ${width}`);
  let v = readUInt(bytes, pos, end);
  const bits = 8 * width;
  const signBit = 2 ** (bits - 1);
  if (v >= signBit) v -= 2 ** bits;
  return v;
}

/** 解码 Float（宽度 0/4/8） */
export function readFloat(bytes, pos = 0, end = bytes.length) {
  const width = end - pos;
  if (width === 0) return 0;
  if (width !== 4 && width !== 8) throw new EbmlError(`Float 宽度非法: ${width}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos, width);
  return width === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

/** Date：自 2001-01-01T00:00:00Z 起的纳秒（有符号 64 位），此处换算为 JS 毫秒时间戳 */
const EPOCH_2001_MS = Date.UTC(2001, 0, 1);
export function readDate(bytes, pos = 0, end = bytes.length) {
  const width = end - pos;
  if (width !== 8) throw new EbmlError(`Date 宽度必须为 8 字节，实际 ${width}`);
  let big = 0n;
  for (let i = pos; i < end; i++) big = (big << 8n) | BigInt(bytes[i]);
  const msBig = big / 1000000n;
  if (msBig > BigInt(MAX_SAFE) || msBig < -BigInt(MAX_SAFE)) {
    throw new EbmlError('Date 毫秒值超出安全整数');
  }
  return Number(msBig) + EPOCH_2001_MS;
}

/** UTF-8 / ASCII 字符串解码（共享一个 TextDecoder 降低开销） */
let sharedUtf8Decoder = null;
function utf8Decoder() {
  if (!sharedUtf8Decoder) sharedUtf8Decoder = new TextDecoder('utf-8');
  return sharedUtf8Decoder;
}
export function readString(bytes, pos = 0, end = bytes.length) {
  // Matroska 字符串惯例：尾部 NUL 属于填充，需去掉
  let e = end;
  while (e > pos && bytes[e - 1] === 0) e--;
  return utf8Decoder().decode(bytes.subarray(pos, e));
}

/**
 * 按 schema 类型解码元素数据。
 * @param {string} type schema TYPE 代号
 * @param {Uint8Array} bytes 元素完整数据区
 */
export function decodeValueByType(type, bytes) {
  switch (type) {
    case 'u': return readUInt(bytes);
    case 'i': return readInt(bytes);
    case 'f': return readFloat(bytes);
    case 's':
    case '8': return readString(bytes);
    case 'd': return readDate(bytes);
    default: return bytes.subarray(); // m/b 及未知类型：原样返回数据区视图
  }
}

/**
 * 浅层遍历 [start,end) 内的元素描述符（不递归 Master）。
 * @yields {{id:number,name:(string|undefined),type:string,size:number,contentStart:number,contentEnd:number,next:number,headerLength:number,unknown:boolean}}
 */
export function* iterElements(bytes, start = 0, end = bytes.length, schema = SCHEMA_DEFAULT) {
  let p = start;
  while (p < end) {
    const rid = readId(bytes, p, end);
    if (!rid) break;
    const sizeInfo = readSize(bytes, p + rid.length, end);
    const contentStart = p + rid.length + sizeInfo.length;
    let contentEnd = sizeInfo.unknown ? end : contentStart + sizeInfo.value;
    if (contentEnd > end) {
      // 数据被截断：按可用范围兜底（调用方可据 strict 处理）
      contentEnd = end;
    }
    const meta = schema.get(rid.id);
    yield {
      id: rid.id,
      name: meta?.name,
      type: meta?.type ?? 'b',
      size: sizeInfo.unknown ? -1 : sizeInfo.value,
      unknown: sizeInfo.unknown,
      headerLength: rid.length + sizeInfo.length,
      contentStart,
      contentEnd,
      next: contentEnd,
    };
    p = contentEnd;
  }
}

// 延迟引用避免循环依赖（schema.js 无反向依赖，直接 import 也安全）
import { SCHEMA as SCHEMA_DEFAULT } from './schema.js';

/** 在浅层查找第一个匹配 ID 的元素，找不到返回 null */
export function findElement(bytes, start, end, targetId, schema) {
  for (const el of iterElements(bytes, start, end, schema)) {
    if (el.id === targetId) return el;
  }
  return null;
}

/** 收集某 Master 元素的直接子元素数组（浅层） */
export function childrenOf(bytes, el, schema) {
  return [...iterElements(bytes, el.contentStart, el.contentEnd, schema)];
}

/**
 * 递归构建整棵元素树（仅用于测试与小头部区域；Cluster 请走流式 API）。
 */
export function parseTree(bytes, start = 0, end = bytes.length, schema = SCHEMA_DEFAULT, depth = 6) {
  const out = [];
  for (const el of iterElements(bytes, start, end, schema)) {
    if (el.type === 'm' && depth > 0) {
      el.children = parseTree(bytes, el.contentStart, el.contentEnd, schema, depth - 1);
    } else {
      el.value = decodeValueByType(el.type, bytes.subarray(el.contentStart, el.contentEnd));
    }
    out.push(el);
  }
  return out;
}

/**
 * EbmlWriter —— 程序化拼装 MKV 结构（fixture 生成、未来 mux 方向复用）。
 */
export class EbmlWriter {
  constructor() {
    /** @type {Uint8Array[]} */
    this.parts = [];
  }

  /** 追加原始字节 */
  raw(u8) {
    this.parts.push(u8);
    return this;
  }

  /** 追加一个叶子元素 */
  leaf(id, payload) {
    this.raw(encodeId(id));
    this.raw(encodeSize(payload.length));
    this.raw(payload);
    return this;
  }

  /** 追加 Master 元素，children 为已编码好的子内容字节 */
  masterBytes(id, childrenBytes) {
    this.raw(encodeId(id));
    this.raw(encodeSize(childrenBytes.length));
    this.raw(childrenBytes);
    return this;
  }

  /** 用子 Writer 构建 Master */
  master(id, buildFn) {
    const child = new EbmlWriter();
    buildFn(child);
    return this.masterBytes(id, child.done());
  }

  u(id, value, minLen = 0) { return this.leaf(id, encodeUIntPayload(value, minLen)); }
  i(id, value) { return this.leaf(id, encodeIntPayload(value)); }
  f(id, value, width = 8) { return this.leaf(id, encodeFloatPayload(value, width)); }
  s(id, str) { return this.leaf(id, asciiBytes(str)); }
  u8str(id, str) { return this.leaf(id, new TextEncoder().encode(str)); }
  b(id, u8) { return this.leaf(id, u8); }

  done() {
    let total = 0;
    for (const p of this.parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

/** 编码 UInt 元素载荷（大端，最小字节） */
export function encodeUIntPayload(value, minLen = 0) {
  let len = Math.max(minLen, 1);
  while (value >= 2 ** (8 * len)) len++;
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v >>= 8; }
  return out;
}

/** 编码 Int 元素载荷（二补码大端） */
export function encodeIntPayload(value) {
  if (value >= 0) {
    let len = 1;
    while (value >= 2 ** (8 * len - 1)) len++; // 保证符号位为 0
    return encodeUIntPayload(value, len);
  }
  // 负数：找最小宽度使 value >= -2^(8w-1)
  let w = 1;
  while (value < -(2 ** (8 * w - 1))) w++;
  let v = value + 2 ** (8 * w); // 二补码
  const out = new Uint8Array(w);
  for (let i = w - 1; i >= 0; i--) { out[i] = v & 0xff; v >>= 8; }
  return out;
}

/** 编码 Float 元素载荷 */
export function encodeFloatPayload(value, width = 8) {
  const buf = new ArrayBuffer(width);
  const view = new DataView(buf);
  if (width === 4) view.setFloat32(0, value, false);
  else view.setFloat64(0, value, false);
  return new Uint8Array(buf);
}

/** ASCII 字节（Matroska 字符串字段多为 ASCII） */
export function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
  return out;
}
