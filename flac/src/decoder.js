/**
 * flac/src/decoder.js — FLAC 帧级解码器（JS 参考实现核心）
 * ------------------------------------------------------------
 * 职责：给定一段含完整帧的字节与起始偏移，
 *   1. 解析帧头（CRC-8 校验）
 *   2. 逐声道解码子帧（CONSTANT/VERBATIM/FIXED/LPC + Rice 残差）
 *   3. 立体声去相关还原
 *   4. 字节对齐后整帧 CRC-16 校验，返回帧结束偏移（供建索引/重同步）
 *
 * 输出为整数样本（Int32），由调用方按位深归一化为 f32-planar。
 */
import { BitReader } from './bit-reader.js';
import { parseFrameHeader } from './frame-header.js';
import { decodeSubframe, restoreStereo } from './subframe.js';
import { crc16 } from './crc.js';
import { parseError } from './errors.js';

export class FlacDecoder {
  /**
   * @param {{sampleRate:number, channels:number, bitsPerSample:number}} [streamInfo]
   *        STREAMINFO 值：帧头采样率/位深码为 0 时回退使用。
   */
  constructor(streamInfo = undefined) {
    this.streamInfo = streamInfo || null;
  }

  /**
   * 从 bytes[startOffset] 解码一帧（起始处须位于同步码）。
   * @param {Uint8Array} bytes
   * @param {number} startOffset
   * @returns {{
   *   channels:Int32Array[],
   *   blockSize:number,
   *   sampleRate:number,
   *   channelsCount:number,
   *   bitsPerSample:number,
   *   codedNumber:number,
   *   blockingStrategy:number,
   *   channelMode:string,
   *   startByte:number,
   *   endByte:number   // 含 CRC-16 的下一字节位置
   * }}
   */
  decodeFrame(bytes, startOffset) {
    const { header } = parseFrameHeader(bytes, startOffset);

    const si = this.streamInfo;
    const sampleRate = header.sampleRate || (si ? si.sampleRate : 0);
    const bitsPerSample = header.bitsPerSample || (si ? si.bitsPerSample : 0);
    if (!bitsPerSample) throw parseError('帧头与 STREAMINFO 均未提供位深');

    // 子帧从帧头之后开始，按绝对位游标推进
    let absBit = (startOffset + header.headerBytes) * 8;

    /** @type {Int32Array[]} */
    const channels = [];
    for (let c = 0; c < header.channels; c++) {
      const reader = makeReaderAt(bytes, absBit);
      channels.push(decodeSubframe(reader, { blockSize: header.blockSize, bps: bitsPerSample }));
      absBit = reader.absolutePosition;
    }

    // 位对齐 + 整帧 CRC-16 校验（含填充位）
    const rem = absBit % 8;
    const alignedByte = (rem === 0 ? absBit : absBit + (8 - rem)) / 8;
    const frameEnd = alignedByte + 2; // 追加 2 字节 CRC-16
    if (frameEnd > bytes.length) throw parseError('帧尾越过缓冲末尾');
    const expectCrc = (bytes[alignedByte] << 8) | bytes[alignedByte + 1];
    const actualCrc = crc16(bytes, startOffset, alignedByte);
    if (expectCrc !== actualCrc) {
      throw parseError(
        `整帧 CRC-16 校验失败：期望 0x${expectCrc.toString(16)} 实得 0x${actualCrc.toString(16)}（可能需要重同步）`);
    }

    return {
      channels: header.channelMode !== 'independent' && channels.length === 2
        ? restoreStereo(channels, header.channelMode)
        : channels,
      blockSize: header.blockSize,
      sampleRate,
      channelsCount: header.channels,
      bitsPerSample,
      codedNumber: header.codedNumber,
      blockingStrategy: header.blockingStrategy,
      channelMode: header.channelMode,
      startByte: startOffset,
      endByte: frameEnd,
    };
  }
}

/** 在绝对位偏移处创建 BitReader（内部工具） */
function makeReaderAt(bytes, absBitOffset) {
  const byteOff = Math.floor(absBitOffset / 8);
  const reader = new BitReader(bytes, byteOff);
  reader.bitPos = absBitOffset - byteOff * 8;
  return reader;
}
