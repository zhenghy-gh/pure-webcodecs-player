/**
 * 指数退避重连策略（rtmp 播放器断流重连使用；独立导出便于测试与复用）。
 */

export class Backoff {
  /**
   * @param {{baseMs?:number, factor?:number, maxMs?:number, jitter?:number}} opts
   *   jitter 为相对抖动比例（0~1），实际延迟在 [raw*(1-j), raw*(1+j)] 内均匀取值。
   */
  constructor(opts = {}) {
    this.baseMs = opts.baseMs ?? 500;
    this.factor = opts.factor ?? 2;
    this.maxMs = opts.maxMs ?? 30000;
    this.jitter = Math.min(Math.max(opts.jitter ?? 0.3, 0), 1);
    this.attempt = 0;
  }

  /** 取下一次延迟（毫秒）并推进 attempt 计数 */
  next() {
    const raw = Math.min(this.baseMs * this.factor ** this.attempt, this.maxMs);
    const j = raw * this.jitter * (Math.random() * 2 - 1);
    this.attempt++;
    return Math.max(30, Math.round(raw + j));
  }

  /** 复位（连接稳定后调用） */
  reset() {
    this.attempt = 0;
  }
}
