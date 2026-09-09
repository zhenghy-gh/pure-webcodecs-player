/**
 * RBSP 位流写入器（H.264/H.265 共用）。
 * 支持：定长位写入、无符号/有符号指数哥伦布（ue/se）、rbsp 尾比特对齐。
 */

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.bitPos = 0; // 当前字节内已写位数（高位在前）
  }

  /** 写入 n 位无符号整数（高位在前） */
  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      this.cur = (this.cur << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.bitPos = 0;
      }
    }
  }

  /** ue(v)：无符号指数哥伦布 */
  writeUE(value) {
    if (value < 0) throw new RangeError('writeUE 需要非负值');
    const v = value + 1;
    const nbits = 32 - Math.clz32(v); // 有效位数
    this.writeBits(0, nbits - 1); // 前导零
    this.writeBits(v, nbits);
  }

  /** se(v)：有符号指数哥伦布，映射规则 k=2n-1（负）/ -2n（正） */
  writeSE(value) {
    this.writeUE(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** 补齐到字节边界（补 0） */
  alignZero() {
    while (this.bitPos !== 0) this.writeBits(0, 1);
  }

  /** rbsp_trailing_bits()：1 个 1 比特 + 补 0 到字节边界 */
  rbspTrailing() {
    this.writeBits(1, 1);
    this.alignZero();
  }

  /** 输出 RBSP 字节序列 */
  toUint8Array() {
    this.alignZero();
    return Uint8Array.from(this.bytes);
  }
}

/**
 * 仿真预防（emulation prevention）：扫描 RBSP，凡出现 0x000000~0x000003 序列
 * 的前两个零字节后插入 0x03，得到可封装的 EBSP NAL 单元。
 * @param {Uint8Array} rbsp 完整 NAL 字节（含 NAL header）
 * @returns {Uint8Array}
 */
export function emulationPrevent(rbsp) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros === 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}
