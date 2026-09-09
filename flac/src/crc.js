/**
 * flac/src/crc.js — FLAC 规范要求的 CRC 校验
 * ------------------------------------------------------------
 * · CRC-8：多项式 x^8+x^2+x^1+1（0x07），初值 0 —— 帧头校验
 * · CRC-16：多项式 x^16+x^15+x^2+1（0x8005），初值 0 —— 整帧校验
 */

/** CRC-8 查表（poly 0x07） */
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

/**
 * 计算 CRC-8（FLAC 帧头）。
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end] 不含
 * @returns {number}
 */
export function crc8(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8_TABLE[(crc ^ bytes[i]) & 0xff];
  return crc & 0xff;
}

/** CRC-16 查表（poly 0x8005，无反射） */
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

/**
 * 计算 CRC-16（FLAC 整帧，含帧头与填充位）。
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end] 不含
 * @returns {number}
 */
export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
  return crc & 0xffff;
}
