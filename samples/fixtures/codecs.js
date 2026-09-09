/**
 * samples/fixtures/codecs.js —— 共享的"伪码流"元件。
 * 约定：**样本数据可伪造，但封装结构必须合法**——即所有长度字段、标志位、
 * 层级关系与真实规范一致，解析器按真实逻辑应能走通；NAL 载荷内容为确定性假数据，
 * 不追求可被真解码器解码。
 */

import { u8, concat, u16be, ascii } from './bytes.js';

/** 伪造的 H.264 SPS（baseline L3.0 尺寸语义占位，结构合法：NAL 头 0x67 = type 7） */
export const FAKE_SPS = u8(
  0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xf0, 0x8b,
  0x16, 0xa0, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00,
  0x00, 0x06, 0x51, 0xe2, 0x85, 0x54
);

/** 伪造的 H.264 PPS（NAL 头 0x68 = type 8） */
export const FAKE_PPS = u8(0x68, 0xce, 0x3c, 0x80);

/**
 * 构造 avcC（AVCDecoderConfigurationRecord），MP4 的 stsd 与 FLV sequence header 共用。
 * 结构：configurationVersion=1 / profile / compat / level /
 *       lengthSizeMinusOne=3（NALU 长度前缀 4 字节）/ numOfSPS+SPS / numOfPPS+PPS
 */
export function buildAvcC() {
  return concat([
    u8(1), // configurationVersion
    u8(FAKE_SPS[1]), // AVCProfileIndication
    u8(FAKE_SPS[2]), // profile_compatibility
    u8(FAKE_SPS[3]), // AVCLevelIndication
    u8(0xff), // reserved(6) + lengthSizeMinusOne=3 → NALU 用 4 字节长度前缀
    u8(0xe1), // reserved(3) + numOfSequenceParameterSets=1
    u16be(FAKE_SPS.length), FAKE_SPS,
    u8(1), // numOfPictureParameterSets=1
    u16be(FAKE_PPS.length), FAKE_PPS,
  ]);
}

/**
 * 生成一个 AVCC 格式访问单元（4 字节大端长度前缀 + NAL）。
 * @param {number} index 样本序号（决定 IDR/非 IDR 与载荷长度，输出确定）
 */
export function makeAvcSample(index) {
  const isIdr = index === 0;
  // NAL 头：IDR→0x65(type5)，非 IDR→0x41(type1)；nal_ref_idc 均为 3
  const nalHeader = isIdr ? 0x65 : 0x41;
  const fillerLength = 48 + index * 16; // 长度随序号变化，用于检验 stsz 表逐项读取
  const nal = new Uint8Array(1 + fillerLength);
  nal[0] = nalHeader;
  for (let i = 0; i < fillerLength; i++) nal[1 + i] = (index * 7 + i) & 0xff;
  return concat([u32len(nal.length), nal]);
}

function u32len(n) {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

/**
 * Annex-B 起始码格式的伪访问单元（TS PES 载荷用）：AUD + IDR/非IDR NAL。
 */
export function makeAnnexbAvcSample(index) {
  const aud = u8(0x09, 0xf0); // Access Unit Delimiter
  const isIdr = index === 0;
  const sc = u8(0x00, 0x00, 0x00, 0x01);
  const nalHeader = isIdr ? 0x65 : 0x41;
  const filler = new Uint8Array(32 + index * 8).map((_, i) => (index * 13 + i) & 0xff);
  return concat([sc, aud, sc, u8(nalHeader), filler]);
}

/**
 * AAC ADTS 帧（TS 里 AAC 以 ADTS 传输）。
 * 结构：syncword=0xFFF + ID=0 + layer=0 + protection_absent=1 + profile=LC + 44.1kHz + 双声道
 * @param {number} payloadLen 载荷字节数
 */
export function makeAdtsAacFrame(payloadLen) {
  const frameLen = 7 + payloadLen;
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1; // sync(12)=FFF, ID=0, layer=00, protection_absent=1
  // profile(2)=01(LC), sampling_frequency_index(4)=4(44.1kHz), private=0, ch_cfg 最高位(值2→010)
  h[2] = (1 << 6) | (4 << 2) | ((2 >> 2) & 1);
  // ch_cfg 低 2 位(=10)、original/home/版权位全 0、aac_frame_length 高 2 位
  h[3] = ((2 & 3) << 6) | ((frameLen >> 11) & 0x03);
  h[4] = (frameLen >> 3) & 0xff;
  h[5] = ((frameLen & 0x07) << 5) | 0x1f; // buffer_fullness 高 5 位（0x7FF 的高段）
  h[6] = 0xfc; // buffer_fullness 低 6 位 + number_of_raw_data_blocks-1 = 0
  return concat([h, new Uint8Array(payloadLen).fill(0x21)]);
}
