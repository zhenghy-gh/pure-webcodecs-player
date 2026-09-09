/**
 * RTP（RFC 3550）固定头解析。
 *
 * 0                   1                   2                   3
 * |V|P|X|  CC   |M|     PT    |       sequence number       |
 * |                           timestamp                        |
 * |                     SSRC                                   |
 * |      CSRC[CC] ...         [ extension header ... ]          |
 */

import { errors } from './errors.js';

export class RtpPacket {
  constructor(o) {
    /** 协议版本，恒为 2 */
    this.version = o.version;
    this.padding = o.padding;
    this.extension = o.extension;
    /** Marker 位：H264/H265 约定 AU 的最后一个包置 1 */
    this.marker = o.marker;
    /** payload type（动态 96~127 常见于视频） */
    this.payloadType = o.payloadType;
    /** 序列号（0~65536 循环），用于丢包检测与重排 */
    this.sequence = o.sequence;
    /** 时间戳：90kHz ticks；同一 Access Unit 的所有包相同 */
    this.timestamp = o.timestamp;
    this.ssrc = o.ssrc;
    this.csrc = o.csrc;
    /** 扩展头原始字节（不含）后为 null */
    this.headerExtension = o.headerExtension;
    /** 载荷字节（RTP 封装的 NAL/FU 等） */
    this.payload = o.payload;
    /** 解析出的 padding 长度 */
    this.paddingLength = o.paddingLength ?? 0;
  }
}

/**
 * 解析一个 RTP 包。输入可以是整包或「流中带前缀」的视图由调用方裁剪好。
 * @param {Uint8Array} data 完整 RTP 包
 * @throws {Error} 包过短或版本不为 2
 */
export function parseRtp(data) {
  if (!(data instanceof Uint8Array)) throw errors.source('RTP 输入必须是 Uint8Array');
  if (data.length < 12) throw errors.parse(`RTP 包过短: ${data.length} 字节`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const b0 = dv.getUint8(0);
  const version = b0 >> 6;
  if (version !== 2) throw errors.parse(`不支持的 RTP 版本: ${version}`);

  let offset = 12;
  const csrcCount = b0 & 0x0f;
  const csrc = [];
  if (data.length < offset + csrcCount * 4) throw errors.parse('CSRC 区被截断');
  for (let i = 0; i < csrcCount; i++) {
    csrc.push(dv.getUint32(offset + i * 4));
  }
  offset += csrcCount * 4;

  let headerExtension = null;
  const hasExt = (b0 & 0x10) !== 0;
  if (hasExt) {
    if (data.length < offset + 4) throw errors.parse('扩展头被截断');
    const extLen = dv.getUint16(offset + 2); // 以 4 字节为单位的长度
    const totalExt = 4 + extLen * 4;
    if (data.length < offset + totalExt) throw errors.parse('扩展头载荷被截断');
    headerExtension = data.subarray(offset, offset + totalExt);
    offset += totalExt;
  }

  let payload = data.subarray(offset);
  const hasPadding = (b0 & 0x20) !== 0;
  let paddingLength = 0;
  if (hasPadding && payload.length > 0) {
    paddingLength = payload[payload.length - 1];
    if (paddingLength > payload.length) throw errors.parse('padding 长度非法');
    payload = payload.subarray(0, payload.length - paddingLength);
  }

  return new RtpPacket({
    version,
    padding: hasPadding,
    extension: hasExt,
    marker: (dv.getUint8(1) & 0x80) !== 0,
    payloadType: dv.getUint8(1) & 0x7f,
    sequence: dv.getUint16(2),
    timestamp: dv.getUint32(4),
    ssrc: dv.getUint32(8),
    csrc,
    headerExtension,
    payload,
    paddingLength,
  });
}

/** 序列号回绕安全的比较：a 是否严格新于 b（RFC 1982 简化版） */
export function seqNewer(a, b) {
  const diff = (a - b) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}
