/**
 * codecs.js —— Matroska CodecID → 规范 codec 串（契约 §3）与 CodecPrivate 结构解析
 *
 * 契约要点：
 *   - codec 串构造收敛 core/src/codec-string.js，本模块【禁止自行拼串】；
 *     仅在容器拿不到参数集时降级为基础家族串并打 warn（不编造 profile）。
 *   - description 字段名定稿见 CONTRACTS §1.2（codecPrivate 为过渡别名）。
 *
 * 本文件额外负责解析各 codec 的私有初始化结构，供轨道参数补全：
 *   AVCC / HEVCDCR / AudioSpecificConfig / OpusHead / FLAC STREAMINFO
 */

import {
  buildAvcCodecString, buildHevcCodecString, aacCodecString,
} from '../../core/src/codec-string.js';

/** Matroska 官方 CodecID 一览（含暂不支持解码、仅识别透传的家族） */
export const CODEC_TABLE = {
  // ── 视频 ────────────────────────────────────────────────
  'V_MPEG4/ISO/AVC': { family: 'h264', kind: 'video', supported: true },
  'V_MPEGH/ISO/HEVC': { family: 'hevc', kind: 'video', supported: true },
  'V_VP9': { family: 'vp9', kind: 'video', supported: true },
  'V_AV1': { family: 'av1', kind: 'video', supported: true },
  'V_VP8': { family: 'vp8', kind: 'video', supported: true },
  'V_MPEG1': { family: 'mpeg1', kind: 'video', supported: false },
  'V_MPEG2': { family: 'mpeg2', kind: 'video', supported: false },
  'V_PRORES': { family: 'prores', kind: 'video', supported: false },
  // ── 音频 ────────────────────────────────────────────────
  'A_AAC': { family: 'aac', kind: 'audio', supported: true },
  'A_OPUS': { family: 'opus', kind: 'audio', supported: true },
  'A_FLAC': { family: 'flac', kind: 'audio', supported: true },
  'A_MPEG/L3': { family: 'mp3', kind: 'audio', supported: true },
  'A_MPEG/L2': { family: 'mp2', kind: 'audio', supported: false },
  'A_EAC3': { family: 'eac3', kind: 'audio', supported: false },
  'A_AC3': { family: 'ac3', kind: 'audio', supported: false },
  'A_DTS': { family: 'dts', kind: 'audio', supported: false },
  'A_TRUEHD': { family: 'truehd', kind: 'audio', supported: false },
  'A_VORBIS': { family: 'vorbis', kind: 'audio', supported: true },
  'A_PCM/INT/LIT': { family: 'pcm', kind: 'audio', supported: true },
  'A_PCM/INT/BIG': { family: 'pcm', kind: 'audio', supported: true },
  'A_PCM/FLOAT/IEEE': { family: 'pcm', kind: 'audio', supported: true },
  // ── 字幕（文本轨透传；codec 走 subtitle 模块内容族）──────
  'S_TEXT/UTF8': { family: 'subrip', kind: 'text', supported: true, codec: 'x-srt' },
  'S_TEXT/ASCII': { family: 'subrip-ascii', kind: 'text', supported: true, codec: 'x-srt' },
  'S_TEXT/WEBVTT': { family: 'webvtt', kind: 'text', supported: true, codec: 'x-vtt' },
  'S_ASS': { family: 'ass', kind: 'text', supported: true, codec: 'x-ass' },
  'S_SSA': { family: 'ssa', kind: 'text', supported: true, codec: 'x-ass' },
};

let warnedMissingParams = new Set();
function warnOnce(family, msg) {
  if (warnedMissingParams.has(family)) return;
  warnedMissingParams.add(family);
  console.warn(`[mkv/codecs] ${msg}`);
}

/**
 * AVCDecoderConfigurationRecord(AVCC) → 经 core 构造 'avc1.PPCCLL'；
 * 无私有数据时按「不编造 profile」原则降级基础串（AnnexB 文件形态）。
 */
export function avccToCodecString(priv) {
  const s = priv && priv.length >= 4 ? buildAvcCodecString(priv, 'avc1') : '';
  return s || 'avc1';
}

/** HEVC：hevC 存在走 core 构造（Matroska 惯例 sample entry 为 hev1），否则基础串 */
export function hevcToCodecString(priv) {
  const s = priv && priv.length >= 23 ? buildHevcCodecString(priv, 'hev1') : '';
  return s || 'hev1';
}

/** AAC AudioSpecificConfig 解析：AOT / 采样率 / 声道 */
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];
export function parseAacAsc(priv) {
  if (!priv || priv.length < 2) {
    warnOnce('aac', '缺少 AudioSpecificConfig，按 LC(AOT=2) 兜底');
    return { aot: 2, sampleRate: null, channels: null };
  }
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = priv[(bitPos + i) >> 3];
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += n;
    return v;
  };
  let aot = readBits(5);
  if (aot === 31) aot = 32 + readBits(6);
  const sfi = readBits(4);
  const sampleRate = sfi === 15 ? readBits(24) : (AAC_RATES[sfi] ?? null);
  const channels = readBits(4);
  return { aot, sampleRate, channels };
}

/** OpusHead → { version, channels, preSkip, inputSampleRate, outputGain, mappingFamily } */
export function parseOpusHead(priv) {
  if (!priv || priv.length < 19 || new TextDecoder().decode(priv.subarray(0, 8)) !== 'OpusHead') {
    return null;
  }
  const view = new DataView(priv.buffer, priv.byteOffset, priv.byteLength);
  return {
    version: priv[8],
    channels: priv[9],
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
    mappingFamily: priv[18],
  };
}

/** FLAC CodecPrivate（"fLaC"+块头+STREAMINFO 或裸 STREAMINFO）→ 参数集 */
export function parseFlacStreaminfo(priv) {
  if (!priv) return null;
  const isFlacMagic = priv.length >= 4
    && priv[0] === 0x66 && priv[1] === 0x4c && priv[2] === 0x61 && priv[3] === 0x43;
  if (!isFlacMagic) {
    if (priv.length < 34) return null;
    return readStreaminfo(priv.subarray(0)); // 允许直接是 STREAMINFO(34B)
  }
  if (priv.length < 42) return null;
  return readStreaminfo(priv.subarray(8)); // "fLaC"(4) + block header(4)
}
function readStreaminfo(b) {
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  const channels = ((b[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
  const hi = ((b[13] & 0x0f) * 256 + b[14]) * 256 + b[15];
  const lo = (b[16] << 24) >>> 0;
  const totalSamples = hi * 2 ** 32 + lo;
  return { sampleRate, channels, bitsPerSample, totalSamples };
}

/**
 * 轨道编解码归一化入口。
 * @param {{codecId:string, codecPrivate?:Uint8Array|null}} t
 * @param {{sampleRate?:number|null, channels?:number|null, bitDepth?:number|null}} av
 * @returns {{codec:string, family:string, kind:'video'|'audio'|'text'|'metadata'|'unknown',
 *            supported:boolean, extra:Object, bitstreamFormat?:'avc'|'annexb'}}
 */
export function normalizeCodec(t, av = {}) {
  const entry = CODEC_TABLE[t.codecId]
    ?? { family: t.codecId.toLowerCase(), kind: guessKindFromCodecId(t.codecId), supported: false };
  const out = {
    codec: entry.codec ?? t.codecId, // 字幕等已定映射直接用；其余兜底原样，下方按族覆盖
    family: entry.family,
    kind: entry.kind,
    supported: !!entry.supported,
    extra: {},
  };
  const priv = t.codecPrivate ?? null;

  switch (entry.family) {
    case 'h264':
      out.codec = avccToCodecString(priv);
      out.bitstreamFormat = priv ? 'avc' : 'annexb'; // 契约 §1.2 视频专用字段
      break;
    case 'hevc':
      out.codec = hevcToCodecString(priv);
      out.bitstreamFormat = priv ? 'avc' : 'annexb'; // HVCC 同为长度前缀形态
      break;
    case 'vp9': {
      // Matroska 不强制携带 VP9 参数；无私有数据时降级基础串（不编造 profile）
      out.codec = 'vp09';
      if (!priv) warnOnce('vp9', '无 vpcC 私有数据，codec 降级为 vp09 基础串');
      break;
    }
    case 'vp8':
      out.codec = 'vp8';
      break;
    case 'av1':
      out.codec = 'av01'; // 精确串需 Sequence Header OBU，Phase 后置
      break;
    case 'aac': {
      const asc = parseAacAsc(priv);
      out.codec = aacCodecString(asc.aot); // core 收口构造 mp4a.40.x
      out.extra.aot = asc.aot;
      out.extra.sampleRate = asc.sampleRate ?? av.sampleRate ?? null;
      out.extra.channels = asc.channels ?? av.channels ?? null;
      break;
    }
    case 'opus': {
      out.codec = 'opus';
      const oh = parseOpusHead(priv);
      if (oh) {
        out.extra.preSkip = oh.preSkip;
        out.extra.channels = oh.channels || av.channels || null;
        out.extra.inputSampleRate = oh.inputSampleRate;
      }
      break;
    }
    case 'flac': {
      out.codec = 'flac';
      const si = parseFlacStreaminfo(priv);
      if (si) Object.assign(out.extra, si);
      break;
    }
    case 'pcm': {
      // 契约 §3 PCM 家族按采样位深映射（A_PCM/INT/LIT 为小端；FLOAT 固定 f32）
      if (t.codecId === 'A_PCM/FLOAT/IEEE') out.codec = 'pcm-f32';
      else if (t.codecId === 'A_PCM/INT/BIG') out.codec = av.bitDepth === 16 ? 'pcm-s16be' : 'pcm-s16';
      else {
        const depth = av.bitDepth ?? 16;
        out.codec = { 8: 'pcm-u8', 16: 'pcm-s16', 24: 'pcm-s24', 32: 'pcm-s32' }[depth] ?? 'pcm-s16';
      }
      break;
    }
    case 'mp3':
      // A_MPEG/L3 → MSE 合法 codec 串 'mp3'（原生 Matroska CodecID 不可用于 addSourceBuffer）
      out.codec = 'mp3';
      break;
    case 'vorbis': {
      // A_VORBIS → MSE 合法 codec 串 'vorbis'（原生 CodecID 同上不可用）
      out.codec = 'vorbis';
      // Vorbis 须 CodecPrivate(identification/comment/setup 头) 才能初始化解码器；缺省仅告警不编造
      if (!priv) warnOnce('vorbis', 'Vorbis 缺少 CodecPrivate，解码器可能无法初始化');
      break;
    }
    default:
      break;
  }
  return out;
}

function guessKindFromCodecId(codecId) {
  if (codecId.startsWith('V_')) return 'video';
  if (codecId.startsWith('A_')) return 'audio';
  if (codecId.startsWith('S_')) return 'text';
  return 'unknown';
}
