/**
 * aac.js —— AAC 相关封装：ADTS 头解析、LATM(AudioSyncStream) 解析、
 * AudioSpecificConfig 构造/解析
 *
 * TS 里 AAC 有两种封装（stream_type）：
 *  - ADTS（0x0F）：每帧自带 7 字节头（含 CRC 时为 9），最常见；
 *  - LATM（0x11）：AudioSyncStream(LOAS)，配置信息内嵌于流中。
 *
 * 支持范围（README 中有更详细说明）：
 *  - ADTS 全量（MPEG-2/4、有无 CRC）；
 *  - LATM 仅支持常见形态：audioMuxVersion=0、frameLengthType=0 的
 *    AudioSyncStream；ASC 采用“StreamMuxConfig 之后紧跟”的排布，
 *    并做有界防御性扫描。复杂 LATM 配置返回 null 由上层降级跳过。
 */

import { BitReader, BitWriter } from './bits.js';

/** MPEG-4 音频采样率表（索引 0~12；13/14 保留，15=自定义） */
export const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];

const ADTS_PROFILE_TO_AOT = [1, 2, 3, 4]; // Main / LC / SSR / LTP

/**
 * 解析 ADTS 头。
 * @param {Uint8Array} bytes 以 syncword 起始的数据
 * @returns {{ samplingRate:number, sampleRateIndex:number, channels:number,
 *             frameLength:number, headerSize:number, aot:number }|null}
 */
export function parseAdtsHeader(bytes) {
  if (!bytes || bytes.length < 7) return null;
  const r = new BitReader(bytes);
  if (r.readBits(12) !== 0xfff) return null;   // syncword
  const mpegVersion = r.readBits(1);           // 0=MPEG-4, 1=MPEG-2
  if (r.readBits(2) !== 0) return null;        // layer 必须为 0
  const protectionAbsent = r.readFlag();
  const adtsProfile = r.readBits(2);
  const sampleRateIndex = r.readBits(4);
  r.readFlag();                                // private_bit
  const channelConfig = r.readBits(3);
  r.readBits(4);                               // original/copy + home + 两个版权位
  const frameLength = r.readBits(13);          // 含头的整帧长度
  r.readBits(11);                              // buffer_fullness
  r.readBits(2);                               // num_raw_data_blocks-1

  if (sampleRateIndex >= AAC_SAMPLE_RATES.length || channelConfig === 0) return null;
  void mpegVersion;
  return {
    samplingRate: AAC_SAMPLE_RATES[sampleRateIndex],
    sampleRateIndex,
    channels: channelConfig,
    frameLength,
    headerSize: protectionAbsent ? 7 : 9,
    aot: ADTS_PROFILE_TO_AOT[adtsProfile] ?? 2,
  };
}

/** 从一段连续数据里按 ADTS 帧长切分所有完整帧，返回 [{header, rawPayload}] */
export function splitAdtsFrames(data) {
  const frames = [];
  let pos = 0;
  while (pos + 7 <= data.length) {
    // 找 syncword
    while (pos < data.length - 1 && !(data[pos] === 0xff && (data[pos + 1] & 0xf6) === 0xf0)) {
      pos++;
    }
    if (pos + 7 > data.length) break;
    const header = parseAdtsHeader(data.subarray(pos));
    if (!header || header.frameLength < header.headerSize) {
      pos++;   // 假同步码，继续找
      continue;
    }
    if (pos + header.frameLength > data.length) break; // 最后半帧留给上层补数据
    frames.push({
      header,
      raw: data.slice(pos + header.headerSize, pos + header.frameLength),
    });
    pos += header.frameLength;
  }
  return frames;
}

/**
 * 构造 AudioSpecificConfig。
 * @param {number} aot Audio Object Type（1=Main 2=LC ...）
 * @param {number} sampleRateIndex 采样率索引（0~14）；15 表示自定义
 * @param {number} channels 声道数（1~7）
 * @param {number} [freq] 自定义采样率（sampleRateIndex===15 时必填）
 */
export function buildAudioSpecificConfig(aot, sampleRateIndex, channels, freq = 0) {
  const w = new BitWriter();
  w.writeBits(aot & 0x1f, 5);
  w.writeBits(sampleRateIndex & 0x0f, 4);
  if ((sampleRateIndex & 0x0f) === 0x0f) {
    if (!freq) throw new Error('buildAudioSpecificConfig: 自定义采样率必须提供 freq');
    w.writeBits(freq, 24);
  }
  w.writeBits(channels & 0x07 ? channels : 1, 4);
  return w.finish();
}

/**
 * 解析 AudioSpecificConfig。
 * @returns {{ aot:number, sampleRate:number, sampleRateIndex:number, channels:number }}
 */
export function parseAudioSpecificConfig(asc) {
  const r = new BitReader(asc);
  let aot = r.readBits(5);
  if (aot === 31) aot = 32 + r.readBits(6);      // 扩展 AOT
  const idx = r.readBits(4);
  const rate = idx === 0x0f ? r.readBits(24) : AAC_SAMPLE_RATES[idx];
  let channels = r.readBits(4);
  if (channels === 0) channels = 2;              // PCE 引导：保守返回双声道
  return { aot, sampleRate: rate, sampleRateIndex: idx, channels };
}

/**
 * 从一段可能包含多个 AudioSyncStream 的负载中拆出全部单元并解析。
 * @param {Uint8Array} data PES 负载
 * @returns {Array<{ asc:Uint8Array|null, payload:Uint8Array|null }>}
 */
export function splitLatmUnits(data) {
  const units = [];
  let pos = 0;
  while (pos + 3 <= data.length) {
    // AudioSyncStream 特征：byte0=0x56（syncword 高位），byte1 高 3 位为 '111'
    if (data[pos] === 0x56 && (data[pos + 1] & 0xe0) === 0xe0) {
      const declaredLen = ((data[pos + 1] & 0x1f) << 8) | data[pos + 2];
      const unitLen = 3 + declaredLen;
      if (unitLen > data.length - pos || declaredLen === 0) {
        pos++;
        continue;
      }
      const parsed = parseLatmSyncStream(data.subarray(pos, pos + unitLen));
      units.push(parsed);
      pos += unitLen;
    } else {
      pos++;
    }
  }
  return units;
}

/**
 * 从一个 LATM AudioSyncStream 单元提取原始 AAC 帧。
 * @param {Uint8Array} chunk 一个完整的 AudioSyncStream（syncword 起）
 * @returns {{ asc:Uint8Array|null, payload:Uint8Array|null }}
 *   asc 仅在首次携带配置时非空；payload 为裸 AAC 帧。
 */
export function parseLatmSyncStream(chunk) {
  try {
    const r = new BitReader(chunk);
    if (r.readBits(11) !== 0x2b7) return { asc: null, payload: null }; // syncword
    r.readBits(13);                       // audioMuxLengthBytes
    const useSameStreamMux = r.readFlag();
    let asc = null;

    if (!useSameStreamMux) {
      if (r.readFlag() !== 0) return { asc: null, payload: null }; // audioMuxVersion 必须 0
      r.readFlag();                 // allStreamsSameTimeFraming
      r.readBits(6);                // numSubFrames
      const numPrograms = r.readBits(4);
      for (let p = 0; p <= numPrograms; p++) {
        const numLayers = r.readBits(3);
        for (let l = 0; l <= numLayers; l++) {
          if (p === 0 && l === 0) {
            asc = tryReadAscBounded(chunk, r.pos, r.bit);
            if (asc) advance(r, 16);            // 消耗掉 2 字节 ASC
            else throw new Error('LATM: 未定位到合法 ASC');
          }
          const frameLengthType = r.readBits(3);
          if (frameLengthType !== 0) return { asc: null, payload: null };
          r.readBits(6);                        // slotLengthList[i]
        }
      }
    }

    // PayloadLengthInfo：MuxSlotLengthBytes 按 255 转义累加
    let slotBytes = 0;
    let tmp = 0;
    do {
      tmp = r.readBits(8);
      slotBytes += tmp;
    } while (tmp === 255);

    r.alignByte();
    if (slotBytes <= 0 || r.pos + slotBytes > chunk.length) {
      return { asc, payload: null };
    }
    return { asc, payload: chunk.slice(r.pos, r.pos + slotBytes) };
  } catch {
    return { asc: null, payload: null };
  }
}

/**
 * 从 chunk 的指定位位置开始，在 ±24 位窗口内有界扫描一段合法 ASC。
 *
 * 修复 round-1 第九波「LATM ASC 启发式错位」：旧实现仅靠宽松字段范围判断
 * （aot∈[1,6]/idx≤15/ch∈[1,7]），会把音频数据里的巧合比特误锁为 ASC，且对
 * sampling_frequency_index=13/14（保留值）、=15（escape，需额外 24 位频率）错位——
 * idx=15 时返回 2 字节 ASC，但 parseAudioSpecificConfig 还要再读 24 位频率，越界/产错采样率。
 * 新实现拼出候选 ASC 后交给 parseAudioSpecificConfig 真校验；保留值 13/14 直接拒；
 * =15 因 2 字节窗口不足以承载 24 位频率，parse 越界抛错被 catch（复杂 LATM 走降级，
 * 符合本模块「仅支持常见形态」的声明范围）。优先校验精确位 delta=0，再退化扫描。
 */
function tryReadAscBounded(chunk, startPos, startBit) {
  const baseBitPos = startPos * 8 + startBit;
  for (let delta = 0; delta < 24; delta++) {
    const p = baseBitPos + delta;
    const byteA = bitRange(chunk, p, 8);
    const byteB = bitRange(chunk, p + 8, 8);
    if (byteA == null || byteB == null) break;
    const idx = ((byteA & 0x07) << 1) | (byteB >> 7);
    // 保留采样率索引 13/14 永不合法；15 需 24 位频率超出 2 字节窗口（走降级），均跳过
    if (idx === 13 || idx === 14 || idx === 15) continue;
    const candidate = Uint8Array.from([byteA, byteB]);
    try {
      const asc = parseAudioSpecificConfig(candidate);
      // idx 0..12 均映射到 AAC_SAMPLE_RATES 中的确定值；声道 1..7 合法
      if (asc.sampleRate == null || asc.channels < 1 || asc.channels > 7) continue;
      return candidate;
    } catch {
      continue; // 巧合模式或越界 → 继续下一 delta
    }
  }
  return null;
}

function bitRange(bytes, bitOffset, count) {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const p = bitOffset + i;
    if (p >= bytes.length * 8) return null;
    value = (value << 1) | ((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return value;
}

function advance(r, bits) {
  for (let i = 0; i < bits; i++) r.readBits(1);
}
