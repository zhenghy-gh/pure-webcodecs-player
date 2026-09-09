/**
 * 播放时钟与音画同步策略。
 *
 * 模型（业界通用 audio master）：
 *   - 音频走 AudioWorklet，天然以硬件采样率推进 → 音频钟最平滑，作为主钟；
 *   - 视频按 pts 与主钟比较：
 *       drift > +late 阈值  → 丢帧（追帧）
 *       drift < -early 阈值 → 等待（渲染暂停）
 *       其余               → 正常渲染
 *   - 无音轨时退化为 PlaybackClock 单调钟。
 *
 * 所有时间单位：秒。
 */
import { Emitter } from './emitter.js';

/**
 * 默认同步参数（秒）。
 * 严格对齐 CONTRACTS.md §7：「视频 PTS 对齐 ±20ms 窗口：早到等待、迟到丢帧」。
 * 此前默认 ±120ms/±48ms 与契约不符（评审台账 core 建议项「未文档化」）。
 * 实际播放如需容忍更大 A/V 抖动，可通过构造 AvSyncController 的 options 覆盖（仍受契约窗口约束）。
 */
export const DEFAULT_SYNC_OPTIONS = Object.freeze({
  /** 视频落后音频超过该值 → 丢帧追齐（CONTRACTS §7: ±20ms） */
  maxLateSec: 0.02,
  /** 视频领先音频超过该值 → 等待（CONTRACTS §7: ±20ms） */
  maxEarlySec: 0.02,
  /** 超过该偏差直接重置时钟而不是渐进追赶 */
  hardResyncSec: 0.5,
});

/**
 * 单调播放时钟：start/seek 锚定一个 (媒体时间, 单调时间) 对，
 * 之后 getTimeSec = 媒体锚点 + (now - 单调锚点) * rate。
 */
export class PlaybackClock extends Emitter {
  /**
   * @param {{now?: () => number}} [options] now 返回秒的单调时钟（默认 performance.now）
   */
  constructor(options = {}) {
    super();
    this._now =
      options.now ??
      (() =>
        typeof performance !== 'undefined'
          ? performance.now() / 1000
          : Date.now() / 1000);
    this._mediaAnchor = 0;
    this._monoAnchor = this._now();
    this._rate = 1;
    this.running = false;
  }

  play(mediaTimeSec = undefined) {
    if (mediaTimeSec !== undefined) this.seekTo(mediaTimeSec);
    if (!this.running) {
      this._monoAnchor = this._now();
      this.running = true;
      this.emit('play');
    }
  }

  pause() {
    if (!this.running) return;
    // 先冻结当前媒体时刻再停表
    const t = this.getTimeSec();
    this._mediaAnchor = t;
    this.running = false;
    this.emit('pause', t);
  }

  seekTo(sec) {
    this._mediaAnchor = sec;
    this._monoAnchor = this._now();
    this.emit('seek', sec);
  }

  setRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`invalid playbackRate: ${rate}`);
    const t = this.getTimeSec();
    this._mediaAnchor = t;
    this._monoAnchor = this._now();
    this._rate = rate;
    this.emit('rateChange', rate);
  }

  get rate() {
    return this._rate;
  }

  getTimeSec() {
    if (!this.running) return this._mediaAnchor;
    return this._mediaAnchor + (this._now() - this._monoAnchor) * this._rate;
  }
}

/**
 * A/V 同步决策器（无状态纯函数式，便于单测与替换策略）。
 */
export class AvSyncController extends Emitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...options };
    /** 主钟来源注入点：默认由播放器内核设置为 () => audioPlayer.currentTimeSec() 或 clock.getTimeSec() */
    this.masterClockFn = null;
    this.clock = new PlaybackClock();
  }

  attachMaster(fn) {
    this.masterClockFn = fn;
  }

  /** 主钟当前值 */
  masterTimeSec() {
    if (this.masterClockFn) return this.masterClockFn();
    return this.clock.getTimeSec();
  }

  start(mediaTimeSec) {
    if (this.masterClockFn === null) this.clock.play(mediaTimeSec);
  }

  pause() {
    this.clock.pause();
  }

  seekTo(sec) {
    this.clock.seekTo(sec);
  }

  setRate(rate) {
    this.clock.setRate(rate);
  }

  /**
   * 给出视频帧的渲染决策。
   * @param {number} videoPtsSec 帧 pts（秒）
   * @returns {{action:'render'|'drop'|'wait'|'resync', drift:number}}
   */
  suggestVideoAction(videoPtsSec) {
    const drift = videoPtsSec - this.masterTimeSec(); // >0 视频超前
    const o = this.options;
    if (Math.abs(drift) >= o.hardResyncSec) {
      this.emit('resync', { drift, videoPtsSec });
      this.clock.seekTo(videoPtsSec);
      return { action: 'resync', drift };
    }
    if (drift < -o.maxLateSec) return { action: 'drop', drift }; // 视频太旧
    if (drift > o.maxEarlySec) return { action: 'wait', drift }; // 视频超前太多
    return { action: 'render', drift };
  }
}
