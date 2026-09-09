/**
 * WebCodecs 解码管线：demux 样本 → EncodedVideoChunk/AudioChunk → VideoFrame/AudioData。
 *
 * 与 MSE 二选一的渲染路径（detectCapabilities 决定）：
 * - 视频经回调交给 core 的 VideoFrameRenderer 上屏；
 * - 音频 AudioData 转 Float32 后交给 AudioWorkletPlayer 播放。
 *
 * Node 测试环境没有 WebCodecs：构造会抛错；但配置构建（buildVideoConfig 等）
 * 是纯函数，可直接单测。
 */
import {
  hasWebCodecs,
  TrackType,
} from '../../core/src/index.js';
import { stateError, decodeError } from '../../core/src/errors.js';

/** Track → VideoDecoderConfig（契约字段 description；纯函数，供测试） */
export function buildVideoConfig(track) {
  // 类型断言（调用方误用即 bug，非输入容错路径）：保留 TypeError
  if (!track || track.type !== TrackType.VIDEO) throw new TypeError('not a video track');
  if (!track.codec) throw stateError('video track missing codec string');
  const description = track.description ?? track.codecPrivate ?? null;
  return {
    codec: track.codec,
    ...(track.width ? { width: track.width } : {}),
    ...(track.height ? { height: track.height } : {}),
    ...(description ? { description } : {}),
    // MP4 内样本为 AVCC 布局，无需转 annexb
    optimizeForLatency: false,
  };
}

/** Track → AudioDecoderConfig */
export function buildAudioConfig(track) {
  if (!track || track.type !== TrackType.AUDIO) throw new TypeError('not an audio track');
  if (!track.codec) throw stateError('audio track missing codec string');
  const description = track.description ?? track.codecPrivate ?? null;
  return {
    codec: track.codec,
    ...(track.sampleRate ? { sampleRate: track.sampleRate } : {}),
    ...(track.numberOfChannels ? { numberOfChannels: track.numberOfChannels }
      : track.channelCount ? { numberOfChannels: track.channelCount } : {}),
    ...(description ? { description } : {}),
  };
}

export class Mp4WebCodecsPipeline {
  /**
   * @param {import('../../core/src/demuxer.js').Demuxer} demuxer 已 init()
   * @param {{
   *   onVideoFrame?: (frame: VideoFrame, meta: object) => void,
   *   onAudioData?: (data: AudioData, meta: object) => void,
   *   stats?: import('../../core/src/stats.js').Stats,
   *   maxQueue?: number,
   * }} handlers
   */
  constructor(demuxer, handlers = {}) {
    if (!hasWebCodecs()) {
      throw stateError('WebCodecs not available in this environment');
    }
    this.demuxer = demuxer;
    this.handlers = handlers;
    this.stats = handlers.stats ?? null;
    this.maxQueue = handlers.maxQueue ?? 16;
    /** @type {VideoDecoder|null} */ this.videoDecoder = null;
    /** @type {AudioDecoder|null} */ this.audioDecoder = null;
    this.videoConfig = null;
    this.audioConfig = null;
    this._running = false;
    this._aborted = false;
    this._pending = [];
  }

  /** 探测当前环境 + 配置是否可解 */
  async supported() {
    const info = this.demuxer.getMediaInfo();
    const vTrack = info?.tracks.find((t) => t.type === TrackType.VIDEO);
    const aTrack = info?.tracks.find((t) => t.type === TrackType.AUDIO);
    let okVideo = true;
    let okAudio = true;
    try {
      if (vTrack) {
        this.videoConfig = buildVideoConfig(vTrack);
        okVideo = (await VideoDecoder.isConfigSupported(this.videoConfig))?.supported === true;
      }
      if (aTrack) {
        this.audioConfig = buildAudioConfig(aTrack);
        okAudio = (await AudioDecoder.isConfigSupported(this.audioConfig))?.supported === true;
      }
    } catch (err) {
      return { supported: false, reason: String(err), video: false, audio: false };
    }
    return { supported: okVideo || okAudio, video: okVideo, audio: okAudio, reason: okVideo || okAudio ? null : 'configs unsupported' };
  }

  async _ensureDecoders() {
    const support = await this.supported();
    if (!support.supported) {
      throw decodeError(`decoder unsupported: ${support.reason}`);
    }
    if (this.videoConfig && !this.videoDecoder) {
      this.videoDecoder = new VideoDecoder({
        output: (frame) => {
          this.stats?.markSampleDecoded();
          this.handlers.onVideoFrame?.(frame, { decoder: 'video' });
        },
        error: (err) => {
          this.stats?.markDecodeError(err);
          this.handlers.onError?.(err);
        },
      });
      this.videoDecoder.configure(this.videoConfig);
    }
    if (this.audioConfig && !this.audioDecoder) {
      this.audioDecoder = new AudioDecoder({
        output: (data) => {
          this.stats?.markSampleDecoded();
          this.handlers.onAudioData?.(data, { decoder: 'audio' });
        },
        error: (err) => {
          this.stats?.markDecodeError(err);
          this.handlers.onError?.(err);
        },
      });
      this.audioDecoder.configure(this.audioConfig);
    }
  }

  /**
   * 从头（或指定样本序号）开始解码直到流结束。
   * @param {{fromSampleIndex?: number}} [opts]
   */
  async start(opts = {}) {
    if (this._running) throw stateError('pipeline already running');
    await this._ensureDecoders();
    this._running = true;
    this._aborted = false;

    const info = this.demuxer.getMediaInfo();
    const vTrack = info.tracks.find((t) => t.type === TrackType.VIDEO);
    const aTrack = info.tracks.find((t) => t.type === TrackType.AUDIO);

    const pump = async (track, decoder, makeChunk) => {
      if (!track || !decoder) return;
      for await (const sample of this.demuxer.samples(track.id)) {
        if (this._aborted) return;
        if (opts.fromSampleIndex !== undefined && sample.index < opts.fromSampleIndex) continue;
        while (decoder.decodeQueueSize > this.maxQueue && !this._aborted) {
          await new Promise((r) => setTimeout(r, 0));
        }
        if (this._aborted) return;
        if (!sample.data) await this.demuxer.readSampleData(sample);
        try {
          decoder.decode(makeChunk(sample, track));
          this.stats?.markDemuxed(sample.size);
        } catch (err) {
          this.stats?.markDecodeError(err);
        }
      }
      if (!this._aborted) await decoder.flush().catch(() => {});
    };

    const jobs = [];
    if (vTrack) {
      jobs.push(
        pump(vTrack, this.videoDecoder, (sample, track) =>
          new EncodedVideoChunk({
            type: sample.keyframe ? 'key' : 'delta',
            timestamp: sample.timestamp, // 契约边界已是整数微秒
            duration: sample.duration ?? 0,
            data: sample.data,
          }),
        ),
      );
    }
    if (aTrack) {
      jobs.push(
        pump(aTrack, this.audioDecoder, (sample, track) =>
          new EncodedAudioChunk({
            type: sample.keyframe ? 'key' : 'delta',
            timestamp: sample.timestamp, // 契约边界已是整数微秒
            duration: sample.duration ?? 0,
            data: sample.data,
          }),
        ),
      );
    }
    try {
      await Promise.all(jobs);
    } finally {
      this._running = false;
    }
  }

  /** 中止当前解码循环并重置解码器（seek 用） */
  async reset() {
    this._aborted = true;
    while (this._running) await new Promise((r) => setTimeout(r, 0));
    this.videoDecoder?.reset?.();
    this.audioDecoder?.reset?.();
    this.videoDecoder?.close?.();
    this.audioDecoder?.close?.();
    this.videoDecoder = null;
    this.audioDecoder = null;
  }

  async close() {
    await this.reset();
    this.videoDecoder?.close?.();
    this.audioDecoder?.close?.();
    this.videoDecoder = null;
    this.audioDecoder = null;
  }
}
