/**
 * wav/src/riff-parser.js — RIFF/WAVE 容器解析
 * ------------------------------------------------------------
 * WAV 文件结构（小端）：
 *
 *   偏移  字段
 *   0     'R','I','F','F'          RIFF 魔数
 *   4     u32 riffSize             整个文件大小 - 8
 *   8     'W','A','V','E'          形式类型
 *   12    子块循环：id(4) + size(u32) + payload(size) + 奇数补齐 1 字节
 *         ├─ 'fmt ' ：音频格式描述（必含）
 *         ├─ 'data' ：PCM 采样数据（本模块播放目标）
 *         └─ 其他   ：LIST/INFO 元数据、fact、PEAK、cue 等（跳过或提取）
 *
 * 浏览器可行性：纯字节解析，无平台依赖，Node/浏览器均可运行。
 * 时间换算：契约统一微秒，durationUs = dataBytes / byteRate * 1e6。
 */
import { parseError, notSupported, sourceError } from './errors.js';

/** WAVE format tag 常量 */
export const WAVE_FORMAT = Object.freeze({
  PCM: 0x0001,
  IEEE_FLOAT: 0x0003,
  ALAW: 0x0006,
  MULAW: 0x0007,
  EXTENSIBLE: 0xfffe, // 以 SubFormat GUID 携带真实格式
});

/** SubFormat GUID 前 2 字节 → 真实 format tag（KSDATAFORMAT_SUBTYPE_* 首字段） */
const GUID_TAG_MAP = Object.freeze({
  0x0001: WAVE_FORMAT.PCM,
  0x0003: WAVE_FORMAT.IEEE_FLOAT,
  0x0006: WAVE_FORMAT.ALAW,
  0x0007: WAVE_FORMAT.MULAW,
});

/** format tag + 位深 → 契约 §3 的规范 codec 字符串；未知返回 null */
export function waveCodecString(formatTag, bitsPerSample) {
  switch (formatTag) {
    case WAVE_FORMAT.PCM:
      if (bitsPerSample === 8) return 'pcm-u8';
      if (bitsPerSample === 16) return 'pcm-s16';
      if (bitsPerSample === 24) return 'pcm-s24';
      if (bitsPerSample === 32) return 'pcm-s32';
      return null;
    case WAVE_FORMAT.IEEE_FLOAT:
      return bitsPerSample === 32 ? 'pcm-f32' : null;
    default: return null;
  }
}

/**
 * @typedef {Object} WavFormatInfo
 * @property {number} formatTag       原始/解析后的格式码
 * @property {number} channels        声道数
 * @property {number} sampleRate      采样率 Hz
 * @property {number} byteRate        每秒字节数
 * @property {number} blockAlign      单帧对齐字节数
 * @property {number} bitsPerSample   位深
 * @property {number} [validBitsPerSample] 扩展头的有效位深
 * @property {number} [channelMask]   扩展头声道掩码
 * @property {boolean} extensible     是否 WAVE_FORMAT_EXTENSIBLE
 */

/**
 * @typedef {Object} WavInfo
 * @property {{offset:number, size:number}} [dataChunk]  data 子块位置与大小
 * @property {Record<string,string>} info                LIST/INFO 元数据（INAM/IART…）
 */

/**
 * 解析 WAV 头部与子块索引。只读元信息，不拷贝采样数据。
 * @param {Uint8Array} bytes 文件头部至少到 data 块为止的字节
 * @returns {{format:WavFormatInfo} & WavInfo & {
 *           codec:string, durationUs:number|null, totalDataBytes:number}}
 * @throws {PlayerError} PARSE_ERROR / NOT_SUPPORTED / SOURCE_ERROR
 */
export function parseWavHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.length < 12) throw parseError('文件过短，不足 RIFF 头（12 字节）');
  if (readFourCC(dv, 0) !== 'RIFF') throw parseError('缺少 RIFF 魔数，不是 WAV 文件');
  const riffSize = dv.getUint32(4, true);
  if (readFourCC(dv, 8) !== 'WAVE') throw parseError('RIFF 形式类型不是 WAVE');

  // 流式录制哨兵（评审严重4）：riffSize=0xFFFFFFFF 表示“长度未知”，
  // 以实际可得字节继续走子块遍历；其余谎报尺寸本就按实际长度容错。
  const streaming = riffSize === 0xFFFFFFFF;
  void streaming;

  /** @type {WavFormatInfo|null} */
  let format = null;
  /** @type {{offset:number,size:number}|undefined} */
  let dataChunk;
  /** @type {Record<string,string>} */
  const info = {};
  /** @type {Array<{id:string, offset:number, size:number}>} */
  const chunks = [];

  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = readFourCC(dv, pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (body + size > bytes.length) {
      // data 块被截断：以实际可得长度继续（流式/未下载完场景），其余块报错
      if (id === 'data') {
        chunks.push({ id, offset: body, size: bytes.length - body });
        dataChunk = { offset: body, size: bytes.length - body };
      } else {
        throw parseError(`子块 ${id} 越界：声明 ${size} 字节但仅剩 ${bytes.length - body}`);
      }
      break;
    }
    chunks.push({ id, offset: body, size });

    if (id === 'fmt ') format = parseFmtChunk(bytes, body, size);
    else if (id === 'data') dataChunk = { offset: body, size };
    else if (id === 'LIST') parseListInfo(bytes, body, size, info);

    pos = body + size + (size % 2); // RIFF 规定奇数长度补 1 字节
  }

  if (!format) throw parseError('缺少 fmt 子块，无法确定音频格式');
  if (!dataChunk) throw parseError('缺少 data 子块，无采样数据');

  const codec = waveCodecString(format.formatTag, format.bitsPerSample);
  if (!codec) {
    throw notSupported(
      `暂不支持的编码：format=0x${format.formatTag.toString(16)} / bits=${format.bitsPerSample}` +
      `（支持 pcm-u8/s16/s24/s32/f32）`,
      { formatTag: format.formatTag, bitsPerSample: format.bitsPerSample },
    );
  }

  const frames = Math.floor(dataChunk.size / Math.max(1, format.blockAlign));
  // byteRate=0（畸形头）→ 时长未知，避免 Infinity（评审建议）
  const durationUs = format.byteRate > 0 && frames > 0
    ? Math.round((dataChunk.size / format.byteRate) * 1e6)
    : null;

  return { format, dataChunk, chunks, info, codec, durationUs, totalDataBytes: dataChunk.size };
}

/** 解析 fmt 子块（16/18/40 字节布局） */
function parseFmtChunk(bytes, offset, size) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size < 16) throw parseError(`fmt 子块过短（${size} < 16 字节）`);
  let formatTag = dv.getUint16(offset, true);
  const channels = dv.getUint16(offset + 2, true);
  const sampleRate = dv.getUint32(offset + 4, true);
  const byteRate = dv.getUint32(offset + 8, true);
  const blockAlign = dv.getUint16(offset + 12, true);
  const bitsPerSample = dv.getUint16(offset + 14, true);

  /** @type {Partial<WavFormatInfo>} */
  const ext = {};
  let isExtensible = false;
  if (size >= 18) {
    const cbSize = dv.getUint16(offset + 16, true);
    if (formatTag === WAVE_FORMAT.EXTENSIBLE && size >= 40 && cbSize >= 22) {
      isExtensible = true;
      const validBits = dv.getUint16(offset + 18, true);
      const channelMask = dv.getUint32(offset + 20, true);
      // SubFormat GUID 前 2 字节即真实格式码，后 14 字节为固定模板
      const guidTag = dv.getUint16(offset + 24, true);
      const real = GUID_TAG_MAP[guidTag];
      if (real === undefined) {
        throw notSupported(`EXTENSIBLE SubFormat 0x${guidTag.toString(16)} 不受支持`);
      }
      formatTag = real;
      Object.assign(ext, { validBitsPerSample: validBits, channelMask });
    }
  }
  if (channels < 1 || channels > 64) throw parseError(`非法声道数 ${channels}`);
  if (sampleRate < 1 || sampleRate > 384000) throw parseError(`非法采样率 ${sampleRate}`);

  return /** @type {WavFormatInfo} */ ({
    formatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample,
    extensible: isExtensible, ...ext,
  });
}

/** 提取 LIST/INFO 元数据（INAM 标题、IART 艺术家、ICRD 日期…） */
function parseListInfo(bytes, offset, size, out) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (readFourCC(dv, offset) !== 'INFO') return;
    let p = offset + 4;
    const end = offset + size;
    while (p + 8 <= end) {
      const key = readFourCC(dv, p);
      const len = dv.getUint32(p + 4, true);
      const start = p + 8;
      if (start + len > end) break;
      out[key] = new TextDecoder().decode(bytes.subarray(start, start + len)).replace(/\0+$/, '');
      p = start + len + (len % 2);
    }
  } catch {
    /* INFO 结构损坏不影响主流程：静默忽略（可恢复异常） */
  }
}

/** 读 4 字节 ASCII 标识 */
export function readFourCC(dv, offset) {
  return String.fromCharCode(
    dv.getUint8(offset), dv.getUint8(offset + 1),
    dv.getUint8(offset + 2), dv.getUint8(offset + 3),
  );
}
