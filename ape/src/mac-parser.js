/**
 * ape/src/mac-parser.js — Monkey's Audio 容器头解析（MAC_DESCRIPTOR / MAC_HEADER）
 * ------------------------------------------------------------
 * 版本 ≥ 3980：'MAC '(4) + version(2) + APE_DESCRIPTOR(52B) + MAC_HEADER(24B)
 *   DESCRIPTOR（52B）：
 *     cID(4)='MAC ' version(2) padding(2)
 *     nDescriptorBytes(4)@8  nHeaderBytes(4)@12  nSeekTableBytes(4)@16
 *     nHeaderDataBytes(4)@20 nAPEFrameDataBytes(4)@24 nAPEFrameDataBytesHigh(4)@28
 *     nTerminatingDataBytes(4)@32  cFileMD5[16]@36
 *   HEADER（24B）@nDescriptorBytes：compression(2) formatFlags(2) blocksPerFrame(4)
 *                  finalFrameBlocks(4) totalFrames(4) bps(2) channels(2) sampleRate(4)
 *   音频起始 = nDescriptorBytes + nHeaderBytes + nSeekTableBytes + nHeaderDataBytes
 * 版本 < 3980：旧式 30B 头，无 bps/总帧数字段（帧数需到文件尾推算）。
 *
 * 本模块只做**容器与元数据解析**；解码器复杂度路线见 README（ARCHITECTURE Phase 3 结论）。
 */
import { parseError } from './errors.js';

/** 压缩级别码 → 名称（best-effort 映射，跨版本存在别名） */
export const COMPRESSION_LEVEL = Object.freeze({
  3000: 'insane', 3001: 'braindead',
  4000: 'fast', 4001: 'normal', 4002: 'high', 4003: 'extra-high',
});

/** formatFlags 位含义（spec 公开资料整理） */
export function describeFormatFlags(flags) {
  return {
    hasSeekTableFirst: !!(flags & 0x01),
    noWaveHeader: !(flags & 0x02),
    crc32PerFrame: !!(flags & 0x04),
    highBitDepth24: !!(flags & 0x08),
    hasPeakLevel: !!(flags & 0x10),
  };
}

/**
 * @typedef {Object} ApeInfo
 * @property {number} version            文件版本号（如 3990）
 * @property {'descriptor'|'legacy'} kind 头部形态
 * @property {string} compressionLevel   压缩级别名（未知给原始码）
 * @property {number} compressionCode
 * @property {{hasSeekTableFirst:boolean,noWaveHeader:boolean,crc32PerFrame:boolean,
 *             highBitDepth24:boolean,hasPeakLevel:boolean}} formatFlags
 * @property {number} blocksPerFrame     legacy 按版本推导
 * @property {number|null} finalFrameBlocks
 * @property {number|null} totalFrames
 * @property {number} bitsPerSample      legacy 固定 16
 * @property {number} channels
 * @property {number} sampleRate
 * @property {number|null} durationUs    总样本数可得时给出（µs）
 * @property {number} audioOffset        音频数据起始字节
 */

/**
 * 解析 MAC 容器头。
 * @param {Uint8Array} bytes 文件头部字节（≥ 64B 建议）
 * @returns {ApeInfo}
 */
export function parseMacHeader(bytes) {
  if (bytes.length < 8) throw parseError('文件过短，不足 MAC 头');
  if (!(bytes[0] === 0x4d && bytes[1] === 0x41 && bytes[2] === 0x43 && bytes[3] === 0x20)) {
    throw parseError('缺少 "MAC " 魔数，不是 Monkey\'s Audio 文件');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);

  if (version >= 3980) {
    if (bytes.length < 12) throw parseError('APE 文件过短，无法读取描述符长度');
    const descriptorLen = dv.getUint32(8, true);  // nDescriptorBytes
    // 主流实现（ffmpeg 等）约定：描述符必须 ≥ 52 字节，过短视为损坏
    if (descriptorLen < 52) throw parseError(`APE_DESCRIPTOR 长度 ${descriptorLen} 非法（需 ≥ 52）`);
    if (bytes.length < descriptorLen + 24) throw parseError('APE_DESCRIPTOR/HEADER 不完整');
    const headerLen = dv.getUint32(12, true);     // nHeaderBytes
    const seekTableLen = dv.getUint32(16, true);  // nSeekTableBytes
    const headerDataLen = dv.getUint32(20, true); // nHeaderDataBytes
    // 描述符后紧跟 24 字节头部；描述符可 >52B（含附加字段），按实际长度跳过
    let p = descriptorLen;
    const compressionCode = dv.getUint16(p, true); p += 2;
    const flags = dv.getUint16(p, true); p += 2;
    const blocksPerFrame = dv.getUint32(p, true); p += 4;
    const finalFrameBlocks = dv.getUint32(p, true); p += 4;
    const totalFrames = dv.getUint32(p, true); p += 4;
    const bitsPerSample = dv.getUint16(p, true); p += 2;
    const channels = dv.getUint16(p, true); p += 2;
    const sampleRate = dv.getUint32(p, true); p += 4;

    validate({ channels, sampleRate, blocksPerFrame, totalFrames });
    const totalSamples = (totalFrames - 1) * blocksPerFrame + finalFrameBlocks;
    // 音频起始 = 描述符 + 头部 + seek 表 + 头部数据（与 ffmpeg 一致）
    const audioOffset = descriptorLen + headerLen + seekTableLen + headerDataLen;
    return {
      version,
      kind: 'descriptor',
      compressionCode,
      compressionLevel: COMPRESSION_LEVEL[compressionCode] || `code-${compressionCode}`,
      formatFlags: describeFormatFlags(flags),
      blocksPerFrame,
      finalFrameBlocks,
      totalFrames,
      bitsPerSample,
      channels,
      sampleRate,
      durationUs: Math.round((totalSamples / sampleRate) * 1e6),
      audioOffset,
    };
  }

  // ---- legacy：< 3980 ----
  if (bytes.length < 14) throw parseError('legacy MAC 头不完整');
  let p = 6;
  const compressionCode = dv.getUint16(p, true); p += 2;
  const flags = dv.getUint16(p, true); p += 2;
  const channels = dv.getUint16(p, true); p += 2;
  const sampleRate = dv.getUint32(p, true); p += 4;
  // 块大小按公开资料随版本推导；总帧数不可知 → null
  const blocksPerFrame = version >= 3900 ? 73728 * (2 ** (compressionCode - 4000)) : 9216;
  validate({ channels, sampleRate, blocksPerFrame, totalFrames: null });

  return {
    version,
    kind: 'legacy',
    compressionCode,
    compressionLevel: COMPRESSION_LEVEL[compressionCode] || `code-${compressionCode}`,
    formatFlags: describeFormatFlags(flags),
    blocksPerFrame,
    finalFrameBlocks: null,
    totalFrames: null,
    bitsPerSample: 16, // 该年代文件基本为 16bit，如实标注为推断值
    channels,
    sampleRate,
    durationUs: null,
    audioOffset: 14,
  };
}

function validate(o) {
  if (o.channels < 1 || o.channels > 8) throw parseError(`非法声道数 ${o.channels}`);
  if (o.sampleRate < 1000 || o.sampleRate > 384000) throw parseError(`非法采样率 ${o.sampleRate}`);
  if (o.totalFrames !== null && o.totalFrames < 1) throw parseError(`非法总帧数 ${o.totalFrames}`);
}
