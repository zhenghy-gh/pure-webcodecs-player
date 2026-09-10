/**
 * source.js —— torrent → piece 缓存 → DataSource 按序字节流适配层（契约 §2.1）
 *
 * 目标：让任意 demuxer（mkv/mp4/ts…）像读普通文件一样读 P2P 下载中的文件。
 * 实现与 mkv/src/source.js 完全同一契约：
 *   { byteLength, read(offset, length) -> Promise<Uint8Array>, close() }
 *
 * 两条读取策略（按 torrent 文件能力自动选择，可混合）：
 *   A. slice 快路径：file.slice(start,end) 存在时按需随机读；
 *   B. 顺序流：file.stream() + 内部滑动缓冲。向前读零成本；向后读超出缓冲时
 *      自动重启底层流并丢弃至目标偏移（慢路径，README 已注明代价与规避方法）。
 */

import { PlayerError } from '../../core/src/errors.js';

/**
 * 数据源错误：契约 §11.3 十码中的 SOURCE_ERROR 家族
 * （继承 core PlayerError；历史子码降级为 detail.reason）
 */
export class TorrentSourceError extends PlayerError {
  constructor(message, reason) {
    super('SOURCE_ERROR', message, { detail: reason ? { reason } : undefined });
    this.name = 'TorrentSourceError';
  }
}

/** 契约 §2.1 DataSource 字段名（size；byteLength 为兼容别名） */
function withSizeAlias(source) {
  Object.defineProperty(source, 'byteLength', {
    get() { return this.size; },
    configurable: true,
  });
  return source;
}

export class TorrentFileSource {
  /**
   * @param {object} file webtorrent File 对象（需 name/length/stream()；slice() 可选）
   * @param {{chunkBytes?:number, maxBackfillBytes?:number, onRead?:(bytes:number)=>void}} opts
   */
  constructor(file, opts = {}) {
    if (!file || (typeof file.stream !== 'function' && typeof file.slice !== 'function')) {
      throw new TorrentSourceError(
        'TorrentFileSource 需要带 stream() 或 slice() 的 torrent 文件对象',
        'BAD_FILE',
      );
    }
    this.file = file;
    this.name = file.name ?? '';
    this.size = Number(file.length ?? 0); // 契约 §2.1 DataSource 字段名
    this.chunkBytes = opts.chunkBytes ?? 1 << 18; // 单次向流索取的块大小（256KiB）
    /** 向后回退慢路径的最大回拖距离（防 GB 级无界缓冲 OOM 面） */
    this.maxBackfillBytes = opts.maxBackfillBytes ?? 8 << 20;
    this.onRead = opts.onRead ?? null;
    /** 读互斥：串行化并发 read，消除重叠游标竞态 */
    this._readChain = Promise.resolve();

    /** slice 随机读是否可用 */
    this.supportsRandomAccess = typeof file.slice === 'function';
    /** @type {ReadableStreamDefaultReader|null} */
    this.#reader = null;
    /** @type {Uint8Array[]} 已到达未消费的块队列 */
    this.#buffer = [];
    this.#bufferStart = 0; // #buffer[0] 对应的绝对偏移
    this.#bufferedEnd = 0; // 缓冲覆盖到的绝对终点
    this.#closed = false;
  }

  #reader;
  #buffer;
  #bufferStart;
  #bufferedEnd;
  #closed;

  /** @returns {Promise<Uint8Array>} 恰好 length 字节；EOF 处允许不足 */
  async read(offset, length) {
    if (this.#closed) throw new TorrentSourceError('源已关闭', 'CLOSED');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new TorrentSourceError(`read 参数非法: offset=${offset} length=${length}`, 'BAD_ARGS');
    }
    if (length === 0) return new Uint8Array(0);
    // OOB：size 已知时在入口统一拒绝，slice/sequential 两路行为一致
    // （size 未知时顺序流拉到 EOF 按契约返回不足部分）
    if (this.size && offset >= this.size) {
      throw new TorrentSourceError(`越界读取: offset=${offset} ≥ size=${this.size}`, 'OUT_OF_RANGE');
    }

    const out = this.supportsRandomAccess
      ? await this.#readViaSlice(offset, length)
      : await this.#readSequential(offset, length);
    this.onRead?.(out.length);
    return out;
  }

  /** 兼容别名（历史调用方） */
  get byteLength() { return this.size; }

  async #readViaSlice(offset, length) {
    // OOB 检查已上提至 read() 入口（slice/sequential 一致）
    const end = Math.min(offset + length, this.size || Infinity);
    const sliced = this.file.slice(offset, end);
    // 兼容多种返回：ArrayBuffer / TypedArray / Blob 式（有 arrayBuffer()）
    if (sliced instanceof ArrayBuffer) return new Uint8Array(sliced);
    if (ArrayBuffer.isView(sliced)) {
      return new Uint8Array(sliced.buffer, sliced.byteOffset, sliced.byteLength);
    }
    if (typeof sliced.arrayBuffer === 'function') {
      const buf = await sliced.arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new TorrentSourceError('file.slice() 返回类型不受支持', 'BAD_SLICE');
  }

  async #readSequential(offset, length) {
    this.#ensureReader();

    // 向后越界：重启流丢弃至目标偏移（慢路径）；超限直接拒绝以防无界缓冲
    if (offset < this.#bufferStart) {
      const distance = this.#bufferStart - offset;
      if (distance > this.maxBackfillBytes) {
        throw new TorrentSourceError(
          `向后读取距离 ${distance}B 超过上限 ${this.maxBackfillBytes}B，请改用支持 slice 的源`,
          'BACKWARD_LIMIT',
        );
      }
      await this.#restartAndDiscard(offset);
    }

    const parts = [];
    let cur = offset;
    let need = length;

    while (need > 0) {
      // 先吃掉既有缓冲中可用的部分（可能跨多个块）
      if (cur >= this.#bufferStart && cur < this.#bufferedEnd) {
        while (this.#buffer.length && need > 0) {
          const first = this.#buffer[0];
          const rel = cur - this.#bufferStart;
          if (rel >= first.length) {
            // 整块已越过消费点：弹出
            this.#buffer.shift();
            this.#bufferStart += first.length;
            continue;
          }
          const take = Math.min(first.length - rel, need);
          parts.push(first.subarray(rel, rel + take));
          cur += take;
          need -= take;
          break;
        }
        if (need > 0 && cur >= this.#bufferedEnd) continue; // 缓冲恰好用尽，继续拉流
        if (need <= 0) break;
      }

      // 缓冲不含当前游标：继续拉流前进
      const { done, value } = await this.#reader.read();
      if (done) break; // EOF：返回已有部分
      if (!value || value.length === 0) continue; // 防零长块死循环
      this.#pushChunk(value);
    }

    return concat(parts);
  }

  #ensureReader() {
    if (this.#reader === null) {
      const stream = this.file.stream(); // WHATWG ReadableStream
      this.#reader = stream.getReader();
    }
  }

  #pushChunk(value) {
    if (this.#buffer.length === 0) this.#bufferStart = this.#bufferedEnd === 0 ? 0 : this.#bufferedEnd;
    this.#buffer.push(value);
    this.#bufferedEnd += value.length;
  }

  /** 关闭当前流、清空缓冲后重新打开并丢弃到 target 偏移 */
  async #restartAndDiscard(target) {
    try { await this.#reader.cancel(); } catch { /* 忽略 */ }
    this.#reader = null;
    this.#buffer = [];
    this.#bufferStart = 0;
    this.#bufferedEnd = 0;
    this.#ensureReader();

    // 线性丢弃直到缓冲终点 ≥ target
    while (this.#bufferedEnd < target) {
      const { done, value } = await this.#reader.read();
      if (done) break; // 目标越界：后续按 EOF 处理
      this.#pushChunk(value);
      // 立即释放已越过目标的旧块以外内容由主循环统一弹出
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#reader?.cancel?.(); } catch { /* 忽略 */ }
    this.#reader = null;
    this.#buffer = [];
  }
}

/** 工厂：返回符合 MediaByteSource 契约的源 */
export function createTorrentSource(file, opts) {
  return new TorrentFileSource(file, opts);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
