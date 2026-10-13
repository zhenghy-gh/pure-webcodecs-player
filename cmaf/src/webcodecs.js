/**
 * webcodecs.js —— CMAF → WebCodecs 直解路线
 *
 * 职责（契约 §6：cmaf.js WebCodecs 首选、LL 方向）：
 *  1. 从 init segment 推导 VideoDecoderConfig / AudioDecoderConfig
 *     （codec 串 + description，与 WebCodecs 配置项同名）；
 *  2. 提供 CmafWebCodecsPlayer：逐 chunk 喂样本 → VideoDecoder/AudioDecoder
 *     → frame 回调（渲染归 core 的 VideoFrameRenderer，本层不碰画布）。
 *
 * 构造器不要求全套音视频 API；open(init) 根据实际轨道分别校验 decoder 与 Encoded*Chunk。
 * 因此单轨媒体只依赖该轨道的 WebCodecs API，Node 下打开缺失对应 API 的轨仍返回 NOT_SUPPORTED。
 */

import { notSupported } from '../../core/src/errors.js';
import { parseInitSegment } from './chunk-parser.js';

function hasVideoWebCodecs() {
  try {
    return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
  } catch {
    return false;
  }
}

function hasAudioWebCodecs() {
  try {
    return typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function';
  } catch {
    return false;
  }
}

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
 *            videoTrack:{trackId:number|null,timescale:number}|null,
 *            audioTrack:{trackId:number|null,timescale:number}|null}}
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
    videoTrack: info.video ? { trackId: info.video.trackId, timescale: info.video.timescale } : null,
    audioTrack: info.audio ? { trackId: info.audio.trackId, timescale: info.audio.timescale } : null,
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
    this.onVideoFrame = onVideoFrame || (() => {});
    this.onAudioData = onAudioData || (() => {});
    this.onError = onError || (() => {});
    /** @type {VideoDecoder|null} */ this.videoDecoder = null;
    /** @type {AudioDecoder|null} */ this.audioDecoder = null;
    this.videoTimescale = 90000;
    this.audioTimescale = 48000;
    this.videoTrackId = null;
    this.audioTrackId = null;
    this._lifecycleTail = Promise.resolve();
    this._pending = [];
  }

  /** 解析 init segment 并建立解码器 */
  open(initBytes) {
    return this._enqueueLifecycle(() => this._open(initBytes));
  }

  _enqueueLifecycle(operation) {
    const result = this._lifecycleTail.then(operation);
    this._lifecycleTail = result.catch(() => {});
    return result;
  }

  async _open(initBytes) {
    const cfg = decoderConfigsFromInit(initBytes);
    if (cfg.video && !(cfg.videoTrack.trackId > 0)) {
      throw notSupported('视频轨缺少有效的 tkhd track_ID，无法关联 CMAF 分片');
    }
    if (cfg.audio && !(cfg.audioTrack.trackId > 0)) {
      throw notSupported('音频轨缺少有效的 tkhd track_ID，无法关联 CMAF 分片');
    }
    if (cfg.video && !hasVideoWebCodecs()) {
      throw notSupported('当前环境缺少视频 WebCodecs decoder 或 chunk API');
    }
    if (cfg.audio && !hasAudioWebCodecs()) {
      throw notSupported('当前环境缺少音频 WebCodecs decoder 或 chunk API');
    }
    // Preflight every real track before constructing any decoder: an unsupported audio
    // config must not leave the already-created video decoder behind (or vice versa).
    if (cfg.video) {
      const support = await window.VideoDecoder.isConfigSupported(cfg.video);
      if (support?.supported !== true) {
        throw notSupported(`浏览器不支持该视频配置: ${cfg.video.codec}`);
      }
    }
    if (cfg.audio) {
      const support = await window.AudioDecoder.isConfigSupported(cfg.audio);
      if (support?.supported !== true) {
        throw notSupported(`浏览器不支持该音频配置: ${cfg.audio.codec}`);
      }
    }

    let videoDecoder = null;
    let audioDecoder = null;
    try {
      if (cfg.video) {
        videoDecoder = new window.VideoDecoder({
          output: (frame) => this.onVideoFrame(frame),
          error: (e) => this.onError(e),
        });
        videoDecoder.configure(cfg.video);
      }
      if (cfg.audio) {
        audioDecoder = new window.AudioDecoder({
          output: (data) => this.onAudioData(data),
          error: (e) => this.onError(e),
        });
        audioDecoder.configure(cfg.audio);
      }

      // Replace old decoders only after all new families are configured successfully.
      await this._closeNow();
      this.videoDecoder = videoDecoder;
      this.audioDecoder = audioDecoder;
      this.videoTrackId = cfg.videoTrack?.trackId ?? null;
      this.audioTrackId = cfg.audioTrack?.trackId ?? null;
      if (cfg.videoTrack) this.videoTimescale = cfg.videoTrack.timescale;
      if (cfg.audioTrack) this.audioTimescale = cfg.audioTrack.timescale;
      return cfg;
    } catch (err) {
      for (const decoder of [videoDecoder, audioDecoder]) {
        if (decoder && decoder.state !== 'closed') {
          try { decoder.close(); } catch { /* preserve the original open failure */ }
        }
      }
      throw err;
    }
  }

  /**
   * 喂入一个 chunk（styp+moof+mdat）。样本数据直接从 mdat 切片，
   * AVCC 形态原样交 VideoDecoder（description 已在 configure 时传入）。
   * @param {{tracks:Array<{trackId:number,samples:Array<{durationTicks,size,keyframe,dtsOffset,dataStart}>}>}} chunk splitChunks() 的产物
   * @param {Uint8Array} buf chunk 所在的完整缓冲
   */
  appendChunk(chunk, buf) {
    for (const track of chunk.tracks) {
      const isVideo = !!this.videoDecoder && track.trackId === this.videoTrackId;
      const isAudio = !!this.audioDecoder && track.trackId === this.audioTrackId;
      const decoder = isVideo ? this.videoDecoder : isAudio ? this.audioDecoder : null;
      if (!decoder) continue;
      const ts = isVideo ? this.videoTimescale : this.audioTimescale;
      for (const s of track.samples) {
        const data = buf.subarray(s.dataStart, s.dataStart + s.size);
        try {
          const Chunk = isVideo ? window.EncodedVideoChunk : window.EncodedAudioChunk;
          decoder.decode(new Chunk({
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
  close() {
    return this._enqueueLifecycle(() => this._closeNow());
  }

  async _closeNow() {
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
      this.videoTrackId = null;
      this.audioTrackId = null;
    }
  }
}
