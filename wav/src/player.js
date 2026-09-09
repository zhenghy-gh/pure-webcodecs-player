/**
 * wav/src/player.js — WavPlayer：AudioWorklet 调度的高层播放器
 * ------------------------------------------------------------
 * 直接实现 site/README.md 定义的 PlayerAdapter 协议，可与
 * createPlayerUI() 零胶水对接。内部时间一律整数微秒，仅在
 * 协议边界换算为秒（就近取整）。
 *
 * 管线：
 *   File/ArrayBuffer → RIFF 解析 → 全量转 f32-planar
 *     → 按需切块 postMessage(Transferable) → worklet 环形缓冲
 *     → 线性插值倍速消费 → AudioContext 输出
 *
 * 浏览器专属能力（AudioContext/AudioWorklet）在构造前用
 * isWavPlaybackSupported() 判断；Node 下工厂返回 null，不抛异常。
 */
import { notSupported, stateError } from './errors.js';
import { parseWavHeader } from './riff-parser.js';
import { convertToFloat32Planar, sliceFrames } from './pcm-convert.js';
import { WORKLET_NAME, WORKLET_SOURCE } from './worklet-processor.js';

/** 浏览器能力探测：Node 下恒 false */
export function isWavPlaybackSupported() {
  return typeof window !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && typeof Blob !== 'undefined'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function';
}

/** 单次向 worklet 推送的块大小（帧）：~85ms@48k，兼顾延迟与消息频率 */
const num = v => Number(v) || 0;
const PUSH_FRAMES = 4096;
/** worklet 环形缓冲容量（帧）：高于预填充水位，留足节流余量 */
const WORKLET_CAPACITY = 16384;
/** 高水位：缓冲达到此值暂停推送，低于后恢复（评审阻断1 主线程节流） */
const HIGH_WATER = WORKLET_CAPACITY - PUSH_FRAMES - 1024;
/** 环形缓冲预填充水位（帧）：<200ms，起播快且不易断流 */
const PREFILL_FRAMES = 8192;

export class WavPlayer {
  constructor() {
    if (!isWavPlaybackSupported()) {
      throw notSupported('WavPlayer 仅支持浏览器环境（需 WebAudio + AudioWorklet）');
    }
    this.emitter = new Emitter();
    /** @type {'idle'|'ready'|'playing'|'paused'|'ended'} */
    this.state = 'idle';
    this.#ctx = null;
    this.#node = null;
    this.#gain = null;
    this.#moduleLoaded = false;
    this.volume = 1;
    this.rate = 1;

    this.sampleRate = 0;
    this.channels = 0;
    this.bitsPerSample = 0;
    this.codec = '';
    this.totalFrames = 0;
    this.durationUs = 0;
    this.header = null;   // RIFF 解析结果（含 LIST/INFO 元数据）
    /** @type {Float32Array[]|null} 全量 planar 采样 */
    this.planar = null;

    this.#baseFrame = 0;      // 当前播放基准帧
    this.#reportedFrame = 0;  // worklet 最近上报的源帧
    this.underruns = 0;
    this.#eofSent = false;
  }

  #ctx;
  #node;
  #gain;
  #moduleLoaded;
  #baseFrame;
  #reportedFrame;
  #eofSent;

  /* ---------- 事件（PlayerAdapter.on） ---------- */
  on(ev, cb) { return this.emitter.on(ev, cb); }

  /**
   * 加载 WAV 字节并解析（不创建音频设备）。
   * @param {Uint8Array} bytes 完整文件字节
   * @returns {{durationSec:number}} 供 demo 展示的摘要
   */
  load(bytes) {
    const header = parseWavHeader(bytes);
    const data = bytes.subarray(header.dataChunk.offset, header.dataChunk.offset + header.dataChunk.size);
    const conv = convertToFloat32Planar(data, header.format);

    this.header = header;
    this.planar = conv.planar;
    this.sampleRate = header.format.sampleRate;
    this.channels = header.format.channels;
    this.bitsPerSample = header.format.bitsPerSample;
    this.codec = header.codec;
    this.totalFrames = conv.frames;
    this.durationUs = Math.round((conv.frames / this.sampleRate) * 1e6);
    this.#baseFrame = 0;
    this.#reportedFrame = 0;
    this.state = 'ready';
    this.emitter.emit('ready', undefined);
    return { durationSec: this.durationUs / 1e6 };
  }

  /* ---------- PlayerAdapter 协议实现 ---------- */

  async play() {
    if (this.state === 'playing') return;
    if (!this.planar) throw stateError('先调用 load() 再 play()');
    await this.#ensureGraph();

    // ended 后再按 play：从头重播
    if (this.state === 'ended') await this.seek(0);
    if (this.state !== 'paused') await this.#prefill(this.#baseFrame);

    this.#node.port.postMessage({ type: 'pause', value: false });
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();
    this.state = 'playing';
    this.emitter.emit('play', undefined);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.#node?.port.postMessage({ type: 'pause', value: true });
    this.state = 'paused';
    this.emitter.emit('pause', undefined);
  }

  /**
   * seek 到指定秒：清空环形缓冲、对齐基准帧、若在播则立即续推。
   * @param {number} sec
   */
  async seek(sec) {
    if (!this.planar) return;
    let targetFrame = Math.round(sec * this.sampleRate);
    targetFrame = Math.min(Math.max(targetFrame, 0), Math.max(this.totalFrames - 1, 0));
    this.#baseFrame = targetFrame;
    this.#reportedFrame = targetFrame;
    this.#eofSent = false;

    if (this.#node) {
      this.#pushGen++; // 使旧的推送循环立即失效
      this.#node.port.postMessage({ type: 'flush', baseFrame: targetFrame });
      await this.#prefill(targetFrame);
      if (this.state === 'playing') this.#node.port.postMessage({ type: 'pause', value: false });
    }
    this.emitter.emit('time', { currentTime: sec, duration: this.durationSec });
    if (this.state !== 'ended') return;
    this.state = 'ready';
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.#gain && this.#ctx) {
      this.#gain.gain.setTargetAtTime(this.volume, this.#ctx.currentTime, 0.01);
    }
  }

  setRate(r) {
    this.rate = Math.min(4, Math.max(0.25, r));
    if (this.#node) {
      const p = this.#node.parameters.get('playbackRate');
      p?.setTargetAtTime(this.rate, this.#ctx.currentTime, 0.05);
    }
  }

  /** 总时长（秒）；WAV 恒已知 */
  duration() { return this.totalFrames ? this.durationUs / 1e6 : null; }
  /** 当前播放位置（秒），由 worklet 上报的源帧换算 */
  currentTime() { return this.sampleRate ? this.#reportedFrame / this.sampleRate : 0; }
  get durationSec() { return this.durationUs / 1e6; }
  get seekable() { return true; }
  get rates() { return [0.5, 0.75, 1, 1.25, 1.5, 2]; }

  /** 统计面板数据源 */
  getStats() {
    const bufferedFrames = Math.min(this.totalFrames - this.currentTime() * this.sampleRate, PREFILL_FRAMES + PUSH_FRAMES);
    return [
      ['codec', `${this.codec} ${this.bitsPerSample}-bit`],
      ['采样率', `${this.sampleRate} Hz`],
      ['声道数', String(this.channels)],
      ['总帧数', `${this.totalFrames}`],
      ['时长', `${(this.durationUs / 1e6).toFixed(2)} s`],
      ['位置', `${(this.currentTime()).toFixed(2)} s`],
      ['worklet 缓冲≈', `${Math.round(bufferedFrames / (this.sampleRate || 1) * 1000)} ms`],
      ['underrun', String(this.underruns)],
      ['溢出丢弃帧', String(this.#overflowDropped)],
      ['倍速', `${this.rate}x`],
      ['状态', this.state],
    ];
  }

  /** 停止并释放音频资源（幂等；planar 数据保留可重新 play） */
  async stop() {
    this.pause();
    try { this.#node?.disconnect(); } catch { /* 忽略 */ }
    try { this.#gain?.disconnect(); } catch { /* 忽略 */ }
    this.#node = null;
    this.#gain = null;
    this.state = this.state === 'idle' ? 'idle' : 'ready';
  }

  /* ---------- 内部：音频图构建与数据推送 ---------- */

  async #ensureGraph() {
    if (this.#node) return;
    const AC = /** @type {any} */ (globalThis).AudioContext || globalThis.webkitAudioContext;
    this.#ctx = this.#ctx || new AC();
    const ctx = this.#ctx;

    if (!this.#moduleLoaded) {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url); // addModule 完成后源码已驻留，立即回收
      }
      this.#moduleLoaded = true;
    }

    this.#node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      processorOptions: { channels: this.channels, capacityFrames: WORKLET_CAPACITY },
    });
    this.#gain = ctx.createGain();
    this.#gain.gain.value = this.volume;
    this.#node.connect(this.#gain).connect(ctx.destination);

    this.#node.port.onmessage = (e) => this.#onWorkletMessage(e.data);
    const p = this.#node.parameters.get('playbackRate');
    p?.setValueAtTime(this.rate, ctx.currentTime);
  }

  #onWorkletMessage(msg) {
    switch (msg.type) {
      case 'progress':
        this.#workletBuffered = num(msg.buffered);
        this.#reportedFrame = msg.frame | 0;
        this.emitter.emit('time', { currentTime: this.currentTime(), duration: this.durationSec });
        break;
      case 'overflow': {
        this.#overflowDropped = msg.total ?? (this.#overflowDropped + num(msg.dropped));
        this.emitter.emit('overflow', { dropped: msg.dropped, total: this.#overflowDropped });
        break;
      }
      case 'underrun':
        this.underruns = msg.count;
        break;
      case 'ended':
        this.pause();                 // 先按 playing 态发暂停（次序修正）
        this.state = 'ended';
        this.emitter.emit('ended', undefined);
        break;
    }
  }

  /** 把 baseFrame 起的数据推入环形缓冲直至水位线或文件尾 */
  async #prefill(baseFrame) {
    if (!this.#node) return;
    const end = Math.min(baseFrame + PREFILL_FRAMES, this.totalFrames);
    if (end > baseFrame) {
      this.#pushBlock(sliceFrames(this.planar, baseFrame, end));
    }
    this.#maybePushRest(end);
  }

  /** 从 fromFrame 起持续推送直到文件尾（分块、拷贝后 transferable） */
  #maybePushRest(fromFrame) {
    if (!this.#node) return;
    const gen = ++this.#pushGen; // 新推送循环使旧循环失效（seek 场景）
    this.#nextPushFrame = fromFrame;
    if (this.#pushing) return;
    this.#pushing = true;
    const pushNext = () => {
      if (!this.#node || gen !== this.#pushGen || this.state !== 'playing') {
        this.#pushing = false;
        return;
      }
      const start = this.#nextPushFrame;
      if (start >= this.totalFrames) {
        if (!this.#eofSent) {
          this.#node.port.postMessage({ type: 'eof' });
          this.#eofSent = true;
        }
        this.#pushing = false;
        return;
      }
      // 水位节流：worklet 缓冲到达高水位时推迟本块，20ms 后复查（不丢数据）
      if (this.#workletBuffered >= HIGH_WATER) {
        setTimeout(pushNext, 20);
        return;
      }
      const end = Math.min(start + PUSH_FRAMES, this.totalFrames);
      this.#pushBlock(sliceFrames(this.planar, start, end));
      this.#nextPushFrame = end;
      setTimeout(pushNext, 60); // 与消耗速度匹配的低频推送
    };
    pushNext();
  }

  #pushing = false;
  #nextPushFrame = 0;
  #workletBuffered = 0;        // worklet 上报的当前缓冲帧数（节流信用）
  #overflowDropped = 0;        // 溢出丢弃累计（写侧守卫上报）
  /** 推送循环代号：seek/load 时 +1，旧循环检测到代号变化自行退出 */
  #pushGen = 0;

  #pushBlock(frames) {
    // 注意：必须先拷贝再 transfer——subarray 视图的 transfer 会 detach 整个底层 planar 缓冲
    const copies = Array.from(frames, (f) => f.slice());
    this.#node.port.postMessage({ type: 'write', planar: copies }, copies);
  }
}

/** 极简事件发射器（与 core/src/emitter.js 同构的最小子集） */
class Emitter {
  #m = new Map();
  on(e, f) { let l = this.#m.get(e); if (!l) this.#m.set(e, (l = [])); l.push(f); return () => this.off(e, f); }
  off(e, f) { const l = this.#m.get(e); if (!l) return; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  emit(e, p) { for (const f of [...(this.#m.get(e) || [])]) { try { f(p); } catch (err) { console.error(err); } } }
}
