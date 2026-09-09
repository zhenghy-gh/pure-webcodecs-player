/**
 * wav/src/worklet-processor.js — AudioWorklet 消费端（源码字符串）
 * ------------------------------------------------------------
 * 零构建约束：worklet 模块不能用相对路径 import，统一走
 * `audioWorklet.addModule(URL.createObjectURL(new Blob([SOURCE])))`
 * （与契约 §5.2 的 core 音频方案同构）。core 的
 * createAudioOutput 稳定后可整体替换本文件。
 *
 * 处理器职责：
 *   · 接收主线程推送的 f32-planar 块，写入每通道环形缓冲；
 *   · 以 k-rate 参数 playbackRate 做**线性插值重采样**消费（倍速支持）；
 *   · 缓冲耗尽输出静音并上报 'underrun'；数据播尽上报 'ended'。
 */

/** 注册名：主线程 addModule 后 new AudioWorkletNode(ctx, WORKLET_NAME) */
export const WORKLET_NAME = 'wav-pcm-sink';

/**
 * 主线程侧使用的处理器完整源码。
 * 消息协议：
 *   主线程 → worklet：
 *     {type:'write', planar:Float32Array[]}   追加采样（Transferable）
 *     {type:'pause', value:boolean}           true 时输出静音且不消耗
 *     {type:'flush', baseFrame:number}        清空缓冲并把时间基准对齐到 baseFrame
 *     {type:'eof'}                            数据写完，缓冲耗尽后报 ended
 *   worklet → 主线程：
 *     {type:'progress', frame:number, buffered:number} 已消耗源帧序号 + 当前缓冲帧数（约 80ms 一报）
 *     {type:'overflow', dropped:number, total:number}  写侧溢出丢帧（评审阻断1 守卫）
 *     {type:'underrun', count:number}         断流累计次数
 *     {type:'ended'}                          全部播完
 */
export const WORKLET_SOURCE = `
const CH_MAX = 8;

class WavPcmSink extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.channels = Math.min(Math.max(opts.channels | 0 || 1, 1), CH_MAX);
    // 环形缓冲容量（帧），默认 200ms
    this.capacity = Math.max(1024, opts.capacityFrames | 0 || Math.ceil(sampleRate * 0.2));
    this.ring = [];
    for (let c = 0; c < this.channels; c++) this.ring.push(new Float32Array(this.capacity));
    this.writePos = 0;      // 写入游标（帧，绝对值）
    this.consumed = 0;      // 已从环形缓冲读出的源帧数（浮点，含插值小数）
    this.baseFrame = 0;     // 最近一次 flush 的源帧基准
    this.paused = false;
    this.eof = false;
    this.endedSent = false;
    this.underruns = 0;
    this.lastUnderrun = false;
    this.reportAccum = 0;
    this.droppedTotal = 0;                                 // 溢出丢弃累计（写侧守卫）
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'write':
        this.write(msg.planar);
        break;
      case 'pause':
        this.paused = !!msg.value;
        break;
      case 'flush':
        this.writePos = 0;
        this.consumed = 0;
        this.baseFrame = msg.baseFrame | 0;
        this.eof = false;
        this.endedSent = false;
        break;
      case 'eof':
        this.eof = true;
        break;
    }
  }

  /**
   * planar → 交错写入环形缓冲。
   * 【溢出守卫】只写入 buffered() 剩余空间能容纳的帧数，多余部分丢弃并
   * 通过 'overflow' 消息上报累计丢帧——绝不绕回覆写未消费采样（评审阻断1）。
   */
  write(planar) {
    if (!planar || !planar.length) return;
    const frames = planar[0].length;
    const free = this.capacity - this.buffered();
    const writable = Math.min(frames, Math.max(0, free));
    for (let i = 0; i < writable; i++) {
      const slot = this.writePos % this.capacity;
      for (let c = 0; c < this.channels; c++) {
        this.ring[c][slot] = planar[c] ? planar[c][i] : 0;
      }
      this.writePos++;
    }
    if (writable < frames) {
      this.droppedTotal += frames - writable;
      this.port.postMessage({ type: 'overflow', dropped: frames - writable, total: this.droppedTotal });
    }
  }

  buffered() { return this.writePos - Math.floor(this.consumed); }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outCh = Math.min(out.length, this.channels);
    const n = out[0].length;

    if (this.paused) {
      for (let c = 0; c < outCh; c++) out[c].fill(0);
      return true;
    }

    const rate = this.parameters.playbackRate.length > 0 ? this.parameters.playbackRate[0] : 1;
    let under = this.buffered() < 2;

    let underAnnounced = this.lastUnderrun;
    for (let i = 0; i < n; i++) {
      const avail = this.buffered();
      // eof 尾帧保持：仅剩 1 帧时无下一帧可插值，直接原样输出后结束
      if (this.eof && avail === 1) {
        const idx = Math.floor(this.consumed) % this.capacity;
        for (let c = 0; c < outCh; c++) out[c][i] = this.ring[c][idx];
        this.consumed += 1;
        continue;
      }
      if (this.paused || avail < 2 || under) {
        if (!this.eof && !under) {
          this.underruns++;
          this.port.postMessage({ type: 'underrun', count: this.underruns });
          under = true;
        }
        for (let c = 0; c < outCh; c++) out[c][i] = 0;   // 断流静音且不推进位置
        continue;
      }
      void underAnnounced;

      const pos0 = Math.floor(this.consumed) % this.capacity;
      const pos1 = (Math.floor(this.consumed) + 1) % this.capacity;
      const frac = this.consumed - Math.floor(this.consumed);
      for (let c = 0; c < outCh; c++) {
        const a = this.ring[c][pos0];
        const b = this.ring[c][pos1];
        out[c][i] = a + (b - a) * frac;
      }
      this.consumed += rate;
    }

    // 超出 eof 且缓冲排空 → 结束
    if (this.eof && !this.paused && this.buffered() <= 1 && !this.endedSent) {
      this.endedSent = true;
      this.port.postMessage({ type: 'ended' });
    }

    // 进度上报：源帧序号 + 当前缓冲水位（供主线程节流），约每 4096 帧一次
    this.reportAccum += n * rate;
    if (this.reportAccum >= 4096) {
      this.reportAccum = 0;
      this.port.postMessage({
        type: 'progress',
        frame: this.baseFrame + Math.floor(this.consumed),
        buffered: this.buffered(),
      });
    }
    return true;
  }

  static get parameterDescriptors() {
    return [{
      name: 'playbackRate',
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: 'k-rate',
    }];
  }
}

registerProcessor('${WORKLET_NAME}', WavPcmSink);
`;
