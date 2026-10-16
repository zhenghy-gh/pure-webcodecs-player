/**
 * lacing.js —— Matroska Block/SimpleBlock 的 Lacing（连帧打包）编解码
 *
 * Lacing 把多个小帧打进一个 Block：flags 字节低两位选择模式——
 *   0b00 none   单帧
 *   0b01 Xiph   每帧长度用「锁存字节」编码（Vorbis/Theora 风格）
 *   0b10 fixed  等分
 *   0b11 EBML   首帧无符号 VINT，后续帧为与前帧的差值（有符号 VINT），末帧由余量推得
 *
 * 【互操作校验点】"有符号 VINT" 的规范语义：
 *   有符号值 = VINT 数据位的无符号值 - (2^(7*n-1)-1)。
 *   例：1 字节偏置为 63，raw=61 表示 -2，raw=63 表示 0，raw=127 表示 +64。
 *   全 1 数据位在此语境是合法最大正值，不是 Size VINT 的未知长度哨兵。
 */

import { readSize, encodeSize, vintLength, EbmlError } from './ebml.js';

export const LACING_NONE = 0;
export const LACING_XIPH = 1;
export const LACING_FIXED = 2;
export const LACING_EBML = 3;

/**
 * 解码 laced 帧。
 * @param {number} laceType flags 低两位（0..3）
 * @param {Uint8Array} data Block 载荷中去除 [track#][relTimecode:int16][flags] 后的数据
 * @returns {{frames:Uint8Array[], headerBytes:number}} frames 为 data 上的视图
 */
export function decodeLacing(laceType, data) {
  switch (laceType) {
    case LACING_NONE:
      return { frames: [data.subarray()], headerBytes: 0 };

    case LACING_XIPH: {
      const frameCount = data[0] + 1; // 帧数-1 存于首字节
      let p = 1;
      const sizes = [];
      for (let i = 0; i < frameCount - 1; i++) {
        // 锁存字节链：255 表示继续，直到 <255
        let size = 0, latch;
        // 截断防护：锁存链越界即报错（此前读到 undefined→NaN 使 lastSize 守卫失效）
        do {
          if (p >= data.length) throw new Error('Xiph lacing 锁存链截断');
          latch = data[p++];
          size += latch;
        } while (latch === 255);
        sizes.push(size);
      }
      let consumed = p;
      for (const s of sizes) consumed += s;
      const lastSize = data.length - consumed;
      if (lastSize < 0) throw new Error('Xiph lacing 长度越界');
      const frames = [];
      let off = p;
      for (const s of sizes) { frames.push(data.subarray(off, off + s)); off += s; }
      frames.push(data.subarray(off));
      return { frames, headerBytes: p };
    }

    case LACING_FIXED: {
      const frameCount = data[0] + 1;
      const body = data.length - 1;
      if (body % frameCount !== 0) throw new Error(`fixed-size lacing 无法等分: ${body}/${frameCount}`);
      const per = body / frameCount;
      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        frames.push(data.subarray(1 + i * per, 1 + (i + 1) * per));
      }
      return { frames, headerBytes: 1 };
    }

    case LACING_EBML: {
      // 首字节：帧数-1
      const frameCount = data[0] + 1;
      // 首帧尺寸：无符号 VINT
      const first = readSize(data, 1);
      if (first.unknown) throw new Error('EBML lacing 首帧尺寸非法（未知长度）');
      const sizes = [first.value];
      let p = 1 + first.length;
      // 中间帧：有符号 VINT 差值。全 1 数据位在此语境是合法最大
      // 正值，不能按 Size VINT 的 unknown 哨兵处理。
      for (let i = 1; i < frameCount - 1; i++) {
        const raw = readSignedVint(data, p);
        const nextSize = sizes[sizes.length - 1] + raw.value;
        if (!Number.isSafeInteger(nextSize)) throw new Error('EBML lacing 帧长超出安全整数范围');
        if (nextSize < 0) throw new Error(`EBML lacing 出现负帧长: #${i}`);
        sizes.push(nextSize);
        p += raw.length;
      }
      let consumed = p;
      for (let i = 0; i < sizes.length; i++) {
        if (!Number.isSafeInteger(sizes[i]) || sizes[i] < 0) {
          throw new Error(`EBML lacing 出现非法帧长: #${i}=${sizes[i]}`);
        }
        if (sizes[i] > data.length - consumed) throw new Error('EBML lacing 长度越界');
        consumed += sizes[i];
      }
      const lastSize = data.length - consumed;
      sizes.push(lastSize);
      const frames = [];
      let off = p;
      for (const s of sizes) { frames.push(data.subarray(off, off + s)); off += s; }
      return { frames, headerBytes: p };
    }

    default:
      throw new Error(`未知 lacing 类型: ${laceType}`);
  }
}

/** 读取 EBML 有符号 VINT（偏置映射，而非二补码/Size unknown 语义）。 */
function readSignedVint(bytes, pos) {
  if (pos >= bytes.length) throw new EbmlError('Signed VINT 越界');
  const len = vintLength(bytes[pos]);
  if (pos + len > bytes.length) throw new EbmlError(`Signed VINT 越界: 需要 ${len} 字节`);
  let raw = BigInt(bytes[pos] & (len === 8 ? 0x00 : 0xff >> len));
  for (let i = 1; i < len; i++) raw = (raw << 8n) | BigInt(bytes[pos + i]);
  const value = raw - ((1n << BigInt(7 * len - 1)) - 1n);
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EbmlError(`Signed VINT 超出安全整数范围: ${value}`);
  }
  return { value: Number(value), length: len };
}

/** 有符号 VINT 数据位的标准偏置映射：signed = raw - (2^(7n-1)-1)。 */
export function signedVintValue(rawValue, byteLen) {
  if (!Number.isSafeInteger(byteLen) || byteLen < 1 || byteLen > 8) {
    throw new EbmlError(`有符号 VINT 字节数非法: ${byteLen}`);
  }
  let raw;
  if (typeof rawValue === 'bigint' && rawValue >= 0n) raw = rawValue;
  else if (Number.isSafeInteger(rawValue) && rawValue >= 0) raw = BigInt(rawValue);
  else throw new EbmlError(`有符号 VINT 原始值必须是非负安全整数: ${rawValue}`);
  if (raw > (1n << BigInt(7 * byteLen)) - 1n) {
    throw new EbmlError(`有符号 VINT 原始值超出 ${byteLen} 字节范围: ${raw}`);
  }
  const signed = raw - ((1n << BigInt(7 * byteLen - 1)) - 1n);
  if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EbmlError(`有符号 VINT 超出安全整数范围: ${signed}`);
  }
  return Number(signed);
}

/** 有符号 VINT 编码（偏置编码；全 1 数据位是合法的最大正值）。 */
export function encodeSignedVint(value) {
  if (!Number.isSafeInteger(value)) throw new EbmlError(`有符号 VINT 必须是安全整数: ${value}`);
  const signed = BigInt(value);
  let len = 1;
  while (len <= 8) {
    const bias = (1n << BigInt(7 * len - 1)) - 1n;
    const min = -bias;
    const max = bias + 1n;
    if (signed >= min && signed <= max) break;
    len++;
  }
  if (len > 8) throw new EbmlError(`有符号 VINT 超出 8 字节容量: ${value}`);
  let raw = signed + (1n << BigInt(7 * len - 1)) - 1n;
  const bytes = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { bytes[i] = Number(raw & 0xffn); raw >>= 8n; }
  bytes[0] &= len === 8 ? 0x01 : 0xff >> len;
  bytes[0] |= (1 << (8 - len)) & 0xff;
  return bytes;
}

/**
 * Xiph lacing 编码。
 * @param {number[]} sizes 各帧长度（最后一帧由余量决定，可不传）
 */
export function encodeXiphHeader(sizes /* 不含最后帧 */) {
  const parts = [Uint8Array.of(sizes.length)]; // 帧数-1
  for (const s of sizes) {
    let rest = s;
    while (rest >= 255) { parts.push(Uint8Array.of(255)); rest -= 255; }
    parts.push(Uint8Array.of(rest));
  }
  return concat(parts);
}

/** EBML lacing 头部编码：sizes 含首帧与全部中间帧（不含末帧） */
export function encodeEbmlLacingHeader(sizes) {
  const parts = [Uint8Array.of(sizes.length)]; // 帧数-1
  parts.push(encodeSize(sizes[0])); // 首帧：无符号
  for (let i = 1; i < sizes.length; i++) {
    parts.push(encodeSignedVint(sizes[i] - sizes[i - 1])); // 中间帧：差值
  }
  return concat(parts);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
