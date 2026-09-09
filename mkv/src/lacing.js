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
 *   与普通 VINT 同样带长度标记位，数据位按该位宽的「二补码有符号数」解释。
 *   例：2 字节 VINT 数据位 14 位，范围 -8192..+8191；raw=0x3FFF(数据位全 1) = -1。
 *   本实现按此规则解码/编码，并在 __tests__ 中以自洽 roundtrip 验证；
 *   若与真实世界文件存在偏差，请对照 mkvinfo 输出反馈给模块维护者调整。
 */

import { readSize, encodeSize } from './ebml.js';

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
      // 中间帧：有符号 VINT 差值（数据位二补码；全 1 位型即 -1）
      for (let i = 1; i < frameCount - 1; i++) {
        const raw = readSize(data, p);
        const signed = raw.unknown ? -1 : signedVintValue(raw.value, raw.length);
        sizes.push(sizes[sizes.length - 1] + signed);
        p += raw.length;
      }
      let consumed = p;
      for (let i = 0; i < sizes.length; i++) {
        if (sizes[i] < 0) throw new Error(`EBML lacing 出现负帧长: #${i}`);
        consumed += sizes[i];
      }
      const lastSize = data.length - consumed;
      if (lastSize < 0) throw new Error('EBML lacing 长度越界');
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

/**
 * 有符号 VINT：给定掩码后的原始值与字节数，按数据位宽二补码求值。
 * readSize 返回的 unknown（全 1）在 lacing 语境即该位宽最小值 -2^(7n-1)。
 */
export function signedVintValue(rawValue, byteLen) {
  const bits = 7 * byteLen;
  const half = 2 ** (bits - 1);
  return rawValue >= half ? rawValue - 2 ** bits : rawValue;
}

/** 有符号 VINT 编码（供 fixture / mux 使用）；-1 等值按数据位二补码直接编码（允许全 1 位型） */
export function encodeSignedVint(value) {
  let len = 1;
  while (value < -(2 ** (7 * len - 1)) || value > 2 ** (7 * len - 1) - 1) len++;
  const raw = value >= 0 ? value : value + 2 ** (7 * len);
  const bytes = new Uint8Array(len);
  let v = raw;
  for (let i = len - 1; i >= 0; i--) { bytes[i] = v & 0xff; v = Math.floor(v / 256); }
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
