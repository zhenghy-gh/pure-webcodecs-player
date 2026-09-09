/**
 * pes.js —— PES（Packetized Elementary Stream）头解析与时间戳处理
 *
 * 一个 PES 包承载一个访问单元（一帧视频 / 一段音频）。
 * 头部结构（ISO 13818-1 §2.4.3.6）：
 *   00 00 01 | stream_id(8) | PES_packet_length(16)
 *   | '10'(2) scrambling(2) priority(1) alignment(1) copyright(1) original(1)
 *   | PTS_DTS_flags(2) ESCR(1) ES_rate(1) DSM_trick(1) copy(1) CRC(1) extension(1)
 *   | PES_header_data_length(8) | [PTS(5)] [DTS(5)] ...
 *
 * 时间戳为 33bit：marker(1) PTS[32..30](3) marker PTS[29..15](15) marker PTS[14..0](15)
 */

/** stream_id 分类 */
export const STREAM_ID = {
  VIDEO_MIN: 0xe0,
  VIDEO_MAX: 0xef,
  AUDIO_MIN: 0xc0,
  AUDIO_MAX: 0xdf,
};

export function isVideoStreamId(id) {
  return id >= STREAM_ID.VIDEO_MIN && id <= STREAM_ID.VIDEO_MAX;
}

export function isAudioStreamId(id) {
  return id >= STREAM_ID.AUDIO_MIN && id <= STREAM_ID.AUDIO_MAX;
}

/**
 * 展开 33bit PTS/DTS。参数为 PES 头中 5 个连续字节。
 * 布局: [7..1]=ts[32..30] [b1:7..0? ]...
 * 精确布局:
 *   b0: marker(1) ts[32..30](3) marker(1)
 *   b1: ts[29..22](8)
 *   b2: ts[21..15](7) marker(1)
 *   b3: ts[14..7](8)
 *   b4: ts[6..0](7) marker(1)
 */
export function decodeTimestamp5(b0, b1, b2, b3, b4) {
  const hi = (b0 >> 1) & 0x07;
  const mid = ((b1 & 0xff) << 7) | ((b2 >> 1) & 0x7f);   // 15bit
  const lo = ((b3 & 0xff) << 7) | ((b4 >> 1) & 0x7f);    // 15bit
  return hi * 2 ** 30 + mid * 2 ** 15 + lo;
}

/**
 * 编码 33bit 时间戳为 5 字节（测试夹具与未来 muxer 使用）。
 * @param {number} ts 33bit 时间戳
 * @param {number} prefixBits 高 3 位前的两位前缀位（'0010'=PTS-only, '0011'=PTS, '0001'=DTS）
 */
export function encodeTimestamp5(ts, prefixBits = 0b0010) {
  const hi = Math.floor(ts / 2 ** 30) & 0x07;
  const mid = Math.floor(ts / 2 ** 15) & 0x7fff;
  const lo = ts & 0x7fff;
  const b0 = ((prefixBits & 0x03) << 4) | (hi << 1) | 0x01;
  const b1 = (mid >> 7) & 0xff;
  const b2 = ((mid & 0x7f) << 1) | 0x01;
  const b3 = (lo >> 7) & 0xff;
  const b4 = ((lo & 0x7f) << 1) | 0x01;
  return new Uint8Array([b0, b1, b2, b3, b4]);
}

/**
 * 解析完整 PES 头。
 * @param {Uint8Array} data 以 00 00 01 起始的完整 PES 数据
 * @returns {{
 *   streamId:number, payloadOffset:number,
 *   pts:number|null, dts:number|null,
 *   declaredLength:number
 * }|null} 非法数据返回 null
 */
export function parsePESHeader(data) {
  if (!data || data.length < 9) return null;
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
  const streamId = data[3];
  const declaredLength = (data[4] << 8) | data[5];
  if ((data[6] & 0xc0) !== 0x80) return null; // 必须 '10'
  const flags1 = data[7];
  const headerDataLength = data[8];
  const hasPts = (flags1 & 0x80) !== 0;
  const hasDts = (flags1 & 0x40) !== 0;

  let pts = null;
  let dts = null;
  let offset = 9;
  if (hasPts && offset + 5 <= data.length) {
    pts = decodeTimestamp5(data[offset], data[offset + 1], data[offset + 2], data[offset + 3], data[offset + 4]);
    offset += 5;
  }
  if (hasDts && offset + 5 <= data.length) {
    dts = decodeTimestamp5(data[offset], data[offset + 1], data[offset + 2], data[offset + 3], data[offset + 4]);
  }
  return {
    streamId,
    declaredLength,
    pts,
    dts,
    payloadOffset: 9 + headerDataLength,
  };
}
