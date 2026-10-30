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

function cancelResponseBody(res) {
  try {
    Promise.resolve(res.body?.cancel?.()).catch(() => {});
  } catch { /* 尽力清理，不覆盖请求结果，也不等待取消完成 */ }
}

function mergeHeaders(...sources) {
  const merged = new Map();
  for (const source of sources) {
    if (source == null) continue;
    const layer = new Map();
    const add = (name, value) => {
      const key = String(name).toLowerCase();
      const previous = layer.get(key);
      layer.set(key, previous ? [previous[0], String(previous[1]) + ', ' + String(value)] : [String(name), value]);
    };
    if (Array.isArray(source)) {
      for (const [name, value] of source) add(name, value);
    } else if (typeof source.forEach === 'function') {
      source.forEach((value, name) => add(name, value));
    } else {
      for (const [name, value] of Object.entries(source)) add(name, value);
    }
    for (const [key, entry] of layer) merged.set(key, entry);
  }
  return Object.fromEntries(merged.values());
}

export class HttpRangeDataSource {
  /**
   * @param {string} url
   * @param {{
   *   chunkSize?: number, maxCachedBlocks?: number,
   *   headers?: object, requestInit?: object,
   *   fetchImpl?: typeof fetch,
   *   maxReadLength?: number,
   * }} [options]
   *   chunkSize：正安全整数；maxCachedBlocks：非负安全整数或 Infinity，0 禁用缓存。
   *   maxReadLength：单次 read 的字节上界（默认 64MB），防畸形长度字段触发超大 Range 请求
   */
  constructor(url, options = {}) {
    // I5：file:/blob:/data:/javascript: 一律拒绝，且抛封闭错误码而非 TypeError
    this.url = assertSafeUrl(url, { what: 'HTTP Range 数据源', code: 'source' });
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
    this.maxCachedBlocks = options.maxCachedBlocks ?? 64;
    if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw sourceError('chunkSize must be a positive safe integer');
    }
    if (this.maxCachedBlocks !== Infinity
      && (!Number.isSafeInteger(this.maxCachedBlocks) || this.maxCachedBlocks < 0)) {
      throw sourceError('maxCachedBlocks must be a non-negative safe integer or Infinity');
    }
    this.maxReadLength = options.maxReadLength ?? DEFAULT_MAX_READ_BYTES;
    this.headers = options.headers ?? {};
    this.requestInit = options.requestInit ?? {};
    this._fetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof this._fetch !== 'function') {
      throw sourceError('fetch is not available in this environment');
    }
    /** @type {Map<number, Uint8Array>} LRU：Map 保插入序，命中即重插 */
    this._cache = new Map();
    this._cacheGeneration = 0;
    this.size = Infinity;
    this.uri = url;
    this.acceptRanges = false;
    this._opened = false;
  }

  _requestInit(headers = undefined, init = {}) {
    const { headers: requestHeaders, ...requestInit } = this.requestInit;
    return {
      ...requestInit,
      ...init,
      headers: mergeHeaders(this.headers, requestHeaders, headers),
    };
  }
  async open() {
    if (this._opened) return;
    // 先试 HEAD
    try {
      const res = await this._fetch(this.url, this._requestInit(undefined, { method: 'HEAD' }));
      if (res.ok) {
        const rawLength = res.headers.get('content-length');
        const len = rawLength != null && /^[0-9]+$/.test(rawLength.trim()) ? Number(rawLength) : NaN;
        if (Number.isSafeInteger(len) && len >= 0) {
          this.size = len;
          this.acceptRanges = (res.headers.get('accept-ranges') ?? '').includes('bytes');
        }
      }
    } catch {
      /* HEAD 可能不被允许，继续用 Range GET 探测 */
    }

    if (!Number.isFinite(this.size)) {
      // 退路：GET 首字节，从 Content-Range 里拿总长
      const res = await this._fetch(this.url, this._requestInit({ Range: 'bytes=0-0' }));
      try {
        if (res.status !== 206) {
          throw sourceError(
            'server does not support HTTP Range probe (expected 206, got ' + res.status + ') for ' + this.url,
            { status: res.status },
          );
        }
        const contentRange = res.headers.get('content-range');
        if (!contentRange) {
          throw sourceError(
            'server does not support HTTP Range for ' + this.url + '; progressive MP4 requires it',
            { status: res.status },
          );
        }
        const match = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange.trim());
        const total = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(total) || total < 1) {
          throw sourceError('cannot determine file size from Content-Range: ' + contentRange,
            { status: res.status });
        }
        this.size = total;
        this.acceptRanges = true;
      } finally {
        cancelResponseBody(res);
      }
    }
    this._opened = true;
  }

  /** @returns {Promise<Uint8Array>} 恰好 length 字节 */
  async read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw sourceError(`read out of range: offset=${String(offset)}`);
    }
    const cacheGeneration = this._cacheGeneration;
    if (!this._opened) await this.open();
    if (offset < 0 || offset >= this.size) {
      throw sourceError(`read out of range: offset=${offset} size=${this.size}`);
    }
    // I5：单次读取上界——畸形容器长度字段不得触发超大 Range 请求与内存分配
    assertByteLength(length, this.maxReadLength, `HTTP Range 单次读取`);
    const want = Math.min(length, this.size - offset);

    const firstBlock = Math.floor(offset / this.chunkSize);
    const lastBlock = Math.floor((offset + want - 1) / this.chunkSize);
    const missingRuns = [];
    const blocks = new Map();
    let missingStart = null;
    for (let b = firstBlock; b <= lastBlock; b++) {
      const cached = this._cache.get(b);
      if (cached) {
        blocks.set(b, cached);
        this._touch(b, cached);
        if (missingStart !== null) {
          missingRuns.push([missingStart, b - 1]);
          missingStart = null;
        }
      } else if (missingStart === null) {
        missingStart = b;
      }
    }
    if (missingStart !== null) missingRuns.push([missingStart, lastBlock]);

    for (const [start, end] of missingRuns) await this._prefetch(start, end, blocks, cacheGeneration);
    return this._assemble(offset, want, blocks);
  }

  async _prefetch(firstBlock, lastBlock, blocks = null, cacheGeneration = this._cacheGeneration) {
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
      const stored = blockBytes.slice();
      blocks?.set(b, stored);
      if (cacheGeneration === this._cacheGeneration) this._put(b, stored);
    }
  }

  async _rangeGet(start, endInclusive) {
    const res = await this._fetch(this.url, this._requestInit({ Range: `bytes=${start}-${endInclusive}` }));
    if (res.status !== 206 && res.status !== 200) {
      cancelResponseBody(res);
      throw sourceError(`range request failed (${res.status}) for ${this.url}`);
    }
    if (res.status === 200 && start > 0) {
      // 不支持 Range 的服务器返回整文件 200 —— 对渐进加载是硬错误
      cancelResponseBody(res);
      throw sourceError(`server ignored Range header (got 200) for ${this.url}`);
    }
    if (res.status === 206) {
      const contentRange = res.headers.get('content-range');
      // 跨域可能未暴露此响应头；可见时校验，避免错位数据进入缓存。
      if (contentRange != null) {
        const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange.trim());
        const actualStart = match ? Number(match[1]) : NaN;
        const actualEnd = match ? Number(match[2]) : NaN;
        if (!Number.isSafeInteger(actualStart) || !Number.isSafeInteger(actualEnd)
          || actualStart !== start || actualEnd !== endInclusive) {
          cancelResponseBody(res);
          throw sourceError(
            `Content-Range mismatch: expected bytes ${start}-${endInclusive}, got ${contentRange}`,
          );
        }
      }
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

  _assemble(offset, length, blocks = this._cache) {
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const abs = offset + pos;
      const blockIdx = Math.floor(abs / this.chunkSize);
      const block = blocks.get(blockIdx);
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
    this._cacheGeneration += 1;
    this._cache.clear();
  }
}
