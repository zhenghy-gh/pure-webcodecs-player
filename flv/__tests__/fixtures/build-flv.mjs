/**
 * fixtures/build-flv.mjs —— 程序化生成最小合法 FLV 字节序列
 */

import { encodeScriptPair } from '../../src/amf0.js';

/** FLV 头（9B）+ PreviousTagSize0（4B） */
export function flvHeader({ hasAudio = true, hasVideo = true, version = 1 } = {}) {
  const head = new Uint8Array(9);
  head[0] = 0x46; head[1] = 0x4c; head[2] = 0x56;   // 'FLV'
  head[3] = version;
  head[4] = (hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0);
  new DataView(head.buffer).setUint32(5, 9);        // DataOffset
  return concat([head, new Uint8Array(4)]);         // PreviousTagSize0 = 0
}

/**
 * 组装一个 Tag：TagHeader(11) + Data + PreviousTagSize(4)
 * @param {number} type 8/9/18
 * @param {Uint8Array} data
 * @param {number} timestampMs
 */
export function tag(type, data, timestampMs) {
  const header = new Uint8Array(11);
  header[0] = type;
  header[1] = (data.length >> 16) & 0xff;
  header[2] = (data.length >> 8) & 0xff;
  header[3] = data.length & 0xff;
  const t = Math.max(0, Math.floor(timestampMs));
  header[4] = (t >> 16) & 0xff;
  header[5] = (t >> 8) & 0xff;
  header[6] = t & 0xff;
  header[7] = (t >> 24) & 0xff;                     // 扩展位
  // StreamID 恒 0（已初始化为 0）
  return concat([header, data, u32be(data.length + 11)]);
}

export function scriptTag(metadata, timestampMs = 0) {
  return tag(18, encodeScriptPair('onMetaData', metadata), timestampMs);
}

// ---------- 音频 ----------

export function aacSequenceTag(asc, timestampMs = 0) {
  // 0xAF：SoundFormat=10(AAC) SoundRate=3 SoundSize=16bit SoundType=stereo
  return tag(8, concat([new Uint8Array([0xaf, 0x00]), asc]), timestampMs);
}

export function aacRawTag(raw, timestampMs) {
  return tag(8, concat([new Uint8Array([0xaf, 0x01]), raw]), timestampMs);
}

export function mp3RawTag(raw, timestampMs, { stereo = true } = {}) {
  // SoundFormat=2(MP3), rate=3(44k), size=1(16bit), type=stereo/mono
  return tag(8, concat([new Uint8Array([(2 << 4) | (3 << 2) | (1 << 1) | (stereo ? 1 : 0)]), raw]), timestampMs);
}

// ---------- 视频 ----------

/** AVC 序列头（avcC 直接作为 AVCPacketType=0 负载） */
export function avcSequenceTag(avcC, timestampMs = 0) {
  return tag(9, concat([new Uint8Array([0x17, 0x00, 0x00, 0x00, 0x00]), avcC]), timestampMs);
}

/**
 * AVC 视频帧 Tag。
 * @param {boolean} keyframe
 * @param {Uint8Array} avccData 4 字节长度前缀的 NALU 数据
 * @param {number} ts 毫秒 DTS
 * @param {number} [ctsMs] 合成时间偏移（可负）
 */
export function avcVideoTag(keyframe, avccData, ts, ctsMs = 0) {
  const first = keyframe ? 0x17 : 0x27;             // frameType=1|2, codecID=7
  const cts = ctsMs & 0xffffff;
  const head = new Uint8Array([
    first, 0x01,
    (cts >> 16) & 0xff, (cts >> 8) & 0xff, cts & 0xff,
  ]);
  return tag(9, concat([head, avccData]), ts);
}

/** Enhanced-FLV HEVC 序列头（FourCC 'hvc1'，packetType=0 sequence start） */
export function hevcEnhancedSequenceTag(hvcC, timestampMs = 0) {
  const payload = concat([
    Uint8Array.from([0x10, 0x68, 0x76, 0x63, 0x31, 0x00]),  // frameType=1(关键帧) + 'hvc1' + seqStart
    hvcC,
  ]);
  return tag(9, payload, timestampMs);
}

export function hevcEnhancedVideoTag(keyframe, avccData, ts, ctsMs = 0) {
  const frameType = keyframe ? 0x10 : 0x20;
  const cts = ctsMs & 0xffffff;
  const payload = concat([
    Uint8Array.from([frameType, 0x68, 0x76, 0x63, 0x31, 0x01,
      (cts >> 16) & 0xff, (cts >> 8) & 0xff, cts & 0xff]),
    avccData,
  ]);
  return tag(9, payload, ts);
}

// ---------- avcC / hvcC 构造（供测试） ----------

/** 最小 AVCDecoderConfigurationRecord */
export function buildAvcC(sps, pps, { profile = 66, compat = 0xc0, level = 30 } = {}) {
  const out = [];
  out.push(1, profile, compat, level, 0xff, 0xe1);
  out.push((sps.length >> 8) & 0xff, sps.length & 0xff, ...sps);
  out.push(1);
  out.push((pps.length >> 8) & 0xff, pps.length & 0xff, ...pps);
  return Uint8Array.from(out);
}

/** 最小 HEVCDecoderConfigurationRecord（含 VPS+SPS+PPS 各一） */
export function buildHvcC(vps, sps, pps) {
  const arrays = [[32, vps], [33, sps], [34, pps]];
  let size = 23;
  for (const [, n] of arrays) size += 3 + 2 + n.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let off = 0;
  out[off++] = 1;
  out[off++] = 0x01;                    // space=0 tier=0 idc=1(Main)
  view.setUint32(off, 0x60000000); off += 4;
  off += 6;                              // constraints 全零
  out[off++] = 93;                       // level 3.1
  out[off++] = 0xf0; out[off++] = 0x00; // min_spatial_segmentation
  out[off++] = 0xfc;                    // parallelismType
  out[off++] = 0xfd;                    // chromaFormat=1
  out[off++] = 0xf8;                    // bitDepthLuma-8=0
  out[off++] = 0xf8;                    // bitDepthChroma-8=0
  view.setUint16(off, 0); off += 2;      // avgFrameRate
  out[off++] = 0x0f;                     // cfr=0 layers=1 nested=0 lenSize-1=3
  out[off++] = arrays.length;
  for (const [type, nalu] of arrays) {
    out[off++] = 0x80 | type;
    view.setUint16(off, 1); off += 2;
    view.setUint16(off, nalu.length); off += 2;
    out.set(nalu, off); off += nalu.length;
  }
  return out;
}

// ---------- 整流组装 ----------

/**
 * 组装完整 FLV 文件。
 * @param {{
 *   metadata?: object,
 *   video?: { gopSize?:number, frames:number, width?:number, height?:number },
 *   audio?: { count:number, rawSize?:number },
 * }} cfg
 */
export function assembleFlv(cfg = {}) {
  const parts = [flvHeader({ hasAudio: !!cfg.audio, hasVideo: !!cfg.video })];

  if (cfg.metadata) parts.push(scriptTag(cfg.metadata));

  if (cfg.video) {
    const { frames = 8, gopSize = 4 } = cfg.video;
    const sps = cfg.video.sps ?? defaultH264Sps();
    const pps = defaultH264Pps();
    const avcC = buildAvcC(sps, pps);
    parts.push(avcSequenceTag(avcC, 0));
    for (let f = 0; f < frames; f++) {
      const isKey = f % gopSize === 0;
      const nalus = isKey ? [sps, pps, fakeNalu(0x65, 60)] : [fakeNalu(0x41, 40)];
      const data = toAvcc(nalus);
      parts.push(avcVideoTag(isKey, data, f * 33));
    }
  }

  if (cfg.audio) {
    const { count = 8, rawSize = 32, asc = Uint8Array.from([0x12, 0x10]) } = cfg.audio;
    if (asc) parts.push(aacSequenceTag(asc, 0));
    for (let i = 0; i < count; i++) {
      parts.push(aacRawTag(new Uint8Array(rawSize).fill(0x50 ^ i), i * 23));
    }
  }

  return concat(parts);
}

/** 伪 SPS（Baseline 320x240，由位级语法构造）——直接内联避免依赖 ts 模块 */
export function defaultH264Sps() {
  // 通过简易 Exp-Golomb 写出；与 flv/src 的 SPS 解析器闭环验证
  const w = golombWriter();
  w.bits(0x67, 8);
  w.bits(66, 8); w.bits(0xc0, 8); w.bits(30, 8);
  w.ue(0);            // sps_id
  w.ue(4);            // log2_max_frame_num_minus4
  w.ue(2);            // poc_type=2
  w.ue(1);            // max_num_ref_frames
  w.bits(0, 1);
  w.ue(320 / 16 - 1);
  w.ue(240 / 16 - 1);
  w.bits(1, 1);       // frame_mbs_only
  w.bits(1, 1);       // direct_8x8
  w.bits(0, 1);       // crop flag
  w.bits(0, 1);       // vui
  w.stop();
  return w.finish();
}

export function defaultH264Pps() {
  const w = golombWriter();
  w.bits(0x68, 8);
  w.ue(0); w.ue(0);
  w.bits(0, 1); w.bits(0, 1);
  w.ue(0); w.ue(0); w.ue(0);
  w.bits(0, 1); w.bits(0, 2);
  w.se(0); w.se(0); w.se(0);
  w.bits(0, 1); w.bits(0, 1); w.bits(0, 1);
  w.stop();
  return w.finish();
}

/** 简易位写入器（MSB 先行 + Exp-Golomb） */
function golombWriter() {
  const bytes = [];
  let cur = 0;
  let bit = 0;
  return {
    bits(value, n) {
      for (let i = n - 1; i >= 0; i--) {
        cur |= ((value >> i) & 1) << (7 - bit);
        bit++;
        if (bit === 8) { bytes.push(cur); cur = 0; bit = 0; }
      }
    },
    ue(v) {
      const x = v + 1;
      const nb = 32 - Math.clz32(x);
      this.bits(0, nb - 1);
      this.bits(x, nb);
    },
    se(v) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); },
    stop() {
      this.bits(1, 1);
      while (bit !== 0) this.bits(0, 1);
    },
    finish() {
      if (bit !== 0) bytes.push(cur);
      return Uint8Array.from(bytes);
    },
  };
}

function fakeNalu(headerByte, size) {
  const b = new Uint8Array(size);
  b[0] = headerByte;
  for (let i = 1; i < size; i++) b[i] = 0x77 ^ i;
  return b;
}

/** NALU 列表 → AVCC（4 字节长度前缀） */
export function toAvcc(nalus) {
  let total = 0;
  for (const n of nalus) total += 4 + n.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const n of nalus) {
    view.setUint32(off, n.length);
    out.set(n, off + 4);
    off += 4 + n.length;
  }
  return out;
}

function u32be(v) {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function concat(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
