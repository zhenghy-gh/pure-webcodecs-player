/**
 * tag-stream.js —— FLV 低层遍历接口（供 rtmp/WebSocket-FLV 模块直接复用）
 *
 * 本文件是「解析地基」的对外最小面：
 *   - parseFlvHeader(bytes)   解析 9 字节文件头（含音视频标志），非法返回 null；
 *   - FlvTagStream            流式 Tag 遍历器：push(chunk) 返回本次凑齐的完整 Tag，
 *                             end() 标记流结束；支持中途跳过文件头（seek 续传场景）；
 *   - iterateTags(bytes)      对完整字节串的一次性生成器遍历。
 *
 * Tag 形状（纯数据、无任何媒体语义）：
 *   { type: 8|9|18, timestamp: number(ms, 含扩展位), data: Uint8Array, offset: number }
 *   offset 为该 Tag 头起始的绝对偏移（首个 push 的首字节记为 0；可改写 baseOffset 平移原点）。
 *
 * 上层语义（AMF0/onMetaData、AVC 序列头、AAC ASC 等）见 ./flv-parser.js，
 * 其分帧即由本模块承载——两层行为一致性由同一份代码保证。
 */

/** Tag 类型 */
export const FLV_TAG_AUDIO = 8;
export const FLV_TAG_VIDEO = 9;
export const FLV_TAG_SCRIPT = 18;

const HEADER_SIZE = 9;        // 'FLV'+version+flags+DataOffset
const PROLOGUE_SIZE = 13;     // Header + PreviousTagSize0
const TAG_HEADER_SIZE = 11;

/**
 * 解析 FLV 文件头。
 * @param {Uint8Array} bytes 至少 9 字节
 * @returns {{version:number, hasAudio:boolean, hasVideo:boolean,
 *            flags:number, dataOffset:number}|null} 非法返回 null
 */
export function parseFlvHeader(bytes) {
  if (!bytes || bytes.byteLength < HEADER_SIZE) return null;
  if (!(bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56)) return null;
  return {
    version: bytes[3],
    hasAudio: (bytes[4] & 0x04) !== 0,
    hasVideo: (bytes[4] & 0x01) !== 0,
    flags: bytes[4],
    dataOffset: ((bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]) >>> 0,
  };
}

/**
 * 流式 Tag 遍历器。
 * 用法（WebSocket-FLV 场景示例）：
 *   const ts = new FlvTagStream();
 *   ws.onmessage = (e) => {
 *     for (const tag of ts.push(new Uint8Array(e.data))) handle(tag);
 *   };
 */
export class FlvTagStream {
  constructor() {
    /** @type {Uint8Array} 未消费缓冲 */
    this.buffer = new Uint8Array(0);
    /** 文件头信息（首个 push 后可用） */
    this.header = null;
    this.headerDone = false;
    this.finished = false;
    /** 批次原点平移：seek/续传场景由调用方设置（默认 0） */
    this.baseOffset = 0;
    this._batchFed = 0;
    /** 本流累计已消费字节数（offset 计算基准，跨批次连续） */
    this._absPos = 0;
  }

  /**
   * 喂入任意大小分片，返回本次凑齐的完整 Tag 数组。
   * @param {Uint8Array|ArrayBuffer} chunk
   * @returns {Array<{type:number,timestamp:number,data:Uint8Array,offset:number}>}
   */
  push(chunk) {
    const out = [];
    if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    if (chunk.length === 0 || this.finished) return out;

    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this._batchFed = 0;
    const batchOrigin = this._absPos;

    // ---- 文件头 ----
    if (!this.headerDone) {
      if (this.buffer.length < PROLOGUE_SIZE) return out;
      const header = parseFlvHeader(this.buffer);
      if (!header) throw new Error('FLV: 魔数不匹配，不是合法的 FLV 文件');
      const prologue = header.dataOffset >= HEADER_SIZE ? header.dataOffset : HEADER_SIZE;
      if (this.buffer.length < prologue + 4) return out;
      this.header = header;
      this._take(prologue);
      this._take(4);                    // PreviousTagSize0
      this.headerDone = true;
    }

    // ---- Tag 循环 ----
    while (this.buffer.length >= TAG_HEADER_SIZE) {
      const o = this._batchFed;
      const type = this.buffer[0];
      const dataSize = (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
      const timestamp =
        (this.buffer[4] << 16) | (this.buffer[5] << 8) | this.buffer[6] |
        (this.buffer[7] << 24);         // TimestampExtended 为最高 8 位
      if (dataSize > 128 * 1024 * 1024) {
        throw new Error(`FLV: Tag 数据过大(${dataSize})，疑似损坏流`);
      }
      const total = TAG_HEADER_SIZE + dataSize + 4;
      if (this.buffer.length < total) break;

      const data = this.buffer.subarray(TAG_HEADER_SIZE, TAG_HEADER_SIZE + dataSize).slice();
      this._take(total);
      out.push({ type, timestamp: timestamp >>> 0, data, offset: this.baseOffset + batchOrigin + o });
    }
    return out;
  }

  /** 标记流结束（截断尾部被丢弃） */
  end() {
    this.finished = true;
  }

  /**
   * seek 续传准备：跳过文件头，从指定位置继续吃 Tag。
   * @param {{hasAudio:boolean, hasVideo:boolean}} flags
   */
  resumeMidStream(flags) {
    this.buffer = new Uint8Array(0);
    this.headerDone = true;
    this.finished = false;
    this._batchFed = 0;
    this.header = {
      version: 1,
      hasAudio: !!flags.hasAudio,
      hasVideo: !!flags.hasVideo,
      flags: (flags.hasAudio ? 0x04 : 0) | (flags.hasVideo ? 0x01 : 0),
      dataOffset: HEADER_SIZE,
    };
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.header = null;
    this.headerDone = false;
    this.finished = false;
    this._batchFed = 0;
    this._absPos = 0;
  }

  _take(n) {
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.slice(n);
    this._batchFed += n;
    this._absPos += n;
    return out;
  }
}

/**
 * 对完整字节串的一次性 Tag 遍历（工具场景）。
 * @param {Uint8Array} bytes 完整 FLV 文件
 */
export function* iterateTags(bytes) {
  if (!bytes || bytes.byteLength < PROLOGUE_SIZE) return;
  const header = parseFlvHeader(bytes);
  if (!header) return;
  const prologue = header.dataOffset >= HEADER_SIZE ? header.dataOffset : HEADER_SIZE;
  let pos = prologue + 4;                       // 跳过 PreviousTagSize0
  while (pos + TAG_HEADER_SIZE <= bytes.length) {
    const dataSize = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const timestamp =
      (bytes[pos + 4] << 16) | (bytes[pos + 5] << 8) | bytes[pos + 6] |
      (bytes[pos + 7] << 24);
    const total = TAG_HEADER_SIZE + dataSize + 4;
    if (pos + total > bytes.length) return;     // 尾部截断：丢弃半包
    yield {
      type: bytes[pos],
      timestamp: timestamp >>> 0,
      data: bytes.subarray(pos + TAG_HEADER_SIZE, pos + TAG_HEADER_SIZE + dataSize),
      offset: pos,
    };
    pos += total;
  }
}
