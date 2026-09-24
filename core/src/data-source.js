/**
 * 数据源抽象：demuxer 不关心字节来自内存、File 还是 HTTP Range。
 *
 * DataSource 协议（异步）：
 *   - size: Promise<number> | number  总字节数（未知时为 Infinity，如直播流；渐进 MP4 必须已知）
 *   - read(offset, length): Promise<Uint8Array>   返回恰好 length 字节
 */
import { sourceError } from './errors.js';
import { DEFAULT_MAX_READ_BYTES } from './limits.js';

function toChunkView(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (Object.prototype.toString.call(chunk) === '[object ArrayBuffer]') return new Uint8Array(chunk);
  if (Object.prototype.toString.call(chunk) === '[object DataView]' || (ArrayBuffer.isView(chunk) && chunk.BYTES_PER_ELEMENT === 1)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw sourceError('ChunkBuffer append expects a byte buffer or byte view');
}

function validateReadRange(offset, length, size, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size ||
      (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > DEFAULT_MAX_READ_BYTES))) {
    throw sourceError(`${label} out of range: offset=${offset}, length=${length}`);
  }
  const count = length === undefined ? size - offset : length;
  const requestedEnd = offset + count;
  if (!Number.isSafeInteger(requestedEnd)) throw sourceError(`${label} range is not a safe integer`);
  if (label === 'read' && requestedEnd > size) throw sourceError(`${label} out of range: [${offset}, ${requestedEnd}) of ${size}`);
  return { start: offset, end: Math.min(size, requestedEnd), count };
}

/** 内存数据源：测试与"整文件拖入"场景 */
export class MemoryDataSource {
  /** @param {Uint8Array|ArrayBuffer} bytes */
  constructor(bytes) {
    this.bytes = toChunkView(bytes);
    this.size = this.bytes.byteLength;
    this.uri = 'memory';
  }

  async open() {}

  async read(offset, length = undefined) {
    const { start, end } = validateReadRange(offset, length, this.bytes.byteLength, 'read');
    return this.bytes.subarray(start, end);
  }

  async close() {}
}

/** File/Blob 数据源：本地拖入场景（浏览器环境） */
export class BlobDataSource {
  /** @param {Blob|File} blob */
  constructor(blob, name = '') {
    if (typeof Blob === 'undefined') {
      throw sourceError('Blob is not available in this environment');
    }
    if (!(blob instanceof Blob)) throw sourceError('BlobDataSource expects a Blob or File');
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw sourceError('Blob size must be a non-negative safe integer');
    if (typeof name !== 'string') throw sourceError('BlobDataSource name must be a string');
    this.blob = blob;
    this.size = blob.size;
    this.name = name || blob.name || 'blob';
    this.uri = `file:${this.name}`;
  }

  async open() {}

  async read(offset, length = undefined) {
    const { start, end } = validateReadRange(offset, length, this.blob.size, 'blob read');
    const slice = this.blob.slice(start, end);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }

  async close() {}
}

/**
 * 把任意 {read,size} 对象适配为 DataSource（鸭子类型兼容），
 * mp4 的 RangeLoader / mkv 的网络流都可直接传入。
 */
export function asDataSource(sourceLike) {
  if (typeof sourceLike?.read !== 'function') {
    throw new TypeError('not a DataSource: missing read(offset, length)');
  }
  const size = sourceLike.size;
  const isPromiseLike = size !== null && typeof size === 'object' && typeof size.then === 'function';
  if (size !== undefined && size !== Infinity && !isPromiseLike && (!Number.isSafeInteger(size) || size < 0)) {
    throw sourceError(`DataSource size must be a non-negative safe integer, Infinity, or Promise: ${size}`);
  }
  return sourceLike;
}

/**
 * ChunkBuffer：把流式 ChunkSource（契约 §2.1：write(chunk)/end(err?)）聚合为
 * 可随机读的缓冲，供直播型容器（ts/flv/hls 网关流）在拉取语义下消费。
 *
 * - append 追加块（内部持有引用，不拷贝——块由调用方保证不再改写）；
 * - end() 后 size 固化；未 end 时 read 到"尚不足"区间抛 SOURCE_ERROR（背压语义）；
 * - read(offset,length) 返回恰好 length 字节的拷贝。
 */
export class ChunkBuffer {
  constructor() {
    /** @type {Uint8Array[]} */
    this._chunks = [];
    /** @type {number[]} 每块的起始全局偏移 */
    this._starts = [];
    this._len = 0;
    this._ended = false;
    this._endError = null;
  }

  /** @param {Uint8Array} chunk */
  append(chunk) {
    if (this._ended) throw sourceError('ChunkBuffer already ended');
    const u8 = toChunkView(chunk);
    if (u8.byteLength === 0) return this;
    if (!Number.isSafeInteger(this._len + u8.byteLength)) throw sourceError('ChunkBuffer size exceeds safe integer range');
    this._starts.push(this._len);
    this._chunks.push(u8);
    this._len += u8.byteLength;
    return this;
  }

  end(error = undefined) {
    if (this._ended) throw sourceError('ChunkBuffer already ended');
    if (error !== undefined && error !== null && !(error instanceof Error)) {
      throw sourceError('ChunkBuffer end error must be an Error');
    }
    this._endError = error ?? null;
    this._ended = true;
    return this;
  }

  get ended() {
    return this._ended;
  }

  get size() {
    return this._len;
  }

  /** @returns {Promise<Uint8Array>} 恰好 length 字节 */
  async read(offset, length = undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this._len) {
      throw sourceError(`ChunkBuffer read out of range: offset=${offset} size=${this._len}`);
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw sourceError(`ChunkBuffer read length out of range: length=${length}`);
    }
    const want = length === undefined ? this._len - offset : length;
    if (!Number.isSafeInteger(offset + want) || offset + want > this._len) {
      if (this._ended && this._endError) throw this._endError;
      throw sourceError(
        this._ended
          ? `ChunkBuffer read beyond end: need ${want} at ${offset}, available ${this._len - offset}`
          : `ChunkBuffer not enough data yet: need ${want} at ${offset}, available ${this._len - offset}`,
      );
    }
    // 定位起始块（线性即可；后续可换前缀和+二分）
    let i = 0;
    while (i + 1 < this._chunks.length && this._starts[i + 1] <= offset) i++;
    const out = new Uint8Array(want);
    let filled = 0;
    while (filled < want && i < this._chunks.length) {
      const chunk = this._chunks[i];
      const within = offset + filled - this._starts[i];
      if (within >= chunk.byteLength) {
        i++;
        continue;
      }
      const n = Math.min(chunk.byteLength - within, want - filled);
      out.set(chunk.subarray(within, within + n), filled);
      filled += n;
      i++;
    }
    return out;
  }
}
