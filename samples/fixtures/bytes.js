/**
 * samples/fixtures/bytes.js —— 字节级构造/解析工具（零依赖、确定性输出）。
 * 供各 fixture 生成器与 __tests__ 复用；只依赖稳定 API。
 */

/** 由可迭代数字构造 Uint8Array */
export function u8(...bytes) {
  return Uint8Array.from(bytes);
}

/**
 * 拼接多个 Uint8Array。
 * 两种调用风格均支持（内部自动识别）：
 *   concat(arr1, arr2, ...)   —— 展开传参
 *   concat([arr1, arr2, ...]) —— 数组传参
 */
export function concat(...args) {
  const first = args[0];
  const parts =
    args.length === 1 && Array.isArray(first) ? first : args;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Latin-1 / ASCII 字符串 → 字节（用于 box type、四字符码等，字符码必须 <256） */
export function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 编码（字幕、DocType 等文本） */
export function utf8(str) {
  return new TextEncoder().encode(str);
}

/* ---------------- 大端定宽整数 ---------------- */

export function u16be(n) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n);
  return out;
}

/* ---------------- 小端定宽整数（RIFF/WAVE 等 LE 格式用） ---------------- */

export function u16le(n) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

export function u24be(n) {
  const out = new Uint8Array(3);
  out[0] = (n >>> 16) & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = n & 0xff;
  return out;
}

export function u32be(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

/** 32 位小端（RIFF 块尺寸等） */
export function u32le(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

/** 64 位大端（接受 number 或 bigint；number 走 f64 精度足够测试用） */
export function u64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

/** IEEE-754 双精度大端（FLV AMF Number / MKV Duration） */
export function f64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, n);
  return out;
}

/** 有符号 16 位大端（SimpleBlock 相对时间码等） */
export function i16be(n) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, n);
  return out;
}

/**
 * MSB-first 位写入器（FLAC STREAMINFO 等 20/36bit 打包场景）。
 * 用法：const w = new BitWriter(); w.put(value, bits); w.finish() → Uint8Array
 */
export class BitWriter {
  constructor() {
    this.bytes = []; // 已完成的整字节
    this.cur = 0; // 当前字节
    this.fill = 0; // 当前字节已占位数
  }

  put(value, bits) {
    const v = BigInt(value); // number 或 bigint 均可
    for (let i = bits - 1; i >= 0; i--) {
      const bit = Number((v >> BigInt(i)) & 1n);
      this.cur = (this.cur << 1) | bit;
      this.fill++;
      if (this.fill === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.fill = 0;
      }
    }
    return this;
  }

  /** 结束并补齐末尾 0 位 */
  finish() {
    if (this.fill > 0) {
      this.bytes.push(this.cur << (8 - this.fill));
      this.cur = 0;
      this.fill = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

/** MSB-first 位读取器（测试里做 STREAMINFO 回读校验用） */
export class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0; // 位位置
  }

  read(bits) {
    let v = 0n;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      v = (v << 1n) | BigInt(bit);
      this.pos++;
    }
    return v;
  }
}

/**
 * CRC-32/MPEG-2（TS 的 PSI section 校验字段）。
 * 多项式 0x04C11DB7、初值 0xFFFFFFFF、不反射、无异或输出。
 * 标准校验向量：crc32Mpeg2(utf8('123456789')) === 0x0376E6E7
 */
export function crc32Mpeg2(data) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80000000) crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
      else crc = (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/** 从 hex 字符串生成字节（'1A45DFA3' 或带空格均可），EBML ID 常量书写方便 */
export function fromHex(hex) {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
