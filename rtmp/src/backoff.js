/**
 * 指数退避重连策略（rtmp 播放器断流重连使用；独立导出便于测试与复用）。
 */

export class Backoff {
  /**
   * @param {{baseMs?:number, factor?:number, maxMs?:number, jitter?:number}} opts
   *   jitter 为相对抖动比例（0~1），实际延迟在 [raw*(1-j), raw*(1+j)] 内均匀取值。
   */
  constructor(opts = {}) {
    const baseMs = opts.baseMs ?? 500;
    const factor = opts.factor ?? 2;
    const maxMs = opts.maxMs ?? 30000;
    const jitter = opts.jitter ?? 0.3;
    if (![baseMs, factor, maxMs, jitter].every(Number.isFinite) || baseMs <= 0 || factor < 1 || maxMs < baseMs || jitter < 0 || jitter > 1) {
      throw new TypeError('Backoff 参数非法');
    }
    this.baseMs = baseMs;
    this.factor = factor;
    this.maxMs = maxMs;
    this.jitter = jitter;
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
