/**
 * BitReader：按位读取器（H.264/H.265 NAL、exp-Golomb 等位流解析的基础）。
 * 一次最多读 32 位；超过请分段读取。
 */
import { parseError } from './errors.js';

export class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes, bitOffset = 0) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('BitReader expects Uint8Array');
    this._bytes = bytes;
    this._bitPos = bitOffset;
  }

  get bitPosition() {
    return this._bitPos;
  }

  get bitsRemaining() {
    return Math.max(0, this._bytes.byteLength * 8 - this._bitPos);
  }

  get byteAligned() {
    return this._bitPos % 8 === 0;
  }

  _need(n) {
    if (n < 0) throw parseError(`readBits: negative length ${n}`);
    if (this.bitsRemaining < n) {
      throw parseError(`bit overflow: need ${n} bits at ${this._bitPos}, remaining=${this.bitsRemaining}`);
    }
  }

  readBit() {
    this._need(1);
    const byte = this._bytes[this._bitPos >> 3];
    const bit = (byte >> (7 - (this._bitPos & 7))) & 1;
    this._bitPos += 1;
    return bit;
  }

  /**
   * 读 n 位，MSB 在前。
   * @param {number} n 1..32
   * @returns {number} 无符号整数
   */
  readBits(n) {
    if (n <= 0) return 0;
    if (n > 32) throw parseError(`readBits supports up to 32 bits, got ${n}`);
    this._need(n);
    let value = 0;
    let remaining = n;
    // 先按整字节快速消费
    while (remaining >= 8 && (this._bitPos & 7) === 0) {
      value = (value << 8) | this._bytes[this._bitPos >> 3];
      this._bitPos += 8;
      remaining -= 8;
    }
    while (remaining > 0) {
      value = (value << 1) | this.readBit();
      remaining -= 1;
    }
    return value >>> 0;
  }

  /** 有符号 n 位补码读取 */
  readSignedBits(n) {
    if (n <= 0) return 0;
    const v = this.readBits(n);
    if (n === 32) return v | 0;
    const sign = 1 << (n - 1);
    return (v & sign) !== 0 ? v - (1 << n) : v;
  }

  peekBits(n) {
    const saved = this._bitPos;
    try {
      return this.readBits(n);
    } finally {
      this._bitPos = saved;
    }
  }

  skipBits(n) {
    this._need(n);
    this._bitPos += n;
    return this;
  }

  /** 跳到下一字节边界（rbsp trailing bits 对齐） */
  alignToByte() {
    const rem = this._bitPos % 8;
    if (rem !== 0) this.skipBits(8 - rem);
    return this;
  }

  /** 绝对位定位（供 ExpGolombReader.moreRbspData 回溯使用） */
  seekToBit(bitPos) {
    this._bitPos = bitPos;
    return this;
  }

  /** 是否还有未读数据位（用于 more_rbsp_data 判断） */
  hasMoreData() {
    return this.bitsRemaining > 0;
  }
}
