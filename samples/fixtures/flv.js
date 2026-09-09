/**
 * samples/fixtures/flv.js —— makeFLV()：程序化生成结构合法的 FLV 文件。
 *
 * 结构：9 字节 FLV header → 若干 Tag（每个 Tag 后跟 PreviousTagSize0/4 字节）：
 *   1. SCRIPT(18) tag：@setDataFrame + onMetaData（AMF0 ECMAArray）
 *   2. VIDEO(9)  tag：AVC sequence header（FrameType=1 keyframe, AVCPacketType=0, avcC）
 *   3. [可选 AUDIO(8) tag：AAC sequence header + AudioSpecificConfig]
 *   4. N 个 VIDEO tag：AVC NALU（首帧 keyframe 0x17 / 其余 interframe 0x27）
 *   5. [可选 AUDIO tag：AAC raw 帧]
 *
 * 约定：样本数据可伪造，但 Tag 头长度链、AMF 类型标记、时间戳单调性均合法。
 */

import { u8, concat, ascii, utf8, u16be, u24be, u32be, f64be } from './bytes.js';
import { buildAvcC } from './codecs.js';

/* ---------------- 极简 AMF0 编码器（仅覆盖 onMetaData 所需类型） ---------------- */

/** AMF0 Number: 标记 0x00 + IEEE-754 双精度 */
function amfNumber(n) {
  return concat([u8(0x00), f64be(n)]);
}

/** AMF0 String: 标记 0x02 + u16 长度 + UTF-8 内容 */
function amfString(s) {
  const b = utf8(s);
  return concat([u8(0x02), u16be(b.length), b]);
}

/**
 * AMF0 ECMA Array: 标记 0x08 + u32 条目数 + (u16 键长 + 键 + 值)* + 对象结束符 00 00 09
 */
function amfEcmaArray(obj) {
  const keys = Object.keys(obj);
  const parts = [u8(0x08), u32be(keys.length)];
  for (const k of keys) {
    parts.push(u16be(k.length), ascii(k), obj[k]);
  }
  parts.push(u8(0x00, 0x00, 0x09)); // end marker
  return concat(parts);
}

/* ---------------- FLV 元件 ---------------- */

/** FLV 文件头：'FLV' + 版本 1 + flags（bit2 音频 / bit0 视频）+ DataOffset=9 */
function buildHeader({ hasAudio, hasVideo }) {
  return concat([
    ascii('FLV'),
    u8(0x01),
    u8((hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0)),
    u32be(9), // DataOffset
  ]);
}

/**
 * 单个 Tag：type(1B) + DataSize(3B) + Timestamp 低 24 位 + 时间戳扩展高 8 位
 *          + StreamID(3B, 恒 0) + 数据；随后调用方追加 u32 的 PreviousTagSize。
 */
function buildTag(type, timestampMs, payload) {
  return concat([
    u8(type),
    u24be(payload.length),
    u24be(timestampMs & 0xffffff),
    u8((timestampMs >>> 24) & 0xff), // 扩展时间戳位
    u24be(0), // StreamID 恒为 0
    payload,
  ]);
}

const PREV_TAG_SIZE_HEADER = u32be(0); // 首个 Tag 前的 PreviousTagSize0

/**
 * @param {object} [opts]
 * @param {boolean} [opts.hasVideo=true]     是否含视频轨
 * @param {boolean} [opts.hasAudio=false]    是否含音频轨（AAC）
 * @param {number}  [opts.frameCount=4]      视频帧数
 * @param {number}  [opts.width=320]
 * @param {number}  [opts.height=240]
 * @param {number}  [opts.fps=25]            帧率（决定时间戳步进）
 * @returns {{bytes: Uint8Array, meta: object}}
 */
export function makeFLV(opts = {}) {
  const {
    hasVideo = true,
    hasAudio = false,
    frameCount = 4,
    width = 320,
    height = 240,
    fps = 25,
  } = opts;

  const frameDurMs = Math.round(1000 / fps);
  const durationSec = frameDurMs * frameCount / 1000;
  const avcC = buildAvcC();

  /* ---- onMetaData（值均为 AMF Number）---- */
  const metadataValues = {};
  if (hasVideo) Object.assign(metadataValues, {
    width: amfNumber(width),
    height: amfNumber(height),
    videocodecid: amfNumber(7), // 7 = AVC
    framerate: amfNumber(fps),
    videodatarate: amfNumber(600),
    duration: amfNumber(durationSec),
  });
  if (hasAudio) Object.assign(metadataValues, {
    audiocodecid: amfNumber(10), // 10 = AAC
    audiosamplerate: amfNumber(44100),
    audiodatarate: amfNumber(64),
  });
  const scriptPayload = concat([
    amfString('@setDataFrame'),
    amfString('onMetaData'),
    amfEcmaArray(metadataValues),
  ]);

  /* ---- 组装 Tag 序列 ---- */
  const chunks = [];
  let bytes = concat([
    buildHeader({ hasAudio, hasVideo }),
    PREV_TAG_SIZE_HEADER,
  ]);

  function append(tagType, ts, payload) {
    const tag = buildTag(tagType, ts, payload);
    bytes = concat([bytes, tag, u32be(tag.length)]); // PreviousTagSize = 11 + DataSize
    chunks.push({ type: tagType, timestamp: ts, size: payload.length });
  }

  append(18, 0, scriptPayload); // SCRIPT

  if (hasVideo) {
    // AVC sequence header：keyframe(0x17) + AVCPacketType=0 + CompositionTime=0 + avcC
    append(9, 0, concat([u8(0x17), u8(0x00), u8(0x00, 0x00, 0x00), avcC]));
  }
  if (hasAudio) {
    // AAC sequence header：soundFormat=AAC(10<<4)|rate44k(3<<2)|16bit(1<<1)|stereo(1)=0xAF
    // AudioSpecificConfig 伪造 2 字节 0x12 0x10（AAC-LC / 44.1kHz / 双声道常用编码）
    append(8, 0, concat([u8(0xaf), u8(0x00), u8(0x12, 0x10)]));
  }

  for (let i = 0; i < frameCount; i++) {
    const ts = i * frameDurMs;
    if (hasVideo) {
      const isKey = i === 0;
      // FrameType|CodecID：关键帧 0x17 / 帧间 0x27；AVCPacketType=1（NALU）；CompositionTime=0
      const nalLen = 64; // 伪 NAL 载荷长度（确定性假数据）
      const frameBody = new Uint8Array(nalLen).map((_, j) => (i * 31 + j) & 0xff);
      frameBody[0] = isKey ? 0x65 : 0x41; // NAL 头字节：IDR type5 / 非 IDR type1
      const payload = concat([
        u8(isKey ? 0x17 : 0x27),
        u8(0x01),
        u8(0x00, 0x00, 0x00),
        concat([u32be(nalLen), frameBody]), // AVCC 长度前缀 + NAL
      ]);
      append(9, ts, payload);
    }
    if (hasAudio && i % 2 === 0) {
      // 每 2 帧视频配一帧 AAC raw（AudioSpecificConfig 之后 PacketType=1）
      const raw = new Uint8Array(96).fill(0x5a);
      append(8, ts, concat([u8(0xaf), u8(0x01), raw]));
    }
  }

  return {
    bytes,
    meta: {
      hasVideo, hasAudio, width, height, fps, frameCount,
      frameDurationMs: frameDurMs,
      durationSec,
      tags: chunks, // [{type,timestamp,size}] 供断言
      avcCBytes: Array.from(avcC),
    },
  };
}
