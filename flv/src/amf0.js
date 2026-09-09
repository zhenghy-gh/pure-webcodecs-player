/**
 * amf0.js —— AMF0 编解码（FLV Script Tag / onMetaData）
 *
 * 解码支持全部常用标记：
 *   number(0x00) boolean(0x01) string(0x02) object(0x03) null(0x05)
 *   undefined(0x06) reference(0x07) ecma-array(0x08) strict-array(0x0A)
 *   date(0x0B) long-string(0x0C)
 * 编码提供最小子集（number/boolean/string/object/ecma-array/null），
 * 供测试夹具与未来推流场景复用。
 */

/** 解析结果：{ value, offset } —— offset 为消费结束位置 */
class Decoder {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8() {
    this._need(1);
    return this.bytes[this.pos++];
  }

  u16() {
    this._need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    this._need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  dbl() {
    this._need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  utf8(len) {
    this._need(len);
    const out = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }

  _need(n) {
    if (this.pos + n > this.bytes.length) {
      throw new Error('AMF0: 数据越界');
    }
  }
}

/**
 * 解码一段 AMF0 数据中的第一个值。
 * @param {Uint8Array} bytes
 * @returns {{ value:any, offset:number }|null} 数据不足/非法返回 null
 */
export function decodeAmf0(bytes) {
  const d = new Decoder(bytes);
  try {
    const value = readValue(d, new Map(), 0);
    return { value, offset: d.pos };
  } catch {
    return null;
  }
}

/**
 * 依次解码多个值（Script Tag 常见为「方法名 + 参数对象」两个值）。
 * @returns {Array<any>} 至少解析出的值；全部失败返回 []
 */
export function decodeAmf0All(bytes) {
  const values = [];
  const d = new Decoder(bytes);
  const refs = new Map();
  let depthGuard = 0;
  while (d.pos < bytes.length && depthGuard++ < 64) {
    const start = d.pos;
    try {
      values.push(readValue(d, refs, 0));
    } catch {
      break;
    }
    if (d.pos <= start) break; // 防御：无进展则退出
  }
  return values;
}

function readValue(d, refs, depth) {
  if (depth > 32) throw new Error('AMF0: 嵌套过深');
  const marker = d.u8();
  switch (marker) {
    case 0x00: return d.dbl();
    case 0x01: return d.u8() !== 0;
    case 0x02: return d.utf8(d.u16());
    case 0x03: return readObject(d, refs, depth);
    case 0x05: return null;
    case 0x06: return undefined;
    case 0x07: return refs.get(d.u16());       // reference
    case 0x08: {                                // ECMA array
      d.u32();                                  // 数量声明不可靠，按对象读
      return readObjectBody(d, refs, depth, true);
    }
    case 0x0a: {                                // strict array
      const count = d.u32();
      const arr = [];
      for (let i = 0; i < count && i < 65536; i++) arr.push(readValue(d, refs, depth + 1));
      return arr;
    }
    case 0x0b: {                                // date
      const ms = d.dbl();
      d.pos += 2;                               // timezone（忽略）
      return new Date(ms);
    }
    case 0x0c: return d.utf8(d.u32());          // long string
    default:
      throw new Error(`AMF0: 未知标记 0x${marker.toString(16)} @${d.pos - 1}`);
  }
}

function readObject(d, refs, depth) {
  return readObjectBody(d, refs, depth, false);
}

function readObjectBody(d, refs, depth, isEcma) {
  const obj = {};
  const objIndex = refs.size;
  refs.set(objIndex, obj);
  while (true) {
    if (d.pos + 2 > d.bytes.length) throw new Error('AMF0: 对象截断');
    if (d.bytes[d.pos] === 0 && d.bytes[d.pos + 1] === 0 && d.bytes[d.pos + 2] === 0x09) {
      d.pos += 3;                               // objectEnd 标记
      return isEcma ? ecmaToArray(obj) : obj;
    }
    const key = d.utf8(d.u16());
    if (key.length === 0) throw new Error('AMF0: 空键名');
    obj[key] = readValue(d, refs, depth + 1);
  }
}

/** ECMA 数组：键恰为连续数字下标时还原为真数组，否则保留对象形态 */
function ecmaToArray(obj) {
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every((k, i) => k === String(i))) {
    const arr = [];
    for (const k of keys) arr.push(obj[k]);
    return arr;
  }
  return obj;
}

// ---------- 最小编码器（测试与工具用途） ----------

const textEncoder = new TextEncoder();

function Enc() {
  this.chunks = [];
  this.len = 0;
}
Enc.prototype.push = function (bytes) {
  this.chunks.push(bytes);
  this.len += bytes.length;
};
Enc.prototype.u16 = function (v) {
  const b = new Uint8Array(2);
  b[0] = (v >> 8) & 0xff;
  b[1] = v & 0xff;
  this.push(b);
};
Enc.prototype.u32 = function (v) {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  this.push(b);
};
Enc.prototype.finish = function () {
  const out = new Uint8Array(this.len);
  let off = 0;
  for (const c of this.chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

/**
 * 编码单个值为 AMF0。
 * 支持：number / boolean / string / null / Array(ECMA) / 普通对象。
 * @param {any} value
 * @returns {Uint8Array}
 */
export function encodeAmf0(value) {
  const e = new Enc();
  writeValue(e, value);
  return e.finish();
}

/** 编码「名称+参数」二元组（onMetaData 脚本体） */
export function encodeScriptPair(name, arg) {
  const e = new Enc();
  writeValue(e, name);
  writeValue(e, arg);
  return e.finish();
}

function writeValue(e, value) {
  if (typeof value === 'number') {
    const b = new Uint8Array(9);
    b[0] = 0x00;
    new DataView(b.buffer).setFloat64(1, value);
    e.push(b);
  } else if (typeof value === 'boolean') {
    e.push(Uint8Array.from([0x01, value ? 1 : 0]));
  } else if (typeof value === 'string') {
    const str = textEncoder.encode(value);
    e.push(Uint8Array.from([0x02]));
    e.u16(str.length);
    e.push(str);
  } else if (value === null || value === undefined) {
    e.push(Uint8Array.from([value === null ? 0x05 : 0x06]));
  } else if (Array.isArray(value)) {
    e.push(Uint8Array.from([0x08]));
    e.u32(value.length);
    for (let i = 0; i < value.length; i++) {
      writeKeyed(e, String(i), value[i]);
    }
    e.push(Uint8Array.from([0x00, 0x00, 0x09]));
  } else if (typeof value === 'object') {
    e.push(Uint8Array.from([0x03]));
    for (const [k, v] of Object.entries(value)) {
      writeKeyed(e, k, v);
    }
    e.push(Uint8Array.from([0x00, 0x00, 0x09]));
  } else {
    throw new TypeError(`encodeAmf0: 不支持的类型 ${typeof value}`);
  }
}

function writeKeyed(e, key, value) {
  const kb = textEncoder.encode(key);
  e.u16(kb.length);
  e.push(kb);
  writeValue(e, value);
}
