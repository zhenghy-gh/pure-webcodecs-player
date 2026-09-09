/**
 * 数据源抽象：demuxer 不关心字节来自内存、File 还是 HTTP Range。
 *
 * DataSource 协议（异步）：
 *   - size: Promise<number> | number  总字节数（未知时为 Infinity，如直播流；渐进 MP4 必须已知）
 *   - read(offset, length): Promise<Uint8Array>   返回恰好 length 字节
 */
import { sourceError } from './errors.js';

/** 内存数据源：测试与"整文件拖入"场景 */
export class MemoryDataSource {
  /** @param {Uint8Array|ArrayBuffer} bytes */
  constructor(bytes) {
    this.bytes =
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.size = this.bytes.byteLength;
    this.uri = 'memory';
  }

  async open() {}

  async read(offset, length = undefined) {
    const start = offset;
    const end = length === undefined ? this.bytes.byteLength : offset + length;
    if (start < 0 || end > this.bytes.byteLength || start > end) {
      throw sourceError(`read out of range: [${start}, ${end}) of ${this.bytes.byteLength}`);
    }
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
    this.blob = blob;
    this.size = blob.size;
    this.name = name || blob.name || 'blob';
    this.uri = `file:${this.name}`;
  }

  async open() {}

  async read(offset, length = undefined) {
    const end = length === undefined ? this.blob.size : Math.min(this.blob.size, offset + length);
    if (offset < 0 || offset > this.blob.size) {
      throw sourceError(`read out of range: offset=${offset}`);
    }
    const slice = this.blob.slice(offset, end);
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
  if (typeof sourceLike?.read === 'function') return sourceLike;
  throw new TypeError('not a DataSource: missing read(offset, length)');
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
  }

  /** @param {Uint8Array} chunk */
  append(chunk) {
    if (this._ended) throw sourceError('ChunkBuffer already ended');
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (u8.byteLength === 0) return this;
    this._starts.push(this._len);
    this._chunks.push(u8);
    this._len += u8.byteLength;
    return this;
  }

  end() {
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
    if (offset < 0 || offset > this._len) {
      throw sourceError(`ChunkBuffer read out of range: offset=${offset} size=${this._len}`);
    }
    const want = length === undefined ? this._len - offset : length;
    if (offset + want > this._len) {
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
