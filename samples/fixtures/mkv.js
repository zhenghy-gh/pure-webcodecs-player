/**
 * samples/fixtures/mkv.js —— makeMKV()：程序化生成结构合法的最小 Matroska 文件。
 *
 * 结构（所有 Master 元素使用"已知长度"，便于两遍装配与确定性输出）：
 *   EBML 头（DocType=matroska, DocTypeVersion=4）
 *   Segment
 *     Info        （TimecodeScale=1ms / Duration(f64) / MuxingApp / WritingApp）
 *     Tracks
 *       TrackEntry（TrackNumber=1 / TrackUID=1 / TrackType=video /
 *                   CodecID="V_MPEG4/ISO/AVC" / CodecPrivate=avcC / Video(320x240)）
 *     Cluster     （Timecode=0 + 2 个 SimpleBlock：关键帧与非关键帧）
 *
 * EBML 编码要点：ID 首字节前导 0 的个数决定 ID 长度；尺寸 VINT 同理，
 * 首字节的"剩余位"即数值本身（本文件全部元素 ≤ 127 字节时走单字节 VINT，其余多字节）。
 */

import { u8, concat, ascii, i16be, f64be, fromHex } from './bytes.js';
import { buildAvcC } from './codecs.js';

/* ---------------- EBML 基元 ---------------- */

/** 元素 = ID 字节 + 尺寸 VINT + 载荷 */
function el(idHex, payload) {
  const id = fromHex(idHex);
  return concat(id, ebmlSize(payload.length), payload);
}

/** 把内容长度编码为 EBML 尺寸 VINT（最短表示） */
export function ebmlSize(len) {
  if (len < 0x7f) return u8(0x80 | len); // 单字节（上限 126，避免撞上全 1 的"未知长度"保留型）
  // 找到能容纳的最短字节数 n（n≥2）
  let n = 2;
  while (len > Math.pow(2, 7 * n) - 1 && n < 8) n++;
  const out = new Uint8Array(n);
  out[0] = (1 << (8 - n)) | (Math.floor(len / Math.pow(256, n - 1)) & (0xff >> n));
  for (let i = 1; i < n; i++) {
    out[i] = Math.floor(len / Math.pow(256, n - 1 - i)) & 0xff;
  }
  return out;
}

/** 无符号整数元素（最短大端表示；0 写单字节 0x00） */
function uintEl(idHex, n) {
  const v = BigInt(n);
  const tmp = [];
  let x = v;
  do {
    tmp.unshift(Number(x & 0xffn));
    x >>= 8n;
  } while (x > 0n);
  return el(idHex, Uint8Array.from(tmp));
}

/** 浮点元素（f64） */
function floatEl(idHex, n) {
  return el(idHex, f64be(n));
}

/** ASCII 字符串元素 */
function strEl(idHex, s) {
  return el(idHex, ascii(s));
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {object} [opts]
 * @param {number} [opts.width=320]
 * @param {number} [opts.height=240]
 * @param {number} [opts.durationMs=2000]  Info.Duration（毫秒，配合 TimecodeScale=1e6）
 * @returns {{bytes: Uint8Array, meta: object}}
 */
export function makeMKV(opts = {}) {
  const { width = 320, height = 240, durationMs = 2000 } = opts;

  /* ---- EBML 头 ---- */
  const ebmlHeader = el('1A45DFA3', concat(
    uintEl('4286', 1), // EBMLVersion
    uintEl('42F7', 1), // EBMLReadVersion
    uintEl('42F2', 4), // EBMLMaxIDLength
    uintEl('42F3', 8), // EBMLMaxSizeLength
    strEl('4282', 'matroska'), // DocType
    uintEl('4287', 4), // DocTypeVersion
    uintEl('4285', 2), // DocTypeReadVersion
  ));

  /* ---- Info ---- */
  const info = el('1549A966', concat(
    uintEl('2AD7B1', 1000000), // TimecodeScale：1ms
    floatEl('4489', durationMs), // Duration
    strEl('4D80', 'fixtures'), // MuxingApp
    strEl('5741', 'fixtures'), // WritingApp
  ));

  /* ---- Tracks → TrackEntry(video/AVC) ---- */
  const video = el('E0', concat(
    uintEl('B0', width), // PixelWidth
    uintEl('BA', height), // PixelHeight
  ));
  const trackEntry = el('AE', concat(
    uintEl('D7', 1), // TrackNumber
    uintEl('73C5', 1), // TrackUID
    uintEl('83', 1), // TrackType: 1=video
    strEl('86', 'V_MPEG4/ISO/AVC'), // CodecID
    el('63A2', buildAvcC()), // CodecPrivate = avcC
    video,
  ));
  const tracks = el('1654AE6B', trackEntry);

  /* ---- Cluster：Timecode=0 + SimpleBlock×2 ---- */
  function simpleBlock(relativeTc, keyframe) {
    const dataLen = 96;
    const frame = new Uint8Array(dataLen);
    frame[0] = keyframe ? 0x65 : 0x41; // NAL 头字节（伪数据）
    for (let j = 1; j < dataLen; j++) frame[j] = (relativeTc + j) & 0xff;
    return el('A3', concat(
      u8(0x81), // Track Number 的 VINT 编码（值 1）
      i16be(relativeTc), // 相对时间码（有符号 16bit 大端）
      u8(keyframe ? 0x80 : 0x00), // flags：bit7 关键帧
      frame,
    ));
  }
  const cluster = el('1F43B675', concat(
    uintEl('E7', 0), // Cluster Timecode
    simpleBlock(0, true),
    simpleBlock(1000, false),
  ));

  /* ---- Segment（已知长度）---- */
  const segment = el('18538067', concat(info, tracks, cluster));

  return {
    bytes: concat(ebmlHeader, segment),
    meta: {
      docType: 'matroska',
      docTypeVersion: 4,
      width, height,
      timecodeScaleNs: 1000000,
      durationMs,
      trackNumber: 1,
      codecId: 'V_MPEG4/ISO/AVC',
      blocks: [{ relativeTc: 0, keyframe: true }, { relativeTc: 1000, keyframe: false }],
    },
  };
}
