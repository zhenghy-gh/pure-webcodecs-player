/**
 * BitReader / BitWriter：按位读写器（H.264/H.265 NAL、exp-Golomb、AAC ASC 等
 * 位流语法的基础原语），全仓唯一实现（ts/flv/flac 经由此处复用）。
 * 一次最多读 32 位；更长的丢弃型消费请用 skipBits。
 */
import { parseError } from './errors.js';

export class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes, bitOffset = 0) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('BitReader expects Uint8Array');
    if (!Number.isSafeInteger(bitOffset) || bitOffset < 0 || bitOffset > bytes.byteLength * 8) {
      throw parseError(`bit offset out of range: ${bitOffset}`);
    }
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
    if (!Number.isSafeInteger(n) || n < 0) throw parseError(`readBits: invalid length ${n}`);
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

  /** readBit 的语义别名（H.264/H.265 语法里的 f(n) 标志位） */
  readFlag() {
    return this.readBit();
  }

  /**
   * 读 n 位，MSB 在前。
   * @param {number} n 1..32
   * @returns {number} 无符号整数
   */
  readBits(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw parseError(`readBits: invalid length ${n}`);
    if (n === 0) return 0;
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
    if (!Number.isSafeInteger(n) || n < 0 || n > 32) throw parseError(`readSignedBits: invalid length ${n}`);
    if (n === 0) return 0;
    const v = this.readBits(n);
    if (n === 32) return v | 0;
    const sign = 1 << (n - 1);
    return (v & sign) !== 0 ? v - (1 << n) : v;
  }

  /** 无符号 Exp-Golomb ue(v)（H.264/H.265 语法；>32 前导零判为非法码流） */
  readUE() {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
      if (zeros > 32) throw parseError('invalid exp-Golomb code (>32 leading zeros)');
    }
    if (zeros === 0) return 0;
    // 用 2**n 而非 (1 << n)：leadingZeros >= 31 时 << 会溢出 32 位有符号整数
    return (2 ** zeros) - 1 + this.readBits(zeros);
  }

  /** 有符号 Exp-Golomb se(v)：ue 值奇偶映射（0→0, 1→+1, 2→-1, 3→+2 …） */
  readSE() {
    const ue = this.readUE();
    if (ue === 0) return 0;
    return ue & 1 ? (ue + 1) >>> 1 : -(ue >>> 1);
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

  /** alignToByte 的语义别名（ts/flv 模块的历史命名） */
  alignByte() {
    return this.alignToByte();
  }

  /** 绝对位定位（供 ExpGolombReader.moreRbspData 回溯使用） */
  seekToBit(bitPos) {
    if (!Number.isSafeInteger(bitPos) || bitPos < 0 || bitPos > this._bytes.byteLength * 8) {
      throw parseError(`bit position out of range: ${bitPos}`);
    }
    this._bitPos = bitPos;
    return this;
  }

  /** 是否还有未读数据位（用于 more_rbsp_data 判断） */
  hasMoreData() {
    return this.bitsRemaining > 0;
  }
}

/**
 * BitWriter：MSB 优先位写入器（ASC/SPS 等 fixture 编码与 mux 场景共用）。
 * Uint8Array 动态扩容；writeBits 追加低 n 位，finish/toUint8Array 补齐字节边界后导出。
 */
export class BitWriter {
  constructor(initialCapacity = 64) {
    this._buf = new Uint8Array(initialCapacity);
    this._len = 0; // 已写满的字节数
    this._bit = 0; // 当前字节的已写位数（0 = 从最高位开始）
  }

  _ensure() {
    if (this._len + 1 <= this._buf.length) return;
    const next = new Uint8Array(Math.max(this._buf.length * 2, this._len + 1));
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
  }

  /** 追加 n 位（value 的低 n 位，MSB 先出） */
  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      if (this._bit === 0) this._ensure();
      this._buf[this._len] |= ((Number(value) >> i) & 1) << (7 - this._bit);
      this._bit += 1;
      if (this._bit === 8) {
        this._bit = 0;
        this._len += 1;
      }
    }
    return this;
  }

  /** 写无符号 Exp-Golomb ue(v) */
  writeUE(value) {
    const v = value + 1;
    const bitsNeeded = 32 - Math.clz32(v); // 有效位数
    this.writeBits(0, bitsNeeded - 1); // 前导 0
    this.writeBits(v, bitsNeeded); // 终止 1 + 权重
    return this;
  }

  /** 写有符号 Exp-Golomb se(v) */
  writeSE(value) {
    return this.writeUE(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** 补齐到字节边界（补 0）；已对齐则原地不动 */
  alignToByte() {
    if (this._bit !== 0) {
      this._bit = 0;
      this._len += 1;
    }
    return this;
  }

  /** alignToByte 的语义别名（ts 模块的历史命名） */
  alignByte() {
    return this.alignToByte();
  }

  /** 合并另一个 writer 的全部位（含未对齐尾部），保持位级连续（子帧拼接用） */
  merge(other) {
    if (!(other instanceof BitWriter)) throw new TypeError('BitWriter.merge expects BitWriter');
    for (let i = 0; i < other._len; i++) this.writeBits(other._buf[i], 8);
    if (other._bit > 0) {
      this.writeBits(other._buf[other._len] >> (8 - other._bit), other._bit);
    }
    return this;
  }

  /** 补齐字节边界并导出结果 Uint8Array（副本） */
  finish() {
    this.alignToByte();
    return this._buf.slice(0, this._len);
  }

  /** finish 的别名（flac 模块的历史命名） */
  toUint8Array() {
    return this.finish();
  }
}
