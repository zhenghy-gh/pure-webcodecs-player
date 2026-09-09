/**
 * source.js —— Demuxer 输入字节源抽象（MediaByteSource 契约提案）
 *
 * 契约（建议写入 docs/CONTRACTS.md，供各容器模块与 core 共用）：
 *   {
 *     byteLength: number | null,        // 未知则为 null（流式）
 *     read(offset, length) -> Promise<Uint8Array>,  // 必须返回恰好 length 字节；仅 EOF 处允许不足
 *     close?(): void,
 *   }
 *
 * 提供三个适配器：
 *   BufferSource —— 内存 Uint8Array/ArrayBuffer
 *   BlobSource   —— 浏览器 File / Blob（按需 slice，零拷贝窗口）
 *   FetchSource  —— HTTP(S)：支持 Range 则随机读；否则退化为顺序流缓冲
 */

import { PlayerError } from '../../core/src/errors.js';

/**
 * 数据源错误：契约 §11.3 十码中的 SOURCE_ERROR 家族
 * （继承 core PlayerError，instanceof PlayerError 成立，消费方按 code 分支即可）
 */
export class SourceError extends PlayerError {
  constructor(message, subCode) {
    super('SOURCE_ERROR', message, { detail: subCode ? { reason: subCode } : undefined });
    this.name = 'SourceError';
  }
}

/** 内存源 */
export class BufferSource {
  /** @param {Uint8Array|ArrayBuffer} data */
  constructor(data) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.byteLength = this.bytes.length;
  }
  /** 契约 §2.1 DataSource 字段名（size；byteLength 为兼容别名） */
  get size() { return this.bytes.length; }
  async read(offset, length) {
    if (offset < 0 || length < 0) throw new SourceError('read 参数非法');
    if (length === 0) return new Uint8Array(0);
    if (offset >= this.bytes.length) {
      throw new SourceError(`越界读取: offset=${offset} ≥ size=${this.bytes.length}`, 'OUT_OF_RANGE');
    }
    const end = offset + length;
    if (end > this.bytes.length) {
      // 尾部短读（EOF 信号）：起点在界内、窗口跨过末尾
      return this.bytes.subarray(offset, this.bytes.length);
    }
    return this.bytes.subarray(offset, end);
  }
  close() { /* 内存源无需释放 */ }
}

/** File/Blob 源（浏览器 File 继承 Blob） */
export class BlobSource {
  /** @param {Blob} blob */
  constructor(blob) {
    if (typeof blob?.slice !== 'function') {
      throw new SourceError('BlobSource 需要 Blob/File 对象', 'BAD_BLOB');
    }
    this.blob = blob;
    this.byteLength = blob.size;
  }
  /** 契约 §2.1 DataSource 字段名 */
  get size() { return this.blob.size; }
  async read(offset, length) {
    if (offset >= this.byteLength) {
      throw new SourceError(`越界读取: offset=${offset} ≥ size=${this.byteLength}`, 'OUT_OF_RANGE');
    }
    const sliced = this.blob.slice(offset, Math.min(offset + length, this.byteLength));
    const buf = await sliced.arrayBuffer();
    return new Uint8Array(buf);
  }
  close() { /* GC 回收 */ }
}

/**
 * HTTP 源。
 * - 服务端支持 Accept-Ranges：按需发 Range 请求（带小窗口预取，减少请求数）；
 * - 不支持：退化为顺序读取流，仅允许向前读（向后 seek 抛错并提示）。
 */
export class FetchSource {
  /**
   * @param {string} url
   * @param {{chunkBytes?:number, fetchImpl?:typeof fetch, headers?:Object}} opts
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.chunkBytes = opts.chunkBytes ?? 1 << 20; // 1MiB 预取窗
    this.extraHeaders = opts.headers ?? {};
    this.byteLength = null; // open() 后填充
    this._sizeCache = null;
    this.acceptRanges = false;
    this.contentType = null;
    // 顺序回退模式状态
    this.#mode = 'new';
    /** @type {ReadableStreamDefaultReader|null} */
    this.#reader = null;
    /** @type {Uint8Array[]} 已到达但未消费的块 */
    this.#chunks = [];
    this.#streamOffset = 0; // #chunks 覆盖的起始偏移
    this.#closed = false;
  }

  #mode; #reader; #chunks; #streamOffset; #closed;

  /** 探测头部信息（HEAD 失败自动退化 GET Range:0-0） */
  static async open(url, opts) {
    const src = new FetchSource(url, opts);
    await src.#probe();
    return src;
  }

  async #probe() {
    try {
      let res = await this.fetchImpl(this.url, {
        method: 'HEAD',
        headers: this.extraHeaders,
      });
      if (!res.ok) {
        res = await this.fetchImpl(this.url, {
          method: 'GET',
          headers: { ...this.extraHeaders, Range: 'bytes=0-0' },
        });
        if (!res.ok && res.status !== 206) {
          throw new SourceError(`HTTP ${res.status}: ${this.url}`, 'HTTP_BAD_STATUS');
        }
      }
      this.acceptRanges =
        (res.headers.get('accept-ranges') || '').includes('bytes') ||
        res.status === 206;
      const lenHeader = res.headers.get('content-length') ?? res.headers.get('content-range');
      if (lenHeader) {
        const m = /(\d+)\s*$/.exec(lenHeader.split('/')[1] ?? lenHeader);
        if (m) this.byteLength = Number(m[1]);
      this._sizeCache = this.byteLength;
      }
      this.contentType = res.headers.get('content-type');
      this.#mode = this.acceptRanges ? 'range' : 'sequential';
      await res.body?.cancel?.();
    } catch (err) {
      if (err instanceof TypeError) {
        // HEAD 可能被 CORS 拒绝：直接尝试顺序模式兜底
        this.#mode = 'sequential';
        return;
      }
      throw err;
    }
  }

  /** 契约 §2.1 DataSource 字段名 */
  get size() { return this._sizeCache ?? this.byteLength ?? null; }
  /** @returns {Promise<Uint8Array>} */
  async read(offset, length) {
    if (this.#closed) throw new SourceError('源已关闭', 'CLOSED');
    if (length <= 0) return new Uint8Array(0);
    if (this.byteLength !== null && offset >= this.byteLength) {
      throw new SourceError(`越界读取: offset=${offset} ≥ size=${this.byteLength}`, 'OUT_OF_RANGE');
    }
    if (this.#mode === 'new') await this.#probe(); // 惰性探测，允许直接 new 后使用

    if (this.#mode === 'range') return this.#readRange(offset, length);
    return this.#readSequential(offset, length);
  }

  async #readRange(offset, length) {
    const end = Math.min(offset + length - 1, (this.byteLength ?? Infinity) - 1);
    const res = await this.fetchImpl(this.url, {
      headers: { ...this.extraHeaders, Range: `bytes=${offset}-${end}` },
    });
    if (res.status !== 206) {
      // 服务器忽略 Range 回 200 整文件时，若当作目标窗口返回会让 demuxer 静默解析错位数据——必须显式失败
      throw new SourceError(
        `Range 请求未获 206（HTTP ${res.status}${res.status === 200 ? '，服务器疑似忽略 Range' : ''}）`,
        'RANGE_NOT_SATISFIABLE',
      );
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * 顺序模式：滑动缓冲向前读；向后请求超出缓冲时自动重启底层流并丢弃到目标
   * 偏移（慢路径，代价 = 重新 GET + 线性丢弃；契约语义保持正确优先）。
   */
  async #readSequential(offset, length) {
    if (this.#reader === null) {
      await this.#openStream();
    } else if (offset < this.#streamOffset) {
      await this.#restartAndDiscard(offset); // 回退：重建流
    }

    const parts = [];
    let cur = offset;
    let need = length;

    while (need > 0) {
      // 先吃既有缓冲（可跨块）
      if (cur >= this.#streamOffset && this.#chunks.length) {
        let consumed = false;
        while (this.#chunks.length && need > 0) {
          const first = this.#chunks[0];
          const rel = cur - this.#streamOffset;
          if (rel >= first.length) {
            this.#chunks.shift();
            this.#streamOffset += first.length;
            continue;
          }
          const take = Math.min(first.length - rel, need);
          parts.push(first.subarray(rel, rel + take));
          cur += take;
          need -= take;
          consumed = true;
          break;
        }
        if (need <= 0) break;
        if (consumed) continue;
      }
      const { done, value } = await this.#reader.read();
      if (done) break; // EOF：返回已有部分
      if (!value || value.length === 0) continue;
      this.#chunks.push(value);
    }
    return concatParts(parts, need > 0);
  }

  async #openStream() {
    const res = await this.fetchImpl(this.url, { headers: this.extraHeaders });
    if (!res.ok || !res.body) {
      throw new SourceError(`GET 失败 HTTP ${res.status}`, 'HTTP_BAD_STATUS');
    }
    this.#reader = res.body.getReader();
    this.#streamOffset = 0;
    this.#chunks = [];
  }

  /** 关闭当前流、清空缓冲后重新 GET，并线性丢弃至 target 偏移 */
  async #restartAndDiscard(target) {
    try { await this.#reader.cancel(); } catch { /* 忽略 */ }
    this.#reader = null;
    this.#chunks = [];
    this.#streamOffset = 0;
    await this.#openStream();
    let covered = 0;
    while (covered < target) {
      const { done, value } = await this.#reader.read();
      if (done) break;
      covered += value.length;
      if (covered <= target) continue; // 整块越过目标：直接丢弃
      this.#chunks.push(value);        // 跨目标块：保留供主循环切分
      this.#streamOffset = covered - value.length;
    }
    if (this.#chunks.length === 0) this.#streamOffset = covered;
  }

  close() {
    this.#closed = true;
    this.#reader?.cancel?.().catch(() => {});
    this.#reader = null;
    this.#chunks = [];
  }
}

function concatParts(parts, truncated) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  void truncated;
  return out;
}

/**
 * 工厂：把常见输入统一包装为 MediaByteSource。
 * 支持：Uint8Array / ArrayBuffer / Blob|File / string(URL) / 已实现契约的对象（原样返回）。
 */
export function createByteSource(input, opts) {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) return new BufferSource(input);
  if (typeof Blob !== 'undefined' && input instanceof Blob) return new BlobSource(input);
  if (typeof input === 'string') return new FetchSource(input, opts);
  if (input && typeof input.read === 'function') return input; // 已符合契约
  throw new SourceError('无法识别的输入源类型', 'BAD_SOURCE');
}
