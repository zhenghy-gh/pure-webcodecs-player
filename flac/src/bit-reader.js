/**
 * flac/src/bit-reader.js — MSB 优先位读取器
 * ------------------------------------------------------------
 * FLAC 位流为 big-endian bit order（MSB first）。
 * 只读不写；越界抛 PARSE_ERROR，由上层决定重同步或终止。
 */
import { parseError } from './errors.js';

export class BitReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [byteOffset] 起始字节
   * @param {number} [bitLimit]   可读位上限（相对起始），缺省到末尾
   */
  constructor(bytes, byteOffset = 0, bitLimit = undefined) {
    this.bytes = bytes;
    this.byteOffset = byteOffset;
    this.bitPos = 0; // 相对 byteOffset 的位游标
    this.bitLimit = bitLimit !== undefined ? bitLimit : (bytes.length - byteOffset) * 8;
  }

  /** 已读位总数 */
  get position() { return this.bitPos; }
  /** 剩余可读位数 */
  get bitsLeft() { return this.bitLimit - this.bitPos; }
  /** 是否字节对齐 */
  get aligned() { return this.bitPos % 8 === 0; }
  /** 当前绝对位偏移（相对整个 buffer 起点） */
  get absolutePosition() { return this.byteOffset * 8 + this.bitPos; }

  /** 读 n 位无符号整数（n ≤ 32，MSB first） */
  readBits(n) {
    if (n === 0) return 0;
    if (n < 0 || n > 32) throw parseError(`readBits 位宽非法：${n}`);
    if (this.bitsLeft < n) throw parseError('位流提前结束');
    let value = 0;
    let remaining = n;
    while (remaining > 0) {
      const byteIdx = this.byteOffset + (this.bitPos >> 3);
      const bitIdx = this.bitPos & 7;
      const take = Math.min(8 - bitIdx, remaining);
      const byte = this.bytes[byteIdx];
      // 取该字节中从 bitIdx 起的 take 位
      const mask = (0xff >> bitIdx) & ~(0xff >> (bitIdx + take)) & 0xff;
      value = (value << take) | ((byte & mask) >> (8 - bitIdx - take));
      this.bitPos += take;
      remaining -= take;
    }
    return value >>> 0;
  }

  /** 读一比特 */
  readBit() { return this.readBits(1); }

  /** 读一元编码值：数零直到遇到 1（FLAC Rice 商）。返回零的个数。 */
  readUnary() {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros++;
      if (zeros > 1 << 24) throw parseError('一元码过长，疑似数据损坏');
    }
    return zeros;
  }

  /** 对齐到下一字节边界；已对齐则原地不动 */
  alignToByte() {
    const rem = this.bitPos % 8;
    if (rem !== 0) this.bitPos += 8 - rem;
  }

  /** 跳过 n 位 */
  skip(n) {
    if (n < 0 || n > this.bitsLeft) throw parseError('skip 越界');
    this.bitPos += n;
  }

  /** 读 n 字节（须字节对齐）并返回新数组拷贝 */
  readBytes(n) {
    if (!this.aligned) throw parseError('readBytes 需要字节对齐');
    if (this.bitsLeft < n * 8) throw parseError('readBytes 越界');
    const start = this.byteOffset + (this.bitPos >> 3);
    this.bitPos += n * 8;
    return this.bytes.slice(start, start + n);
  }

  /** 读 UTF-8 式编码数（帧头 frame/sample number 编码，spec §9.1.6） */
  readUtfCodedNumber() {
    const first = this.readBits(8);
    if (first < 0x80) return first;
    let extra;
    let value;
    if ((first & 0xe0) === 0xc0) { extra = 1; value = first & 0x1f; }
    else if ((first & 0xf0) === 0xe0) { extra = 2; value = first & 0x0f; }
    else if ((first & 0xf8) === 0xf0) { extra = 3; value = first & 0x07; }
    else if ((first & 0xfc) === 0xf8) { extra = 4; value = first & 0x03; }
    else if ((first & 0xfe) === 0xfc) { extra = 5; value = first & 0x01; }
    else if (first === 0xfe) { extra = 6; value = 0; }
    else throw parseError(`UTF-8 编码数首字节非法：0x${first.toString(16)}`);
    for (let i = 0; i < extra; i++) {
      const b = this.readBits(8);
      if ((b & 0xc0) !== 0x80) throw parseError('UTF-8 编码数后续字节非法');
      value = value * 64 + (b & 0x3f);
    }
    return value;
  }
}

/** MSB 优先位写入器（供测试内 fixture 编码与未来 mux 使用） */
export class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.accBits = 0;
  }
  /** 追加 n 位（value 的低 n 位，MSB 先出） */
  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.accBits++;
      if (this.accBits === 8) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.accBits = 0; }
    }
    return this;
  }
  /** 补齐到字节边界（补 0） */
  alignToByte() {
    while (this.accBits !== 0) this.writeBits(0, 1);
    return this;
  }
  /** 合并另一个 writer 的全部位（含未对齐尾部），保持位级连续（子帧拼接用） */
  merge(other) {
    for (const b of other.bytes) this.writeBits(b, 8);
    if (other.accBits > 0) this.writeBits(other.acc, other.accBits);
    return this;
  }
  /** 输出最终字节数组 */
  toUint8Array() {
    this.alignToByte();
    return new Uint8Array(this.bytes);
  }
}
