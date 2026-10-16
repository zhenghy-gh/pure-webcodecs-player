/**
 * AudioWorklet PCM 播放器。
 *
 * 架构：主线程 push Float32 声道数据 → SharedArray 不可用时经 port 传拷贝 →
 * worklet 环形缓冲 → process() 填充输出。时钟以"已消费帧数/采样率"为准，
 * 是音画同步里音频主钟（audio master clock）的数据来源。
 *
 * worklet 处理器代码以内联字符串 + Blob URL 注入，零构建、单文件可用。
 */
import { Emitter } from './emitter.js';
import { notSupported, stateError, decodeError } from './errors.js';

/** AudioWorkletProcessor 源码（在 audio 线程运行） */
export const PCM_WORKLET_CODE = /* js */ `
const MAX_BUFFERED_SAMPLES = 1 << 24;
const getTypedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
).get;
class PcmRingWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rings = [];            // 每声道一个 Float32Array 环形缓冲
    this.writePos = 0;
    this.bufferedFrames = 0;
    this.playedFrames = 0;      // 当前时钟代的已消费源帧数
    this.clockGeneration = 0;
    this.playbackRate = 1;
    this.readFraction = 0;
    this.framesSinceReport = 0;
    this.underruns = 0;
    this.capacity = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'push') {
        const channels = msg.channels;
        const frames = msg.frames;
        if (!Array.isArray(channels) || channels.length < 1 || channels.length > 32
          || !Number.isSafeInteger(frames) || frames < 1
          || channels.some((channel) => {
            try {
              return !ArrayBuffer.isView(channel)
                || getTypedArrayName.call(channel) !== 'Float32Array'
                || channel.length !== frames;
            } catch {
              return true;
            }
          })) return;
        const maxFrames = Math.floor(MAX_BUFFERED_SAMPLES / channels.length);
        if (frames > maxFrames || (this.rings.length === channels.length
          && this.bufferedFrames + frames > maxFrames)) return;
        if (this.rings.length !== channels.length) {
          // 声道布局变化时丢弃旧布局残留，避免把旧通道样本误路由到新布局。
          this.capacity = Math.max(frames, Math.min(currentSampleRate >> 1, maxFrames));
          this.rings = Array.from({ length: channels.length }, () => new Float32Array(this.capacity));
          this.writePos = 0;
          this.bufferedFrames = 0;
        } else if (this.capacity === 0) {
          this.capacity = Math.max(frames, Math.min(currentSampleRate >> 1, maxFrames));
          this.rings = Array.from({ length: channels.length }, () => new Float32Array(this.capacity));
        }
        const required = this.bufferedFrames + frames;
        if (required > this.capacity) {
          const oldCapacity = this.capacity;
          let capacity = oldCapacity;
          while (capacity < required) capacity = Math.max(capacity * 2, required);
          const readPos = (this.writePos - this.bufferedFrames + oldCapacity) % oldCapacity;
          this.rings = this.rings.map((ring) => {
            const grown = new Float32Array(capacity);
            for (let i = 0; i < this.bufferedFrames; i++) grown[i] = ring[(readPos + i) % oldCapacity];
            return grown;
          });
          this.capacity = capacity;
          this.writePos = this.bufferedFrames;
        }
        const chCount = Math.min(this.rings.length, channels.length);
        for (let ch = 0; ch < chCount; ch++) {
          const ring = this.rings[ch];
          let pos = this.writePos;
          const data = channels[ch];
          for (let i = 0; i < frames; i++) {
            ring[pos] = data[i];
            pos = pos + 1 === this.capacity ? 0 : pos + 1;
          }
        }
        this.writePos = (this.writePos + frames) % this.capacity;
        this.bufferedFrames += frames;
      } else if (msg.type === 'rate') {
        if (!Number.isFinite(msg.value) || msg.value <= 0) return;
        this.playbackRate = msg.value;
      } else if (msg.type === 'clear') {
        if (!Number.isSafeInteger(msg.generation) || msg.generation <= this.clockGeneration) return;
        this.clockGeneration = msg.generation;
        this.bufferedFrames = 0;
        this.playedFrames = 0;
        this.readFraction = 0;
        this.framesSinceReport = 0;
        this.writePos = 0;
      } else if (msg.type === 'query') {
        this.report();
      }
    };
  }

  report() {
    this.port.postMessage({
      type: 'stats',
      generation: this.clockGeneration,
      bufferedFrames: this.bufferedFrames,
      playedFrames: this.playedFrames,
      underruns: this.underruns,
      sampleRate: sampleRate,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const block = output[0].length; // 通常 128
    const chCount = output.length;

    for (let i = 0; i < block; i++) {
      const readPos = this.capacity > 0
        ? (this.writePos - this.bufferedFrames + this.capacity) % this.capacity
        : 0;
      if (this.bufferedFrames > 0) {
        const nextPos = this.capacity > 0 ? (readPos + 1) % this.capacity : 0;
        for (let ch = 0; ch < chCount; ch++) {
          const ring = this.rings[ch % Math.max(1, this.rings.length)];
          if (ring && this.rings.length > 0) {
            const first = ring[readPos];
            const second = this.bufferedFrames > 1 ? ring[nextPos] : first;
            output[ch][i] = first + (second - first) * this.readFraction;
          } else {
            output[ch][i] = 0;
          }
        }
        const advance = this.readFraction + this.playbackRate;
        const consumed = Math.min(this.bufferedFrames, Math.floor(advance));
        this.bufferedFrames -= consumed;
        this.playedFrames += consumed;
        this.readFraction = advance - Math.floor(advance);
      } else {
        this.readFraction = 0;
        for (let ch = 0; ch < chCount; ch++) output[ch][i] = 0;
        if (i === 0 && this.playedFrames > 0) {
          this.underruns += 1;
          this.port.postMessage({ type: 'underrun', at: currentTime });
        }
      }
    }
    // 按输出帧（不是 rate-scaled 输入帧）定期上报，避免高倍速跨过阈值后不再更新。
    this.framesSinceReport += block;
    const reportInterval = Math.max(1, Math.floor(sampleRate / 100));
    if (this.framesSinceReport >= reportInterval) {
      this.framesSinceReport %= reportInterval;
      this.report();
    }
    return true;
  }
}
registerProcessor('player-audio-sink', PcmRingWorklet);
`;

/** 契约 §7 定稿的 processor 注册名 */
export const AUDIO_SINK_PROCESSOR_NAME = 'player-audio-sink';
const WORKLET_NAME = AUDIO_SINK_PROCESSOR_NAME;
const getTypedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
).get;

function isFloat32Array(value) {
  return ArrayBuffer.isView(value) && getTypedArrayName.call(value) === 'Float32Array';
}

/** 生成可 addModule 的 Blob URL */
export function createWorkletUrl(code = PCM_WORKLET_CODE) {
  const blob = new Blob([code], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/**
 * 契约 §7 工厂：创建统一 AudioOutput 实例。
 * `channels` 是定稿参数名，`channelCount` 作为迁移期兼容参数保留。
 * @param {{sampleRate?: number, channels?: number, channelCount?: number}} [options]
 * @returns {AudioWorkletPlayer}
 */
export function createAudioOutput(options = {}) {
  const channelCount = options.channels ?? options.channelCount;
  return new AudioWorkletPlayer({
    ...options,
    ...(channelCount === undefined ? {} : { channelCount }),
  });
}

export class AudioWorkletPlayer extends Emitter {
  /**
   * @param {{sampleRate?: number, channelCount?: number, channels?: number}} [options]
   *   sampleRate 缺省用 AudioContext 默认；channels 为契约定稿声道数，channelCount 为兼容别名。
   *   解码器输出的采样率不同时由 push 时重采样告知（当前按原样写入）。
   */
  constructor(options = {}) {
    super();
    if (typeof AudioContext === 'undefined') {
      throw notSupported('AudioContext is not available');
    }
    const sampleRate = options.sampleRate ?? 48000;
    const channelCount = options.channelCount ?? 2;
    if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw stateError('sampleRate must be a finite positive number');
    }
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32) {
      throw stateError('channelCount must be an integer between 1 and 32');
    }
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    /** @type {AudioContext|null} */
    this.context = null;
    this.node = null;
    this.gainNode = null;
    this.url = null;
    this.playing = false;
    this.destroyed = false;
    // 主线程侧镜像的统计（worklet 上报）
    this._playedFrames = 0;
    this._clockGeneration = 0;
    this._bufferedFrames = 0;
    this._underruns = 0;
    this._anchorCtxTime = 0; // playedFrames 对应的 context.currentTime 锚点
    this._startedAt = 0;
    this._playbackRate = 1;
  }

  /** 创建 AudioContext 并装载 worklet；必须先于 push/play 调用 */
  async init() {
    if (this.context) return;
    const ctx = new AudioContext({ sampleRate: this.sampleRate });
    this.context = ctx;
    this.url = createWorkletUrl();
    await ctx.audioWorklet.addModule(this.url);

    this.node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, this.channelCount)],
    });
    this.node.port.onmessage = (e) => this._onWorkletMessage(e.data);
    if (this._playbackRate !== 1) this.node.port.postMessage({ type: 'rate', value: this._playbackRate });
    if (this._clockGeneration > 0) {
      this.node.port.postMessage({ type: 'clear', generation: this._clockGeneration });
    }
    this.gainNode = ctx.createGain();
    this.node.connect(this.gainNode).connect(ctx.destination);
    this.emit('ready', { sampleRate: ctx.sampleRate });
  }

  _onWorkletMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.type) {
        case 'stats': {
          const { generation, bufferedFrames, playedFrames, sampleRate } = msg;
          if (!Number.isSafeInteger(generation) || generation !== this._clockGeneration
            || !Number.isSafeInteger(bufferedFrames) || bufferedFrames < 0
            || bufferedFrames > (1 << 24)
            || !Number.isSafeInteger(playedFrames) || playedFrames < 0
            || playedFrames < this._playedFrames
            || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
          this.sampleRate = sampleRate;
          this._bufferedFrames = bufferedFrames;
          this._onPlayedFrames(playedFrames);
          break;
        }
        case 'underrun':
          if (!Number.isFinite(msg.at) || msg.at < 0) return;
          this._underruns += 1;
          this.emit('underrun', { contextTime: msg.at });
          break;
        default:
          break;
      }
    } catch {
      // Worklet 消息来自独立线程，异常数据不得污染主线程状态。
    }
  }

  _onPlayedFrames(playedFrames) {
    if (playedFrames !== this._playedFrames) {
      this._playedFrames = playedFrames;
      this.emit('progress', this.currentTimeSec());
    }
  }

  /**
   * 推入 PCM 数据。
   * @param {Float32Array[]} channels 每声道等长的样本数组
   */
  push(channels) {
    if (!this.node) throw stateError('call init() before push()');
    if (!Array.isArray(channels)) throw stateError('push() expects an array of Float32Array channels');
    if (channels.length === 0) return;
    if (!channels.every(isFloat32Array)) {
      throw stateError('push() channels must be Float32Array instances');
    }
    const frames = channels[0].length;
    if (channels.some((channel) => channel.length !== frames)) {
      throw stateError('push() channels must have equal frame counts');
    }
    if (frames === 0) return;
    const packed = channels.map((channel) => (
      channel.buffer instanceof ArrayBuffer
        && channel.byteOffset === 0
        && channel.byteLength === channel.buffer.byteLength
        ? channel
        : new Float32Array(channel)
    ));
    const buffers = [...new Set(packed.map((channel) => channel.buffer))];
    this.node.port.postMessage(
      { type: 'push', channels: packed, frames },
      buffers,
    );
    this._bufferedFrames += frames;
  }

  _resumeContext() {
    let result;
    try { result = this.context?.resume?.(); } catch (error) {
      this.emit('error', decodeError('AudioContext resume() 被拒绝', { cause: error }));
      return;
    }
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).then(() => this.emit('resumed')).catch((error) => {
        this.emit('error', decodeError('AudioContext resume() 被拒绝', { cause: error }));
      });
    }
  }

  play() {
    if (!this.context) throw stateError('call init() before play()');
    this.playing = true;
    if (this.context.state === 'suspended') this._resumeContext();
    this._anchorCtxTime = this.context.currentTime;
    this._startedAt = this._playedFrames / this.sampleRate;
    this.emit('play');
  }

  _suspendContext() {
    let result;
    try { result = this.context?.suspend?.(); } catch (error) {
      this.emit('error', decodeError('AudioContext suspend() 被拒绝', { cause: error }));
      return;
    }
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch((error) => {
        this.emit('error', decodeError('AudioContext suspend() 被拒绝', { cause: error }));
      });
    }
  }

  pause() {
    this.playing = false;
    this._suspendContext();
    this.emit('pause');
  }

  resume() {
    if (!this.context) return;
    this.playing = true;
    this._resumeContext();
  }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
  }

  setPlaybackRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) throw stateError(`invalid playbackRate: ${rate}`);
    const now = this.context?.currentTime ?? 0;
    if (this.playing && Number.isFinite(now)) this._startedAt += Math.max(0, now - this._anchorCtxTime) * this._playbackRate;
    this._anchorCtxTime = now;
    this._playbackRate = rate;
    this.node?.port.postMessage({ type: 'rate', value: rate });
  }

  /**
   * 音频主钟（契约 §7 定稿口径）：整数微秒。
   * AudioOutput.currentTimeUs 是全系统主时钟源；A/V 同步一律以此为准。
   */
  get currentTimeUs() {
    return Math.round(this.currentTimeSec() * 1e6);
  }

  /** 音频已播时刻（秒制便捷视图）——内部换算自 currentTimeUs */
  currentTimeSec() {
    const consumed = this._playedFrames / this.sampleRate;
    if (!this.context) return consumed;
    if (this.playing && Number.isFinite(this.context.currentTime)
      && Number.isFinite(this._anchorCtxTime) && Number.isFinite(this._startedAt)) {
      const elapsed = Math.max(0, this.context.currentTime - this._anchorCtxTime);
      return Number.isFinite(elapsed) ? this._startedAt + elapsed * this._playbackRate : consumed;
    }
    return Number.isFinite(consumed) ? consumed : 0;
  }

  get bufferedSec() {
    return this._bufferedFrames / this.sampleRate;
  }

  /** 音频欠载（underrun）累计次数——对应 Player.stats.underrunCount 的数据源 */
  get underrunCount() {
    return this._underruns;
  }

  clearBuffer() {
    this._clockGeneration += 1;
    this.node?.port.postMessage({ type: 'clear', generation: this._clockGeneration });
    this._bufferedFrames = 0;
    this._playedFrames = 0;
    this._anchorCtxTime = this.context?.currentTime ?? 0;
    this._startedAt = 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.node?.disconnect();
      this.gainNode?.disconnect();
      const result = this.context?.close?.();
      // AudioContext.close() 返回 Promise；销毁路径不能留下 unhandledrejection。
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
    } catch {
      /* 忽略关闭竞态 */
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.node = null;
    this.context = null;
    this.emit('destroy');
    this.removeAllListeners();
  }
}
