/**
 * bits.js —— 大端位流读取器 / 写入器与 Exp-Golomb 编解码
 *
 * H.264/H.265 的 SPS、AAC 的 AudioSpecificConfig、LATM 的 StreamMuxConfig
 * 都是“位对齐”语法，需要按位读写而不是按字节。
 * 本模块同时服务于运行时解析（BitReader）与测试夹具生成（BitWriter）。
 */

export class BitReader {
  /**
   * @param {Uint8Array} bytes 待读取的字节缓冲
   * @param {number} [byteOffset] 起始字节偏移
   */
  constructor(bytes, byteOffset = 0) {
    this.bytes = bytes;
    this.pos = byteOffset;   // 当前字节下标
    this.bit = 0;            // 当前字节内的位下标（0 = 最高位）
  }

  /** 已读位数 */
  get bitsRead() {
    return (this.pos - (this.bit === 0 ? 0 : 0)) * 8 + this.bit;
  }

  /** 剩余可用位数 */
  get bitsLeft() {
    return (this.bytes.length - this.pos) * 8 - this.bit;
  }

  /** 是否已越过缓冲末尾 */
  get overflowed() {
    return this.pos >= this.bytes.length;
  }

  /** 读取 n 位，返回无符号整数（n ≤ 32） */
  readBits(n) {
    let value = 0;
    while (n > 0 && this.pos < this.bytes.length) {
      const take = Math.min(n, 8 - this.bit);
      const mask = (0xff >> this.bit) & (0xff << (8 - this.bit - take));
      value = (value << take) | ((this.bytes[this.pos] & mask) >> (8 - this.bit - take));
      n -= take;
      this.bit += take;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    if (n > 0) throw new Error('BitReader: 缓冲区越界');
    return value >>> 0;
  }

  /** 读取 1 位 */
  readFlag() {
    return this.readBits(1);
  }

  /**
   * 读无符号 Exp-Golomb 码（H.264/H.265 ue(v)）。
   * 编码规则：前导 0 的个数 k，然后一个 1，再跟 k 位二进制值。
   */
  readUE() {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros++;
      if (zeros > 32) throw new Error('BitReader: 非法 Exp-Golomb 码');
    }
    // 到达终止位 1；其后的 zeros 位是二进制权重
    let value = 1;
    for (let i = 0; i < zeros; i++) value = (value << 1) | this.readBits(1);
    return value - 1;
  }

  /** 读有符号 Exp-Golomb 码 se(v)：奇偶映射 */
  readSE() {
    const k = this.readUE();
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1);
  }

  /** 字节对齐（丢弃当前字节剩余位） */
  alignByte() {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos++;
    }
  }
}

export class BitWriter {
  constructor(initialCapacity = 64) {
    this.bytes = new Uint8Array(initialCapacity);
    this.len = 0;   // 已写字节数
    this.bit = 0;   // 当前字节的已写位数
  }

  _ensure(extraBytes = 1) {
    const need = this.len + extraBytes;
    if (need <= this.bytes.length) return;
    let cap = Math.max(this.bytes.length * 2, need);
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.len));
    this.bytes = next;
  }

  /** 写 n 位无符号整数 */
  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      if (this.bit === 0) this._ensure();
      const bitVal = (Number(value) >> i) & 1;
      this.bytes[this.len] |= bitVal << (7 - this.bit);
      this.bit++;
      if (this.bit === 8) {
        this.bit = 0;
        this.len++;
      }
    }
  }

  /** 写无符号 Exp-Golomb ue(v) */
  writeUE(value) {
    const v = value + 1;
    const bitsNeeded = 32 - Math.clz32(v);       // 有效位数
    this.writeBits(0, bitsNeeded - 1);           // 前导 0
    this.writeBits(v, bitsNeeded);               // 终止 1 + 权重
  }

  /** 写有符号 Exp-Golomb se(v) */
  writeSE(value) {
    this.writeUE(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** 字节对齐：不足位补 0 */
  alignByte() {
    if (this.bit !== 0) {
      this.bit = 0;
      this.len++;
    }
  }

  /** 导出结果 Uint8Array */
  finish() {
    this.alignByte();
    return this.bytes.slice(0, this.len);
  }
}

/**
 * MPEG-TS 时间戳（33bit）解回绕：检测向前/向后跳变并折叠到连续时间轴。
 * PTS/DTS 每 2^33 (~26.5h @90kHz) 回绕一次。
 * @param {number} value 当前原始 tick
 * @param {number|null} lastValue 上一次已解绕 tick
 * @returns {number} 连续化后的 tick
 */
export function unwrapTimestamp(value, lastValue) {
  if (lastValue == null) return value;
  const WRAP = 2 ** 33;
  const HALF = 2 ** 32;
  let delta = value - (lastValue % WRAP);
  if (delta > HALF) delta -= WRAP;      // 刚发生回绕：当前值实际在下一圈
  else if (delta < -HALF) delta += WRAP; // 上次值已在下一圈而当前值回到本圈
  return lastValue + delta;
}
