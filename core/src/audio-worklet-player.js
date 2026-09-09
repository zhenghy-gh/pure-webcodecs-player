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
import { notSupported, stateError } from './errors.js';

/** AudioWorkletProcessor 源码（在 audio 线程运行） */
export const PCM_WORKLET_CODE = /* js */ `
class PcmRingWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rings = [];            // 每声道一个 Float32Array 环形缓冲
    this.writePos = 0;
    this.bufferedFrames = 0;
    this.playedFrames = 0;      // 已实际送出的总帧数
    this.underruns = 0;
    this.capacity = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'push') {
        const channels = msg.channels;
        const frames = msg.frames;
        if (this.rings.length !== channels.length || this.capacity < frames) {
          // 首次或容量变化：重建环形缓冲（容量取最大需求与 4 倍块长）
          this.capacity = Math.max(this.capacity, frames, currentSampleRate >> 1);
          while (this.rings.length < channels.length) this.rings.push(new Float32Array(this.capacity));
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
      } else if (msg.type === 'clear') {
        this.bufferedFrames = 0;
        this.writePos = 0;
      } else if (msg.type === 'query') {
        this.report();
      }
    };
  }

  report() {
    this.port.postMessage({
      type: 'stats',
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
      if (this.bufferedFrames > 0) {
        const readPos =
          (this.writePos - this.bufferedFrames + this.capacity) % this.capacity;
        for (let ch = 0; ch < chCount; ch++) {
          const ring = this.rings[ch % Math.max(1, this.rings.length)];
          output[ch][i] = ring && this.rings.length > 0 ? ring[readPos] : 0;
        }
        this.bufferedFrames -= 1;
        this.playedFrames += 1;
      } else {
        for (let ch = 0; ch < chCount; ch++) output[ch][i] = 0;
        if (i === 0 && this.playedFrames > 0) {
          this.underruns += 1;
          this.port.postMessage({ type: 'underrun', at: currentTime });
        }
      }
    }
    // 每 ~10ms 上报一次统计，供主线程推算播放时钟
    if ((this.playedFrames & 1023) < block) this.report();
    return true;
  }
}
registerProcessor('player-audio-sink', PcmRingWorklet);
`;

/** 契约 §7 定稿的 processor 注册名 */
export const AUDIO_SINK_PROCESSOR_NAME = 'player-audio-sink';
const WORKLET_NAME = AUDIO_SINK_PROCESSOR_NAME;

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
    this.sampleRate = options.sampleRate ?? 48000;
    this.channelCount = options.channelCount ?? 2;
    /** @type {AudioContext|null} */
    this.context = null;
    this.node = null;
    this.gainNode = null;
    this.url = null;
    this.playing = false;
    this.destroyed = false;
    // 主线程侧镜像的统计（worklet 上报）
    this._playedFrames = 0;
    this._bufferedFrames = 0;
    this._underruns = 0;
    this._anchorCtxTime = 0; // playedFrames 对应的 context.currentTime 锚点
    this._startedAt = 0;
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
    this.gainNode = ctx.createGain();
    this.node.connect(this.gainNode).connect(ctx.destination);
    this.emit('ready', { sampleRate: ctx.sampleRate });
  }

  _onWorkletMessage(msg) {
    switch (msg.type) {
      case 'stats':
        this._bufferedFrames = msg.bufferedFrames;
        this._onPlayedFrames(msg.playedFrames);
        break;
      case 'underrun':
        this._underruns += 1;
        this.emit('underrun', { contextTime: msg.at });
        break;
      default:
        break;
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
    if (!channels.length || !channels[0].length) return;
    const frames = channels[0].length;
    const buffers = channels.map((c) => c.buffer);
    this.node.port.postMessage(
      { type: 'push', channels, frames },
      buffers,
    );
    this._bufferedFrames += frames;
  }

  play() {
    if (!this.context) throw stateError('call init() before play()');
    this.playing = true;
    if (this.context.state === 'suspended') {
      this.context.resume().then(() => this.emit('resumed'));
    }
    this._anchorCtxTime = this.context.currentTime;
    this._startedAt = this._playedFrames / this.sampleRate;
    this.emit('play');
  }

  pause() {
    this.playing = false;
    this.context?.suspend?.();
    this.emit('pause');
  }

  resume() {
    if (!this.context) return;
    this.playing = true;
    this.context.resume().then(() => this.emit('resumed'));
  }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
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
    if (this.playing) {
      return this._startedAt + Math.max(0, this.context.currentTime - this._anchorCtxTime);
    }
    return consumed;
  }

  get bufferedSec() {
    return this._bufferedFrames / this.sampleRate;
  }

  /** 音频欠载（underrun）累计次数——对应 Player.stats.underrunCount 的数据源 */
  get underrunCount() {
    return this._underruns;
  }

  clearBuffer() {
    this.node?.port.postMessage({ type: 'clear' });
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
      this.context?.close?.();
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
