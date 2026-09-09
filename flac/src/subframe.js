/**
 * flac/src/subframe.js — 子帧解码（FLAC 格式规范 §10）
 * ------------------------------------------------------------
 * 子帧头：zeroPad(1)=0 | type(6) | wastedBitsFlag(1) [+unary 个数]
 *   type：000000 CONSTANT / 000001 VERBATIM
 *         001xxx FIXED 预测阶 xxx=0..4
 *         1xxxxx LPC 阶 xxxxx+1=1..32
 *
 * 残差编码（FIXED/LPC 共用）：
 *   分区方式(2)：00=Rice4bit参数 01=Rice5bit 10=保留 11=保留
 *   partitionOrder(4) → 共 2^order 个分区：
 *     · 第 0 分区样本数 = blockSize/order - predictorOrder
 *     · 其余分区样本数 = blockSize/order
 *   每分区：riceParam(4/5 位)；全 1 为转义 → rawLen(5) + 有符号原码残差
 *   否则每残差 = 一元商 q + riceParam 位尾数 r，映射回有符号：
 *     u = q·2^p + r；u 偶 → u/2，u 奇 → -(u+1)/2（zigzag 逆）
 */
import { BitReader } from './bit-reader.js';
import { parseError } from './errors.js';

export const SUBFRAME_TYPE = Object.freeze({
  CONSTANT: 'constant',
  VERBATIM: 'verbatim',
  FIXED: 'fixed',
  LPC: 'lpc',
});

/** FIXED 预测系数表（spec 表 12） */
const FIXED_COEFFS = Object.freeze([
  [],
  [1],
  [2, -1],
  [3, -3, 1],
  [4, -6, 4, -1],
]);

/** 有符号位深还原：按最高位扩展符号 */
function signExtend(value, bits) {
  const signBit = 1 << (bits - 1);
  return (value & (signBit - 1)) - (value & signBit);
}

/** zigzag 逆映射（Number 精度安全，避免 32 位溢出） */
function zigzagInverse(u) {
  return (u & 1) === 0 ? u / 2 : -((u + 1) / 2);
}

/**
 * 解码单个子帧。
 * @param {BitReader} reader 已定位于子帧头的读取器
 * @param {{blockSize:number, bps:number}} ctx 本帧块大小与有效位深
 * @returns {Int32Array} 长度 blockSize 的解码声道
 */
export function decodeSubframe(reader, ctx) {
  if (reader.readBit() !== 0) throw parseError('子帧头填充位非 0');
  const typeCode = reader.readBits(6);
  let type;
  let order = 0;
  if (typeCode === 0) type = SUBFRAME_TYPE.CONSTANT;
  else if (typeCode === 1) type = SUBFRAME_TYPE.VERBATIM;
  else if ((typeCode & 0x38) === 0x08 && (typeCode & 0x07) <= 4) {
    type = SUBFRAME_TYPE.FIXED;
    order = typeCode & 0x07;
    if (order >= ctx.blockSize) throw parseError(`FIXED 阶 ${order} ≥ 块大小 ${ctx.blockSize}`);
  } else if ((typeCode & 0x20) !== 0) {
    type = SUBFRAME_TYPE.LPC;
    order = (typeCode & 0x1f) + 1;
    if (order >= ctx.blockSize) throw parseError(`LPC 阶 ${order} ≥ 块大小 ${ctx.blockSize}`);
  } else {
    throw parseError(`子帧类型码非法：0b${typeCode.toString(2).padStart(6, '0')}`);
  }

  // 浪费位：flag 为 1 时跟一个一元码，零的个数即浪费位数（spec §9.2.2）
  let wasted = 0;
  if (reader.readBit() === 1) {
    while (reader.readBit() === 0) {
      wasted++;
      if (wasted > 31) throw parseError('浪费位计数超限');
    }
  }
  const bps = ctx.bps - wasted;
  if (bps <= 0 || bps > 32) throw parseError(`有效位深非法：${bps}`);

  /** @type {Int32Array} */
  let out;

  switch (type) {
    case SUBFRAME_TYPE.CONSTANT: {
      const v = signExtend(reader.readBits(bps), bps);
      out = new Int32Array(ctx.blockSize).fill(v);
      break;
    }
    case SUBFRAME_TYPE.VERBATIM: {
      out = new Int32Array(ctx.blockSize);
      for (let i = 0; i < ctx.blockSize; i++) out[i] = signExtend(reader.readBits(bps), bps);
      break;
    }
    case SUBFRAME_TYPE.FIXED:
      out = decodeFixed(reader, ctx.blockSize, order, bps);
      break;
    case SUBFRAME_TYPE.LPC:
      out = decodeLpc(reader, ctx.blockSize, order, bps);
      break;
  }

  // 浪费位在解码后左移还原真实幅度
  if (wasted > 0) {
    for (let i = 0; i < out.length; i++) out[i] = out[i] * (1 << wasted);
  }
  return out;
}

/** FIXED 预测：warmup order 个原值，其余为残差 + 多项式外推 */
function decodeFixed(reader, blockSize, order, bps) {
  const out = new Int32Array(blockSize);
  for (let i = 0; i < order; i++) out[i] = signExtend(reader.readBits(bps), bps);
  const coeffs = FIXED_COEFFS[order];
  const residuals = readResiduals(reader, blockSize, order);
  for (let i = order; i < blockSize; i++) {
    let pred = 0;
    for (let j = 0; j < order; j++) pred += coeffs[j] * out[i - 1 - j];
    out[i] = residuals[i - order] + (pred >> order); // 规范要求预测和右移 order 位
  }
  return out;
}

/** LPC 预测：warmup 样本在前，其后为精度/位移/量化系数（spec §9.2.6） */
function decodeLpc(reader, blockSize, order, bps) {
  // 1) warmup 样本（每样本 bps 位，共 order 个）
  const out = new Int32Array(blockSize);
  for (let i = 0; i < order; i++) out[i] = signExtend(reader.readBits(bps), bps);

  // 2) 系数精度（4 位存 precision-1，1111 非法）、无符号位移（5 位）、量化系数
  const precision = reader.readBits(4) + 1;
  if (precision === 16) throw parseError('LPC 系数精度码 1111 非法');
  const shift = reader.readBits(5); // 无符号位移量 0..31
  const coeffs = new Int32Array(order);
  for (let i = 0; i < order; i++) coeffs[i] = signExtend(reader.readBits(precision), precision);

  // 3) 残差
  const residuals = readResiduals(reader, blockSize, order);
  for (let i = order; i < blockSize; i++) {
    let pred = 0;
    for (let j = 0; j < order; j++) pred += coeffs[j] * out[i - 1 - j];
    out[i] = residuals[i - order] + (pred >> shift);
  }
  return out;
}

/**
 * 读残差分区（Rice 编码）。返回长度 blockSize-predictorOrder 的数组，
 * 下标 i 对应样本 i+predictorOrder 的残差。
 */
function readResiduals(reader, blockSize, predictorOrder) {
  const count = blockSize - predictorOrder;
  if (count <= 0) throw parseError('残差数量非正');

  const method = reader.readBits(2);
  if (method === 2 || method === 3) throw parseError(`残差分区方式 ${method} 为保留值`);

  const partitionOrder = reader.readBits(4);
  const partitions = 1 << partitionOrder;
  if (blockSize % partitions !== 0) throw parseError('块大小无法被分区数整除');

  const baseSize = blockSize >> partitionOrder;
  if (baseSize <= predictorOrder) throw parseError('首分区容量不足 warmup 扣除');

  const out = new Int32Array(count);
  let idx = 0;
  for (let p = 0; p < partitions; p++) {
    // 第 0 分区需扣除 predictorOrder 个 warmup 样本
    const n = (p === 0 ? baseSize - predictorOrder : baseSize);
    const riceParam = reader.readBits(method === 0 ? 4 : 5);
    const escape = riceParam === (method === 0 ? 15 : 31);
    let rawBits = 0;
    if (escape) rawBits = reader.readBits(5);
    if (!escape && riceParam === 0) {
      // 参数为 0：尾数 0 位，残差 = ±商
      for (let i = 0; i < n; i++, idx++) out[idx] = zigzagInverse(reader.readUnary());
      continue;
    }
    for (let i = 0; i < n; i++, idx++) {
      if (!escape) {
        const q = reader.readUnary();
        const u = q * (2 ** riceParam) + reader.readBits(riceParam); // 用乘法避免移位溢出
        out[idx] = zigzagInverse(u);
      } else {
        out[idx] = signExtend(reader.readBits(rawBits), rawBits);
      }
    }
  }
  if (idx !== count) throw parseError(`残差数量不符：得 ${idx} 应 ${count}`);
  return out;
}

/**
 * 立体声去相关还原（spec §9.2，就地修改并返回）：
 *   left_side:  ch0=L, ch1=L-R → R = L - side
 *   right_side: ch0=R-L, ch1=R → L = R + side
 *   mid_side:   ch0=(L+R)>>1, ch1=L-R → 官方式还原
 * @param {Int32Array[]} channels
 * @param {string} mode CHANNEL_MODE 之一
 */
export function restoreStereo(channels, mode) {
  if (mode === 'independent' || channels.length !== 2) return channels;
  const a = channels[0];
  const b = channels[1];
  const n = a.length;
  switch (mode) {
    case 'left_side':
      for (let i = 0; i < n; i++) b[i] = a[i] - b[i];
      break;
    case 'right_side':
      for (let i = 0; i < n; i++) a[i] = a[i] + b[i];
      break;
    case 'mid_side':
      for (let i = 0; i < n; i++) {
        const mid = a[i];
        const side = b[i];
        const m2 = (mid << 1) | (side & 1); // 还原被右移丢弃的奇偶位
        const l = (m2 + side) >> 1;
        const r = (m2 - side) >> 1;
        a[i] = l;
        b[i] = r;
      }
      break;
    default:
      throw parseError(`未知立体声模式 ${mode}`);
  }
  return channels;
}
