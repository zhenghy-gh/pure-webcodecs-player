/**
 * 播放统计：字节、帧、缓冲水位与速率的集中记录点。
 *
 * 设计：所有计数方法都是 O(1)；时间相关计算可注入时钟以便单测；
 * snapshot() 输出纯 JSON 对象供 UI / 上报使用。
 */
import { Emitter } from './emitter.js';

export class Stats extends Emitter {
  /**
   * @param {{now?: () => number}} [options] now 返回秒
   */
  constructor(options = {}) {
    super();
    // 单调钟优先 performance.now（可被 NTP 回拨的 Date.now 兜底），与 core/src/clock.js 口径一致，
    // 避免系统时钟回拨导致 fps EMA 出现负 dt（markVideoRendered 虽已 dt>0 守卫，但优先单调源更稳）。
    this._now =
      options.now ??
      (() =>
        typeof performance !== 'undefined'
          ? performance.now() / 1000
          : Date.now() / 1000);
    this.counters = {
      bytesDemuxed: 0,
      bytesAppended: 0,
      samplesDecoded: 0,
      videoFramesRendered: 0,
      videoFramesDropped: 0,
      audioUnderruns: 0,
      seekCount: 0,
      decodeErrors: 0,
    };
    this.decodeMsSum = 0;
    this.decodeMsMax = 0;
    // 渲染 fps 的指数滑动平均
    this.fpsEma = 0;
    this._lastRenderAt = null;
  }

  markDemuxed(bytes) {
    this.counters.bytesDemuxed += bytes;
  }

  markAppended(bytes) {
    this.counters.bytesAppended += bytes;
    this.emit('update', this.snapshot());
  }

  markSampleDecoded(decodeMs = undefined) {
    this.counters.samplesDecoded += 1;
    if (decodeMs !== undefined && Number.isFinite(decodeMs)) {
      this.decodeMsSum += decodeMs;
      if (decodeMs > this.decodeMsMax) this.decodeMsMax = decodeMs;
    }
  }

  markVideoRendered() {
    this.counters.videoFramesRendered += 1;
    const t = this._now();
    if (this._lastRenderAt !== null) {
      const dt = t - this._lastRenderAt;
      if (dt > 0) {
        const instantFps = 1 / dt;
        this.fpsEma = this.fpsEma === 0 ? instantFps : this.fpsEma * 0.9 + instantFps * 0.1;
      }
    }
    this._lastRenderAt = t;
  }

  markVideoDropped(n = 1) {
    this.counters.videoFramesDropped += n;
  }

  markAudioUnderrun() {
    this.counters.audioUnderruns += 1;
  }

  markSeek() {
    this.counters.seekCount += 1;
  }

  markDecodeError(detail = undefined) {
    this.counters.decodeErrors += 1;
    this.emit('decodeError', detail);
  }

  get averageDecodeMs() {
    return this.counters.samplesDecoded > 0 ? this.decodeMsSum / this.counters.samplesDecoded : 0;
  }

  /** 导出纯数据快照（不含任何运行时引用） */
  snapshot() {
    return {
      ...this.counters,
      fps: Math.round(this.fpsEma * 100) / 100,
      averageDecodeMs: Math.round(this.averageDecodeMs * 100) / 100,
      maxDecodeMs: Math.round(this.decodeMsMax * 100) / 100,
    };
  }

  reset() {
    this.counters.bytesDemuxed = 0;
    this.counters.bytesAppended = 0;
    this.counters.samplesDecoded = 0;
    this.counters.videoFramesRendered = 0;
    this.counters.videoFramesDropped = 0;
    this.counters.audioUnderruns = 0;
    this.counters.seekCount = 0;
    this.counters.decodeErrors = 0;
    this.decodeMsSum = 0;
    this.decodeMsMax = 0;
    this.fpsEma = 0;
    this._lastRenderAt = null;
  }
}
