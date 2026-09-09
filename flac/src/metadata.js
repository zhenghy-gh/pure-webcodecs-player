/**
 * flac/src/metadata.js — METADATA 块解析
 * ------------------------------------------------------------
 * 文件结构：
 *   'f','L','a','C'（4 字节魔数）
 *   METADATA_BLOCK_HEADER：last-flag(1bit) type(7bits) length(24bits, 大端)
 *   METADATA_BLOCK 数据体 × N
 *
 * 块类型：0 STREAMINFO / 1 PADDING / 2 APPLICATION / 3 SEEKTABLE /
 *         4 VORBIS_COMMENT / 5 CUESHEET / 6 PICTURE / 127 非法
 */
import { BitReader } from './bit-reader.js';
import { parseError } from './errors.js';

/** 元数据块类型常量 */
export const BLOCK_TYPE = Object.freeze({
  STREAMINFO: 0,
  PADDING: 1,
  APPLICATION: 2,
  SEEKTABLE: 3,
  VORBIS_COMMENT: 4,
  CUESHEET: 5,
  PICTURE: 6,
});

/**
 * @typedef {Object} FlacStreamInfo
 * @property {number} minBlockSize
 * @property {number} maxBlockSize
 * @property {number} minFrameSize
 * @property {number} maxFrameSize
 * @property {number} sampleRate
 * @property {number} channels        实际声道数 = code + 1
 * @property {number} bitsPerSample   实际位深 = code + 1
 * @property {number} totalSamples    0 表示未知
 * @property {string} md5             32 位 hex（未校验用）
 */

/**
 * @typedef {Object} FlacMetadata
 * @property {FlacStreamInfo|null} streamInfo
 * @property {Array<{type:number, offset:number, length:number}>} blocks
 * @property {Record<string,string>} tags          vorbis comment 键值对
 * @property {Array<{sampleNumber:number, offset:number, frameSamples:number}>} seekPoints
 * @property {{mime:string, description:string, width:number, height:number,
 *             data:Uint8Array}|null} picture
 */

const textDecoder = new TextDecoder();

/**
 * 解析全部元数据块。
 * @param {Uint8Array} bytes 从 'fLaC' 起的完整文件字节
 * @returns {FlacMetadata & {audioOffset:number}} audioOffset=第一帧起始字节
 */
export function parseMetadata(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    throw parseError('缺少 fLaC 魔数');
  }

  /** @type {FlacMetadata} */
  const out = { streamInfo: null, blocks: [], tags: {}, seekPoints: [], picture: null };
  let pos = 4;
  let last = false;

  while (!last) {
    if (pos + 4 > bytes.length) throw parseError('元数据块头越界（文件截断）');
    const header = bytes[pos];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const body = pos + 4;
    if (body + length > bytes.length) throw parseError(`元数据块 ${type} 越界`);
    out.blocks.push({ type, offset: body, length });

    switch (type) {
      case BLOCK_TYPE.STREAMINFO:
        if (!out.streamInfo) out.streamInfo = parseStreamInfo(bytes.subarray(body, body + length));
        break;
      case BLOCK_TYPE.SEEKTABLE:
        parseSeekTable(bytes.subarray(body, body + length), out.seekPoints);
        break;
      case BLOCK_TYPE.VORBIS_COMMENT:
        Object.assign(out.tags, parseVorbisComment(bytes.subarray(body, body + length)));
        break;
      case BLOCK_TYPE.PICTURE:
        if (!out.picture) out.picture = parsePicture(bytes.subarray(body, body + length));
        break;
      default: break; // PADDING/APPLICATION/CUESHEET 跳过
    }
    pos = body + length;
  }

  if (!out.streamInfo) throw parseError('缺少 STREAMINFO 块（FLAC 规范强制首块）');
  return { ...out, audioOffset: pos };
}

/** STREAMINFO 固定 34 字节 */
function parseStreamInfo(b) {
  if (b.length < 34) throw parseError('STREAMINFO 短于 34 字节');
  return {
    minBlockSize: (b[0] << 8) | b[1],
    maxBlockSize: (b[2] << 8) | b[3],
    minFrameSize: (b[4] << 16) | (b[5] << 8) | b[6],
    maxFrameSize: (b[7] << 16) | (b[8] << 8) | b[9],
    sampleRate: (b[10] << 12) | (b[11] << 4) | (b[12] >> 4),
    channels: ((b[12] >> 1) & 0x07) + 1,
    bitsPerSample: (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1,
    totalSamples: ((b[13] & 0x0f) * 2 ** 32) + (b[14] << 24 | b[15] << 16 | b[16] << 8 | b[17]) >>> 0,
    md5: hex(b.subarray(18, 34)),
  };
}

/** SEEKTABLE：每点 18 字节；-1 样本点为占位点，跳过 */
function parseSeekTable(b, out) {
  for (let p = 0; p + 18 <= b.length; p += 18) {
    const hi = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
    const lo = (b[p + 4] << 24 | b[p + 5] << 16 | b[p + 6] << 8 | b[p + 7]) >>> 0;
    const sampleNumber = hi === 0xffffffff && lo === 0xffffffff ? -1 : hi * 2 ** 32 + lo;
    if (sampleNumber < 0) continue; // 占位寻址点
    // 规范 §8.5：stream_offset 为完整 64 位大端整数（字节 8..15），frame_samples
    // 位于字节 16..17。旧实现只拼了偏移的高 32 位、又把偏移低半段当作帧样本数，
    // 对 <4GB 的常规文件会得到 offset=0 与错误的 frameSamples——
    // 新用例（SEEKTABLE 占位/乱序/残尾）暴露该缺陷，此处按规范最小修正。
    const offHi = (b[p + 8] << 24 | b[p + 9] << 16 | b[p + 10] << 8 | b[p + 11]) >>> 0;
    const offLo = (b[p + 12] << 24 | b[p + 13] << 16 | b[p + 14] << 8 | b[p + 15]) >>> 0;
    const off = offHi * 2 ** 32 + offLo;
    const fs = (b[p + 16] << 8) | b[p + 17];
    out.push({ sampleNumber, offset: off, frameSamples: fs });
  }
}

/** VORBIS COMMENT：小端长度前缀；vendor 串 + [长度+KEY=VALUE] 列表 */
function parseVorbisComment(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tags = {};
  let p = 0;
  try {
    const vendorLen = dv.getUint32(p, true); p += 4;
    p += vendorLen;
    const count = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const len = dv.getUint32(p, true); p += 4;
      if (p + len > b.length) break;
      const kv = textDecoder.decode(b.subarray(p, p + len));
      p += len;
      const eq = kv.indexOf('=');
      if (eq > 0) tags[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
    }
  } catch {
    /* 注释区损坏不阻断主流程 */
  }
  return tags;
}

/** PICTURE 块（spec §7.15） */
function parsePicture(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  // pictureType u32、mimeLen u32、descLen u32、宽/高/深度/色数 u32×4、dataLen u32
  p += 4; // picture type（front cover 等，暂不入模型）
  const mimeLen = dv.getUint32(p); p += 4;
  const mime = textDecoder.decode(b.subarray(p, p + mimeLen)); p += mimeLen;
  const descLen = dv.getUint32(p); p += 4;
  const description = textDecoder.decode(b.subarray(p, p + descLen)); p += descLen;
  // 规范 §7.15：width/height 位于变长 mime/description 之后的固定 16 字节段
  // （width(4) height(4) depth(4) colors(4)）。旧实现从固定偏移 8/12 读取——
  // 那里通常是 mime 内容本身（如 'imag' 的 ASCII），非空 mime 时得到乱值；
  // 新用例（PICTURE 类型矩阵）暴露该缺陷，此处改为按当前游标读取后一并跳过 16 字节。
  const width = dv.getUint32(p);
  const height = dv.getUint32(p + 4);
  p += 16;
  const dataLen = dv.getUint32(p); p += 4;
  return { mime, description, width, height, data: b.slice(p, p + dataLen) };
}

function hex(arr) {
  return [...arr].map((x) => x.toString(16).padStart(2, '0')).join('');
}
