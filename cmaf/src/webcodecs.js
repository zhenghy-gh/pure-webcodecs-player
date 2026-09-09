/**
 * webcodecs.js —— CMAF → WebCodecs 直解路线
 *
 * 职责（契约 §6：cmaf.js WebCodecs 首选、LL 方向）：
 *  1. 从 init segment 推导 VideoDecoderConfig / AudioDecoderConfig
 *     （codec 串 + description，与 WebCodecs 配置项同名）；
 *  2. 提供 CmafWebCodecsPlayer：逐 chunk 喂样本 → VideoDecoder/AudioDecoder
 *     → frame 回调（渲染归 core 的 VideoFrameRenderer，本层不碰画布）。
 *
 * Node 环境：hasWebCodecs 恒 false，构造器抛 NOT_SUPPORTED——按契约 §0.3
 * "Node 下返回不支持，不允许未捕获异常"。
 */

import { hasWebCodecs } from '../../core/src/capabilities.js';
import { notSupported } from '../../core/src/errors.js';
import { parseInitSegment } from './chunk-parser.js';

/**
 * 由 avcC 前 3 字节生成 avc1.PPCCLL（契约 §3：参数取 SPS 或 avcC 前 3 字节）。
 * @param {Uint8Array} avcC
 */
export function codecStringFromAvcC(avcC) {
  // 契约 §3：禁止编造 profile——无法推导时返回 null，由调用方跳过该轨配置
  if (!avcC || avcC.length < 4) return null;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/** ASC 高 5 位 = AOT → mp4a.40.<AOT> */
export function codecStringFromAsc(asc) {
  const aot = asc && asc.length ? (asc[0] >> 3) & 0x1f : 2;
  return `mp4a.40.${aot}`;
}

/**
 * 从 CMAF init segment 推导解码配置。
 * @param {Uint8Array} initBytes
 * @returns {{video:VideoDecoderConfig|null, audio:AudioDecoderConfig|null,
 *            videoTrack:{timescale:number}|null, audioTrack:{timescale:number}|null}}
 */
export function decoderConfigsFromInit(initBytes) {
  const info = parseInitSegment(initBytes);
  /** @type {any} */
  let video = null;
  if (info.video) {
    video = {
      codec: codecStringFromAvcC(info.video.description),
      description: info.video.description || undefined,
      optimizeForLatency: true, // LL 方向：能解一帧是一帧
    };
  }
  /** @type {any} */
  let audio = null;
  if (info.audio) {
    audio = {
      codec: codecStringFromAsc(info.audio.asc),
      description: info.audio.asc, // AudioSpecificConfig 即 AAC 的 description
      sampleRate: guessSampleRateFromAsc(info.audio.asc),
      numberOfChannels: guessChannelsFromAsc(info.audio.asc),
    };
  }
  return {
    video,
    audio,
    videoTrack: info.video ? { timescale: info.video.timescale } : null,
    audioTrack: info.audio ? { timescale: info.audio.timescale } : null,
  };
}

/** ASC 采样率索引表（AAC） */
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];
function guessSampleRateFromAsc(asc) {
  if (!asc || asc.length < 2) return 48000;
  const idx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  return AAC_SAMPLE_RATES[idx] ?? 48000;
}
function guessChannelsFromAsc(asc) {
  if (!asc || asc.length < 2) return 2;
  return (asc[1] >> 3) & 0x0f || 2;
}

/**
 * CMAF WebCodecs 直解播放器骨架。
 *
 * 用法：
 *   const p = new CmafWebCodecsPlayer({ onVideoFrame(frame){...}, onAudioData(ad){...} })
 *   await p.open(initSegmentBytes)
 *   await p.appendChunk(chunkBytes)   // styp+moof+mdat
 *   await p.close()
 */
export class CmafWebCodecsPlayer {
  constructor({ onVideoFrame, onAudioData, onError } = {}) {
    if (!hasWebCodecs()) {
      throw notSupported('当前环境不支持 WebCodecs（VideoDecoder/AudioDecoder）');
    }
    this.onVideoFrame = onVideoFrame || (() => {});
    this.onAudioData = onAudioData || (() => {});
    this.onError = onError || (() => {});
    /** @type {VideoDecoder|null} */ this.videoDecoder = null;
    /** @type {AudioDecoder|null} */ this.audioDecoder = null;
    this.videoTimescale = 90000;
    this.audioTimescale = 48000;
    this._pending = [];
  }

  /** 解析 init segment 并建立解码器 */
  async open(initBytes) {
    const cfg = decoderConfigsFromInit(initBytes);
    if (cfg.video) {
      this.videoTimescale = cfg.videoTrack.timescale;
      const support = await window.VideoDecoder.isConfigSupported(cfg.video);
      if (!support.supported) {
        throw notSupported(`浏览器不支持该视频配置: ${cfg.video.codec}`);
      }
      this.videoDecoder = new window.VideoDecoder({
        output: (frame) => this.onVideoFrame(frame),
        error: (e) => this.onError(e),
      });
      this.videoDecoder.configure(cfg.video);
    }
    if (cfg.audio) {
      this.audioTimescale = cfg.audioTrack.timescale;
      this.audioDecoder = new window.AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (e) => this.onError(e),
      });
      this.audioDecoder.configure(cfg.audio);
    }
    return cfg;
  }

  /**
   * 喂入一个 chunk（styp+moof+mdat）。样本数据直接从 mdat 切片，
   * AVCC 形态原样交 VideoDecoder（description 已在 configure 时传入）。
   * @param {{tracks:Array<{trackId:number,samples:Array<{durationTicks,size,keyframe,dtsOffset,dataStart}>}>}} chunk splitChunks() 的产物
   * @param {Uint8Array} buf chunk 所在的完整缓冲
   */
  appendChunk(chunk, buf) {
    for (const track of chunk.tracks) {
      const isVideo = !!this.videoDecoder && track.trackId === 1;
      const decoder = isVideo ? this.videoDecoder : this.audioDecoder;
      if (!decoder) continue;
      const ts = isVideo ? this.videoTimescale : this.audioTimescale;
      for (const s of track.samples) {
        const data = buf.subarray(s.dataStart, s.dataStart + s.size);
        try {
          decoder.decode(new window.EncodedVideoChunk({
            type: s.keyframe ? 'key' : 'delta',
            timestamp: Math.round((s.dtsOffset / ts) * 1e6), // 契约：边界 µs
            duration: Math.round((s.durationTicks / ts) * 1e6),
            data,
          }));
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }

  /** 等待全部队列解码完成并释放 */
  async close() {
    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') {
        await this.videoDecoder.flush();
        this.videoDecoder.close();
      }
      if (this.audioDecoder && this.audioDecoder.state !== 'closed') {
        await this.audioDecoder.flush();
        this.audioDecoder.close();
      }
    } finally {
      this.videoDecoder = null;
      this.audioDecoder = null;
    }
  }
}
