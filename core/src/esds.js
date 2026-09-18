/**
 * esds box 构造：包装 AudioSpecificConfig（AAC 必需）。
 * 全仓唯一实现（mp4/hls 经由此处复用），基于 core 的 ByteWriter。
 *
 * 描述符 tag 链：
 *   ES_Descriptor(0x03) > DecoderConfigDescriptor(0x04) > decSpecificInfo(0x05)
 */
import { ByteWriter } from './byte-stream.js';

/**
 * @param {Uint8Array|ArrayLike<number>} audioSpecificConfig
 * @param {{
 *   objectTypeIndication?: number, streamType?: number,
 *   bufferSizeDb?: number, maxBitrate?: number, avgBitrate?: number,
 * }} [options]
 */
export function buildEsds(audioSpecificConfig, { objectTypeIndication = 0x40, streamType = 5 /* audio */, bufferSizeDb = 0, maxBitrate = 0, avgBitrate = 0 } = {}) {
  const asc = audioSpecificConfig instanceof Uint8Array ? audioSpecificConfig : new Uint8Array(audioSpecificConfig);
  // decSpecificInfo (tag 0x05)
  const dsi = writeDescriptor(0x05, asc);
  // DecoderConfigDescriptor (tag 0x04): oti(1) streamType/upStream/reserved(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4) + dsi
  const dcdBody = new ByteWriter(64);
  dcdBody.writeU8(objectTypeIndication);
  dcdBody.writeU8((streamType << 2) | 1);
  dcdBody.writeU24(bufferSizeDb);
  dcdBody.writeU32(maxBitrate);
  dcdBody.writeU32(avgBitrate);
  dcdBody.writeRaw(dsi);
  const dcd = writeDescriptor(0x04, dcdBody.toUint8Array());
  // ES_Descriptor (tag 0x03): ES_ID(2) flags(1) + dcd（flags=0 无 FMO 等）
  const esBody = new ByteWriter(16);
  esBody.writeU16(1); // ES_ID
  esBody.writeU8(0); // flags
  esBody.writeRaw(dcd);
  const es = writeDescriptor(0x03, esBody.toUint8Array());
  return fullBox('esds', 0, 0, (w) => w.writeRaw(es));
}

function fullBox(type, version, flags, buildBody) {
  const w = new ByteWriter(256);
  w.writeU32(0).writeFourCC(type);
  w.writeU8(version).writeU24(flags);
  buildBody(w);
  w.patchU32(0, w.length);
  return w.toUint8Array();
}

/** MPEG-4 descriptor：tag + 变长长度（128 系） */
function writeDescriptor(tag, payload) {
  const w = new ByteWriter(payload.byteLength + 6);
  w.writeU8(tag);
  let len = payload.byteLength;
  const bytes = [];
  do {
    bytes.unshift(len & 0x7f);
    len >>>= 7;
  } while (len > 0);
  for (let i = 0; i < bytes.length; i++) {
    w.writeU8((i < bytes.length - 1 ? 0x80 : 0x00) | bytes[i]);
  }
  w.writeRaw(payload);
  return w.toUint8Array();
}
