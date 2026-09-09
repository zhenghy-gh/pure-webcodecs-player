/**
 * HTTP Range 渐进加载数据源。
 *
 * 实现 DataSource 协议（{size, read(offset,length)}），可直接 attach 给 Mp4Demuxer：
 * - 打开时探测文件总长（HEAD → 失败退回 GET bytes=0-0 解析 Content-Range）；
 * - 按块（默认 256KB）拉取 + LRU 缓存，moov 在尾部的文件也能只拉需要的字节；
 * - 服务器不支持 Range 时抛 SOURCE_ERROR 并给出明确提示。
 */
import { sourceError } from './errors.js';
import { assertSafeUrl } from './url-guard.js';
import { DEFAULT_MAX_READ_BYTES, assertByteLength } from './limits.js';

const DEFAULT_CHUNK = 1 << 18; // 256KB

export class HttpRangeDataSource {
  /**
   * @param {string} url
   * @param {{
   *   chunkSize?: number, maxCachedBlocks?: number,
   *   headers?: object, requestInit?: object,
   *   fetchImpl?: typeof fetch,
   *   maxReadLength?: number,
   * }} [options]
   *   maxReadLength：单次 read 的字节上界（默认 64MB），防畸形长度字段触发超大 Range 请求
   */
  constructor(url, options = {}) {
    // I5：file:/blob:/data:/javascript: 一律拒绝，且抛封闭错误码而非 TypeError
    this.url = assertSafeUrl(url, { what: 'HTTP Range 数据源', code: 'source' });
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
    this.maxCachedBlocks = options.maxCachedBlocks ?? 64;
    this.maxReadLength = options.maxReadLength ?? DEFAULT_MAX_READ_BYTES;
    this.headers = options.headers ?? {};
    this.requestInit = options.requestInit ?? {};
    this._fetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof this._fetch !== 'function') {
      throw sourceError('fetch is not available in this environment');
    }
    /** @type {Map<number, Uint8Array>} LRU：Map 保插入序，命中即重插 */
    this._cache = new Map();
    this.size = Infinity;
    this.uri = url;
    this.acceptRanges = false;
    this._opened = false;
  }

  async open() {
    if (this._opened) return;
    // 先试 HEAD
    try {
      const res = await this._fetch(this.url, {
        method: 'HEAD',
        headers: { ...this.headers },
        ...this.requestInit,
      });
      if (res.ok) {
        const len = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(len)) {
          this.size = len;
          this.acceptRanges = (res.headers.get('accept-ranges') ?? '').includes('bytes');
        }
      }
    } catch {
      /* HEAD 可能不被允许，继续用 Range GET 探测 */
    }

    if (!Number.isFinite(this.size)) {
      // 退路：GET 首字节，从 Content-Range 里拿总长
      const res = await this._fetch(this.url, {
        headers: { ...this.headers, Range: 'bytes=0-0' },
        ...this.requestInit,
      });
      const contentRange = res.headers.get('content-range');
      if (!contentRange) {
        throw sourceError(
          `server does not support HTTP Range for ${this.url}; progressive MP4 requires it`,
          { status: res.status },
        );
      }
      const total = Number(contentRange.split('/')[1]);
      if (!Number.isFinite(total)) {
        throw sourceError(`cannot determine file size from Content-Range: ${contentRange}`);
      }
      this.size = total;
      this.acceptRanges = true;
      try {
        res.body?.cancel?.();
      } catch {
        /* 忽略 */
      }
    }
    this._opened = true;
  }

  /** @returns {Promise<Uint8Array>} 恰好 length 字节 */
  async read(offset, length) {
    if (!this._opened) await this.open();
    if (offset < 0 || offset >= this.size) {
      throw sourceError(`read out of range: offset=${offset} size=${this.size}`);
    }
    // I5：单次读取上界——畸形容器长度字段不得触发超大 Range 请求与内存分配
    assertByteLength(length, this.maxReadLength, `HTTP Range 单次读取`);
    const want = Math.min(length, this.size - offset);

    // 命中检查：全部落在缓存则直接拼
    const firstBlock = Math.floor(offset / this.chunkSize);
    const lastBlock = Math.floor((offset + want - 1) / this.chunkSize);
    const blocks = [];
    let allCached = true;
    for (let b = firstBlock; b <= lastBlock; b++) {
      const cached = this._cache.get(b);
      if (cached) {
        blocks.push(cached);
        this._touch(b, cached);
      } else {
        allCached = false;
        break;
      }
    }

    if (!allCached) {
      await this._prefetch(firstBlock, lastBlock);
      return this._assemble(offset, want);
    }
    return this._assemble(offset, want);
  }

  async _prefetch(firstBlock, lastBlock) {
    // 连续块合并为一次 Range 请求，减少请求数
    const start = firstBlock * this.chunkSize;
    const endInclusive = Math.min(lastBlock * this.chunkSize + this.chunkSize - 1, this.size - 1);
    const bytes = await this._rangeGet(start, endInclusive);
    // 切块入缓存
    for (let b = firstBlock; b <= lastBlock; b++) {
      const blockStart = b * this.chunkSize;
      const relStart = blockStart - start;
      if (relStart >= bytes.byteLength) break;
      const blockBytes = bytes.subarray(relStart, Math.min(relStart + this.chunkSize, bytes.byteLength));
      this._put(b, blockBytes.slice());
    }
  }

  async _rangeGet(start, endInclusive) {
    const res = await this._fetch(this.url, {
      headers: { ...this.headers, Range: `bytes=${start}-${endInclusive}` },
      ...this.requestInit,
    });
    if (res.status !== 206 && res.status !== 200) {
      throw sourceError(`range request failed (${res.status}) for ${this.url}`);
    }
    if (res.status === 200 && start > 0) {
      // 不支持 Range 的服务器返回整文件 200 —— 对渐进加载是硬错误
      try {
        res.body?.cancel?.();
      } catch {
        /* 忽略 */
      }
      throw sourceError(`server ignored Range header (got 200) for ${this.url}`);
    }
    const buf = await res.arrayBuffer();
    if (res.status === 206) {
      const got = buf.byteLength;
      const expected = endInclusive - start + 1;
      if (got < expected && start + got < this.size) {
        throw sourceError(`short range response: got ${got}, want ${expected}`);
      }
      return new Uint8Array(buf).subarray(0, Math.min(got, expected));
    }
    // 200 整文件响应且 start=0：直接可用
    return new Uint8Array(buf).subarray(start, Math.min(endInclusive + 1, buf.byteLength));
  }

  _assemble(offset, length) {
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const abs = offset + pos;
      const blockIdx = Math.floor(abs / this.chunkSize);
      const block = this._cache.get(blockIdx);
      if (!block) throw sourceError(`internal: missing block ${blockIdx}`);
      const within = abs - blockIdx * this.chunkSize;
      const n = Math.min(block.byteLength - within, length - pos);
      out.set(block.subarray(within, within + n), pos);
      pos += n;
    }
    return out;
  }

  _put(index, block) {
    this._cache.set(index, block);
    this._evict();
  }

  _touch(index, block) {
    this._cache.delete(index);
    this._cache.set(index, block);
  }

  _evict() {
    while (this._cache.size > this.maxCachedBlocks) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  async close() {
    this._cache.clear();
  }
}
