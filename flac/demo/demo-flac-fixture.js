/**
 * flac/demo/demo-flac-fixture.js — 程序化生成演示用 FLAC 流
 * 复用模块内的 BitWriter/CRC，编码 VERBATIM 子帧正弦扫频（离线可复现）。
 */
import { BitWriter } from '../src/bit-reader.js';
import { crc8, crc16 } from '../src/crc.js';

/** 生成 0.5 秒 220→1760Hz 扫频、16bit 单声道、每帧 1024 样本的合法 FLAC */
export function buildDemoFlac() {
  const sampleRate = 32000;
  const totalSamples = sampleRate / 2 | 0;
  const blockSize = 1024;
  const samples = new Int16Array(totalSamples);
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const freq = 220 + (1760 - 220) * (t / (totalSamples / sampleRate));
    phase += (2 * Math.PI * freq) / sampleRate;
    samples[i] = Math.round(Math.sin(phase) * Math.min(1, t * 10) * 26000);
  }

  /** STREAMINFO 34 字节 */
  const si = new Uint8Array(34);
  const dv = new DataView(si.buffer);
  dv.setUint16(0, blockSize); dv.setUint16(2, blockSize);
  dv.setUint32(10, ((sampleRate << 12) | (0 << 9) | (15 << 4)));
  si[13] = (si[13] & 0xf0) | 0;
  dv.setUint32(14, totalSamples >>> 0);

  /** 元数据块封装 */
  const block = (type, body, last) => {
    const h = new Uint8Array(4);
    h[0] = (last ? 0x80 : 0) | type;
    h[1] = (body.length >> 16) & 0xff; h[2] = (body.length >> 8) & 0xff; h[3] = body.length & 0xff;
    return concat(h, body);
  };

  /** 一帧：帧头 + VERBATIM 子帧 + CRC-16 */
  const makeFrame = (slice, codedNumber) => {
    const w = new BitWriter();
    w.writeBits(0b11111111111110, 14).writeBits(0, 1).writeBits(0, 1)
      .writeBits(7, 4)     // blockSizeCode=0111 → 后跟 16 位
      .writeBits(13, 4)    // sampleRateCode=1101 → 后跟 16 位 Hz
      .writeBits(0, 4)     // 单声道独立
      .writeBits(4, 3)     // 16 bit
      .writeBits(0, 1);
    writeUtf(w, codedNumber);
    w.writeBits(slice.length - 1, 16);
    w.writeBits(sampleRate, 16);
    w.alignToByte();
    const headBytes = w.toUint8Array();
    const crc = crc8(headBytes);
    const headFull = concat(headBytes, new Uint8Array([crc]));

    const body = new BitWriter();
    body.writeBits(0, 1).writeBits(0b000001, 6).writeBits(0, 1); // VERBATIM
    for (const s of slice) {
      const v = s < 0 ? s + 65536 : s;
      body.writeBits(v, 16);
    }
    body.alignToByte();
    const payload = concat(headFull, body.toUint8Array());
    const c = crc16(payload);
    return concat(payload, new Uint8Array([(c >> 8) & 0xff, c & 0xff]));
  };

  const frames = [];
  for (let off = 0; off < totalSamples; off += blockSize) {
    frames.push(makeFrame(samples.subarray(off, Math.min(off + blockSize, totalSamples)), off));
  }

  const magic = new TextEncoder().encode('fLaC');
  return concat(magic, block(0, si, true), ...frames);
}

function writeUtf(w, v) {
  if (v < 0x80) w.writeBits(v, 8);
  else if (v < 0x800) { w.writeBits(0xc0 | (v >> 6), 8); w.writeBits(0x80 | (v & 0x3f), 8); }
  else { w.writeBits(0xe0 | (v >> 12), 8); w.writeBits(0x80 | ((v >> 6) & 0x3f), 8); w.writeBits(0x80 | (v & 0x3f), 8); }
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
