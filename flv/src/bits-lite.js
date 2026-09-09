/**
 * bits-lite.js —— flv 模块内联的位流读取器
 * 与 ts/src/bits.js 的 BitReader 同源精简版（两模块零依赖原则）。
 */

export class BitReader {
  constructor(bytes, byteOffset = 0) {
    this.bytes = bytes;
    this.pos = byteOffset;
    this.bit = 0;
  }

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

  readFlag() {
    return this.readBits(1);
  }

  readUE() {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros++;
      if (zeros > 32) throw new Error('BitReader: 非法 Exp-Golomb 码');
    }
    let value = 1;
    for (let i = 0; i < zeros; i++) value = (value << 1) | this.readBits(1);
    return value - 1;
  }

  readSE() {
    const k = this.readUE();
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1);
  }
}
