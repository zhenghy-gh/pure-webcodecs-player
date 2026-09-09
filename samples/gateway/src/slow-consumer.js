/**
 * SlowConsumerQueue —— 订阅端出站背压队列（T-GW 增强）。
 *
 * 语义：二进制媒体块进入有界 FIFO；当积压字节超过上限时**丢弃最旧块**并计数
 * （直播语义下丢旧优于阻塞发布方）；文本信令不排队、不丢弃（小且关键，直发）。
 *
 * 单独成类便于在单测中注入假 sink 驱动，不必真实制造 TCP 背压。
 */

export class SlowConsumerQueue {
  /**
   * @param {{send:(chunk:Buffer|Uint8Array)=>boolean}} sink 具备 send 的底层连接
   * @param {{maxQueuedBytes?:number}} [opts]
   */
  constructor(sink, opts = {}) {
    this.sink = sink;
    this.maxQueuedBytes = opts.maxQueuedBytes ?? 2 * 1024 * 1024;
    /** 丢块回调（len=丢弃字节数），供网关聚合统计 */
    this.onDrop = typeof opts.onDrop === 'function' ? opts.onDrop : null;
    this.queue = [];
    this.queuedBytes = 0;
    /** 统计：因慢消费被丢弃的旧块数量与字节数 */
    this.droppedChunks = 0;
    this.droppedBytes = 0;
    this._draining = false;
  }

  /** 入队一个媒体块；超限时丢弃最旧块（含刚入队者之前的最旧元素） */
  enqueueBinary(chunk) {
    const c = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    while (this.queuedBytes + c.length > this.maxQueuedBytes && this.queue.length > 0) {
      const dropped = this.queue.shift();
      this.queuedBytes -= dropped.length;
      this.droppedChunks++;
      this.droppedBytes += dropped.length;
      this.onDrop?.(dropped.length);
    }
    // 单块本身超限：直接丢弃该块，不入队
    if (c.length > this.maxQueuedBytes) {
      this.droppedChunks++;
      this.droppedBytes += c.length;
      this.onDrop?.(c.length);
      return false;
    }
    this.queue.push(c);
    this.queuedBytes += c.length;
    this.#scheduleDrain();
    return true;
  }

  /** 文本信令直发不排队 */
  sendText(text) {
    try {
      this.sink.send(text);
      return true;
    } catch {
      return false;
    }
  }

  #scheduleDrain() {
    if (this._draining) return;
    this._draining = true;
    setImmediate(() => this.#drain());
  }

  #drain() {
    this._draining = false;
    let progressed = false;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      let ok = false;
      try {
        ok = this.sink.send(next);
      } catch {
        ok = false;
      }
      if (!ok) break; // 底层写不动：保留队列，等待下一次 enqueue 触发再试
      this.queue.shift();
      this.queuedBytes -= next.length;
      progressed = true;
    }
    // 仅在有进展且仍有积压时续排；写失败不得无限重排（否则空转烧 CPU 且进程无法退出）
    if (progressed && this.queue.length > 0) this.#scheduleDrain();
  }

  clear() {
    this.droppedBytes += this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
  }
}
