/**
 * flac/src/frame-header.js — FRAME 帧头解析（spec §9）
 * ------------------------------------------------------------
 * 帧头位布局（MSB first）：
 *   sync(14)=0b11111111111110 | reserved(1)=0 | blockingStrategy(1)
 *   blockSizeCode(4) | sampleRateCode(4) | channelAssign(4)
 *   sampleSizeCode(3) | reserved(1)=0
 *   utfCodedNumber（帧号或采样号，随 blocking strategy）
 *   [blockSize 扩展 8/16 位] [sampleRate 扩展 8/16 位]
 *   CRC-8(poly 0x07)
 */
import { BitReader } from './bit-reader.js';
import { crc8 } from './crc.js';
import { parseError } from './errors.js';

/** 同步码（前 14 位） */
export const FRAME_SYNC = 0b11111111111110;

/** 阻断策略 */
export const BLOCKING = Object.freeze({ FIXED: 0, VARIABLE: 1 });

/** 立体声编码模式 */
export const CHANNEL_MODE = Object.freeze({
  INDEPENDENT: 'independent',
  LEFT_SIDE: 'left_side',   // ch0=左, ch1=左-右
  RIGHT_SIDE: 'right_side', // ch0=右-左, ch1=右
  MID_SIDE: 'mid_side',
});

/**
 * @typedef {Object} FrameHeader
 * @property {number} blockingStrategy  0=fixed(帧号) 1=variable(采样号)
 * @property {number} blockSize         本帧采样帧数
 * @property {number} sampleRate        采样率 Hz；0 表示需回退 STREAMINFO
 * @property {number} channels          实际声道数
 * @property {string} channelMode       CHANNEL_MODE 之一
 * @property {number} bitsPerSample     实际位深；0 表示需回退 STREAMINFO
 * @property {number} codedNumber       帧号（fixed）或首采样序号（variable）
 * @property {number} headerBytes       帧头总字节数
 */

/**
 * 在 bytes[startOffset] 起尝试解析帧头。
 * 调用方保证起始处已对齐同步码（可用 findSync 先扫描）。
 * @param {Uint8Array} bytes
 * @param {number} startOffset
 * @returns {{header:FrameHeader, crc:number}} crc 为帧尾 CRC-8 字节值
 * @throws {PlayerError} PARSE_ERROR（结构非法 / CRC 不符）
 */
export function parseFrameHeader(bytes, startOffset) {
  const reader = new BitReader(bytes, startOffset);

  if (reader.readBits(14) !== FRAME_SYNC) throw parseError('帧同步码不匹配');
  if (reader.readBits(1) !== 0) throw parseError('帧头保留位非 0');
  const blockingStrategy = reader.readBits(1);
  if (blockingStrategy !== BLOCKING.FIXED && blockingStrategy !== BLOCKING.VARIABLE) {
    throw parseError(`阻断策略非法：${blockingStrategy}`);
  }

  // 先读全部码字（扩展字节延后），避免打乱规范位序
  const blockSizeCodeRaw = reader.readBits(4);
  const sampleRateCodeRaw = reader.readBits(4);
  const channelAssignCode = reader.readBits(4);
  const sampleSizeCode = reader.readBits(3);
  if (reader.readBits(1) !== 0) throw parseError('帧头第二保留位非 0');

  // ---- 块大小码（扩展字节延后到 UTF 编码数之后读取） ----
  const blockSizeCode = blockSizeCodeRaw;
  /** -1 表示由扩展字节给出 */
  let blockSize;
  switch (blockSizeCode) {
    case 0: throw parseError('blockSizeCode=0000 保留值');
    case 1: blockSize = 192; break;
    case 2: case 3: case 4: case 5: blockSize = 576 << (blockSizeCode - 2); break;
    case 6: case 7: blockSize = -1; break;
    default: blockSize = 256 << (blockSizeCode - 8); break;
  }

  // ---- 采样率码（0 表示“以 STREAMINFO 为准”；扩展字节同样延后） ----
  const sampleRateCode = sampleRateCodeRaw;
  let sampleRate = 0;
  if (sampleRateCode >= 1 && sampleRateCode <= 11) {
    sampleRate = [
      88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000,
    ][sampleRateCode - 1];
  } else if (sampleRateCode === 15) {
    throw parseError('sampleRateCode=1111 非法');
  }
  // code 0（STREAMINFO）/12/13/14 的取值在扩展字节读取后补齐

  // ---- 声道分配 ----
  let channels;
  let channelMode;
  if (channelAssignCode <= 7) {
    channels = channelAssignCode + 1;
    channelMode = CHANNEL_MODE.INDEPENDENT;
  } else if (channelAssignCode === 8) { channels = 2; channelMode = CHANNEL_MODE.LEFT_SIDE; }
  else if (channelAssignCode === 9) { channels = 2; channelMode = CHANNEL_MODE.RIGHT_SIDE; }
  else if (channelAssignCode === 10) { channels = 2; channelMode = CHANNEL_MODE.MID_SIDE; }
  else throw parseError(`声道分配码非法：${channelAssignCode}`);

  // ---- 位深 ----
  let bitsPerSample = 0;
  switch (sampleSizeCode) {
    case 0: break; // STREAMINFO
    case 1: bitsPerSample = 8; break;
    case 2: bitsPerSample = 12; break;
    case 3: throw parseError('sampleSizeCode=011 保留值');
    case 4: bitsPerSample = 16; break;
    case 5: bitsPerSample = 20; break;
    case 6: bitsPerSample = 24; break;
    case 7: bitsPerSample = 32; break;
  }

  // ---- 规范顺序：UTF 编码数在前，扩展字节在后 ----
  const codedNumber = reader.readUtfCodedNumber();

  let extBlockSize = 0;
  if (blockSizeCode === 6) extBlockSize = reader.readBits(8) + 1;
  else if (blockSizeCode === 7) extBlockSize = reader.readBits(16) + 1;

  if (sampleRateCode === 12) sampleRate = reader.readBits(8) * 1000;        // kHz
  else if (sampleRateCode === 13) sampleRate = reader.readBits(16);         // Hz
  else if (sampleRateCode === 14) sampleRate = Math.floor(reader.readBits(16) / 10);

  reader.alignToByte();
  const headerBytes = reader.byteOffset + (reader.bitPos >> 3) - startOffset + 1; // +CRC8

  if (startOffset + headerBytes > bytes.length) throw parseError('帧头越过缓冲末尾');

  // CRC-8 校验覆盖帧头全部字节（不含 CRC 本身）
  const expectCrc = bytes[startOffset + headerBytes - 1];
  const actualCrc = crc8(bytes, startOffset, startOffset + headerBytes - 1);
  if (expectCrc !== actualCrc) {
    throw parseError(`帧头 CRC-8 校验失败：期望 0x${expectCrc.toString(16)} 实得 0x${actualCrc.toString(16)}`);
  }

  return {
    header: {
      blockingStrategy,
      blockSize: blockSize === -1 ? extBlockSize : blockSize,
      sampleRate,
      channels,
      channelMode,
      bitsPerSample,
      codedNumber,
      headerBytes,
    },
    crc: expectCrc,
  };
}

/**
 * 从任意偏移向后扫描下一个帧同步码位置（重同步用）。
 * @param {Uint8Array} bytes
 * @param {number} fromByte
 * @param {number} toByte
 * @returns {number} 命中偏移；未命中返回 -1
 */
export function findSync(bytes, fromByte, toByte = bytes.length) {
  for (let i = Math.max(0, fromByte); i < toByte - 1; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xfc) === 0xf8) return i;
  }
  return -1;
}
