/**
 * ByteStream：大端（网络序）字节流读写器。
 *
 * ISO-BMFF(MP4/MOV)、MPEG-TS、FLV 等容器全部采用大端整数，
 * 这里统一提供零拷贝视图读取与精确边界检查。
 */
import { sourceError } from './errors.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/** 大端读取器（只读视图，不复制底层数据） */
export class ByteStream {
  /**
   * @param {ArrayBuffer|Uint8Array|ArrayBufferView} buffer
   * @param {number} [byteOffset]
   * @param {number} [byteLength]
   */
  constructor(buffer, byteOffset = 0, byteLength = undefined) {
    let view;
    if (buffer instanceof Uint8Array) {
      const start = byteOffset ?? 0;
      const len = byteLength === undefined ? buffer.byteLength - start : byteLength;
      if (start < 0 || len < 0 || start + len > buffer.byteLength) {
        throw sourceError(`ByteStream window out of range: offset=${start} length=${len}`);
      }
      view = new Uint8Array(buffer.buffer, buffer.byteOffset + start, len);
    } else if (ArrayBuffer.isView(buffer)) {
      // 尊重调用方传入的 byteOffset/byteLength 子窗口（此前会丢弃这两个参数）。
      const start = byteOffset ?? 0;
      const len = byteLength === undefined ? buffer.byteLength - start : byteLength;
      if (start < 0 || len < 0 || start + len > buffer.byteLength) {
        throw sourceError(`ByteStream window out of range: offset=${start} length=${len}`);
      }
      const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset + start, len);
      return new ByteStream(u8, 0);
    } else if (buffer instanceof ArrayBuffer) {
      const start = byteOffset ?? 0;
      const len = byteLength === undefined ? buffer.byteLength - start : byteLength;
      view = new Uint8Array(buffer, start, len);
    } else {
      throw sourceError('ByteStream expects ArrayBuffer or typed array');
    }
    this._view = view;
    this._dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
    this._pos = 0;
  }

  /** 底层字节的 Uint8Array 视图 */
  get bytes() {
    return this._view;
  }

  get length() {
    return this._view.byteLength;
  }

  get position() {
    return this._pos;
  }

  set position(value) {
    this.seek(value);
  }

  get remaining() {
    return this.length - this._pos;
  }

  get eof() {
    return this._pos >= this.length;
  }

  seek(pos) {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.length) {
      throw sourceError(`seek out of range: ${pos} (length=${this.length})`);
    }
    this._pos = pos;
    return this;
  }

  skip(n) {
    return this.seek(this._pos + n);
  }

  rewind(n) {
    return this.seek(this._pos - n);
  }

  _need(n) {
    if (this.remaining < n) {
      throw sourceError(`read overflow: need ${n} bytes at ${this._pos}, remaining=${this.remaining}`);
    }
  }

  /** 读取 n 字节并返回底层视图切片（零拷贝，勿长期持有） */
  readSlice(n) {
    this._need(n);
    const slice = this._view.subarray(this._pos, this._pos + n);
    this._pos += n;
    return slice;
  }

  /** 读取 n 字节并返回拷贝 */
  readBytes(n) {
    const slice = this.readSlice(n);
    return slice.slice();
  }

  /** 读取 n 字节但不移动游标（零拷贝预览） */
  peekSlice(n) {
    this._need(n);
    return this._view.subarray(this._pos, this._pos + n);
  }

  readU8() {
    this._need(1);
    return this._dataView.getUint8(this._pos++);
  }

  readI8() {
    this._need(1);
    return this._dataView.getInt8(this._pos++);
  }

  readU16() {
    this._need(2);
    const v = this._dataView.getUint16(this._pos, false);
    this._pos += 2;
    return v;
  }

  readI16() {
    this._need(2);
    const v = this._dataView.getInt16(this._pos, false);
    this._pos += 2;
    return v;
  }

  readU24() {
    this._need(3);
    const v =
      (this._view[this._pos] << 16) |
      (this._view[this._pos + 1] << 8) |
      this._view[this._pos + 2];
    this._pos += 3;
    return v >>> 0;
  }

  readU32() {
    this._need(4);
    const v = this._dataView.getUint32(this._pos, false);
    this._pos += 4;
    return v;
  }

  readI32() {
    this._need(4);
    const v = this._dataView.getInt32(this._pos, false);
    this._pos += 4;
    return v;
  }

  /** 64 位无符号整数（返回 BigInt）；ISO-BMFF version=1 的 duration 等字段使用 */
  readU64() {
    this._need(8);
    const v = this._dataView.getBigUint64(this._pos, false);
    this._pos += 8;
    return v;
  }

  readI64() {
    this._need(8);
    const v = this._dataView.getBigInt64(this._pos, false);
    this._pos += 8;
    return v;
  }

  /**
   * 64 位长度字段的安全读取：绝大多数场景值在 Number 安全范围内，
   * 直接转 number 方便算术；超过安全范围抛错而不是静默截断。
   */
  readU64Number(maxSafe = Number.MAX_SAFE_INTEGER) {
    const v = this.readU64();
    if (v > BigInt(maxSafe)) {
      throw sourceError(`64-bit value exceeds safe range: ${v}`);
    }
    return Number(v);
  }

  readF32() {
    this._need(4);
    const v = this._dataView.getFloat32(this._pos, false);
    this._pos += 4;
    return v;
  }

  readF64() {
    this._need(8);
    const v = this._dataView.getFloat64(this._pos, false);
    this._pos += 8;
    return v;
  }

  /** 16.16 定点数（QuickTime tkhd 宽高、矩阵等常用） */
  readFixed16_16() {
    return this.readU32() / 65536;
  }

  /** 8.8 定点数（QuickTime SoundDescription v1 之前的采样率字段） */
  readFixed8_8() {
    return this.readU16() / 256;
  }

  /** 2.30 定点数（矩阵元素） */
  readFixed2_30() {
    return this.readI32() / 1073741824;
  }

  /** 读 4 字节 fourcc 并去除尾随空格 */
  readFourCC() {
    return latin1(this.readSlice(4));
  }

  /** 读 n 字节 UTF-8 文本 */
  readUtf8(n) {
    return textDecoder.decode(this.readSlice(n));
  }

  /** 读以 \\0 结尾的字符串（最多 maxLen 字节，含终止符） */
  readCString(maxLen = this.remaining) {
    const end = this._view.indexOf(0, this._pos);
    const limit = Math.min(this._pos + maxLen, this.length);
    const stop = end >= 0 && end < limit ? end : limit;
    const str = textDecoder.decode(this._view.subarray(this._pos, stop));
    this.seek(stop < this.length && this._view[stop] === 0 ? stop + 1 : stop);
    return str;
  }

  /** 预览 4 字节 fourcc（不移动游标），不足 4 字节返回 null */
  peekFourCC() {
    if (this.remaining < 4) return null;
    return latin1(this.peekSlice(4));
  }
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** 动态扩容的大端写入器（mp4 box 构造、remux 输出共用） */
export class ByteWriter {
  constructor(initialCapacity = 1024) {
    this._buf = new Uint8Array(initialCapacity);
    this._len = 0;
  }

  get length() {
    return this._len;
  }

  _reserve(extra) {
    const need = this._len + extra;
    if (need <= this._buf.byteLength) return;
    let cap = this._buf.byteLength * 2 || initialCap;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
  }

  writeU8(v) {
    this._reserve(1);
    this._buf[this._len++] = v & 0xff;
    return this;
  }

  writeU16(v) {
    this._reserve(2);
    this._buf[this._len++] = (v >>> 8) & 0xff;
    this._buf[this._len++] = v & 0xff;
    return this;
  }

  writeU24(v) {
    this._reserve(3);
    this._buf[this._len++] = (v >>> 16) & 0xff;
    this._buf[this._len++] = (v >>> 8) & 0xff;
    this._buf[this._len++] = v & 0xff;
    return this;
  }

  writeU32(v) {
    this._reserve(4);
    this._buf[this._len++] = (v >>> 24) & 0xff;
    this._buf[this._len++] = (v >>> 16) & 0xff;
    this._buf[this._len++] = (v >>> 8) & 0xff;
    this._buf[this._len++] = v & 0xff;
    return this;
  }

  writeI32(v) {
    return this.writeU32(v >>> 0);
  }

  /** 有符号 64 位（补码） */
  writeI64(v) {
    let big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    if (big < 0n) big += 1n << 64n;
    return this.writeU64(big);
  }

  writeU64(v) {
    const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    this.writeU32(Number((big >> 32n) & 0xffffffffn));
    this.writeU32(Number(big & 0xffffffffn));
    return this;
  }

  writeF32(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, false);
    for (let i = 0; i < 4; i++) this.writeU8(dv.getUint8(i));
    return this;
  }

  writeF64(v) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, false);
    for (let i = 0; i < 8; i++) this.writeU8(dv.getUint8(i));
    return this;
  }

  writeFixed16_16(v) {
    return this.writeU32(Math.round(v * 65536));
  }

  /**
   * 写入 9 元素显示矩阵：前 6 个与平移量为 16.16 定点，最末 w 为 2.30 定点。
   * unity 矩阵 = [1,0,0 | 0,1,0 | 0,0,1] → 字节序列 …|00 01 00 00|…|40 00 00 00|
   */
  writeMatrix(a = 1, b = 0, u = 0, c = 0, d = 1, v = 0, tx = 0, ty = 0, w = 0x40000000) {
    this.writeU32(Math.round(a * 65536));
    this.writeU32(Math.round(b * 65536));
    this.writeU32(u);
    this.writeU32(Math.round(c * 65536));
    this.writeU32(Math.round(d * 65536));
    this.writeU32(v);
    this.writeU32(Math.round(tx * 65536));
    this.writeU32(Math.round(ty * 65536));
    this.writeU32(w >>> 0); // 2.30 定点直接写原值
    return this;
  }

  writeFourCC(str) {
    const s = String(str).padEnd(4, ' ');
    this._reserve(4);
    for (let i = 0; i < 4; i++) this._buf[this._len++] = s.charCodeAt(i) & 0xff;
    return this;
  }

  writeUtf8(str) {
    const bytes = textEncoder.encode(String(str));
    this.writeRaw(bytes);
    return this;
  }

  /** 原样写入一段字节 */
  writeRaw(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._reserve(u8.byteLength);
    this._buf.set(u8, this._len);
    this._len += u8.byteLength;
    return this;
  }

  /** 回写已写入内容中的某个位置（用于 patch size 字段） */
  patchU32(offset, value) {
    if (offset < 0 || offset + 4 > this._len) {
      throw sourceError(`patchU32 out of range: ${offset}`);
    }
    this._buf[offset] = (value >>> 24) & 0xff;
    this._buf[offset + 1] = (value >>> 16) & 0xff;
    this._buf[offset + 2] = (value >>> 8) & 0xff;
    this._buf[offset + 3] = value & 0xff;
    return this;
  }

  /** 导出拷贝 */
  toUint8Array() {
    return this._buf.slice(0, this._len);
  }
}

const initialCap = 1024;
