/**
 * assembler.js —— 已校验 piece → 连续字节流装配器
 *
 * PRD 验收点名：「assembler 头部齐备即产前缀」「断 mock → 等待续传无异常」。
 *
 * 语义：
 *   - writePiece(index, bytes) 写入一个已校验 piece（长度必须等于该片声明大小，
 *     末片允许小于 pieceLength）；
 *   - 头部连续段每向前扩展一片，即产生可读前缀（prefixReady 立即为真）；
 *   - read(offset,length) 在所需 piece 未到齐时【挂起等待】而不是报错——
 *     对应 P2P 断流场景：等后续 piece 到达自动完成，不抛异常；
 *   - verifyPiece 可注入校验函数（(index,bytes)=>boolean），缺省跳过
 *     （网络路径的哈希校验由 webtorrent 库负责）。
 */

import { Emitter } from '../../core/src/emitter.js';
import { PlayerError } from '../../core/src/errors.js';

export class TorrentAssembler extends Emitter {
  /**
   * @param {{size:number, pieceLength:number, verifyPiece?:(index:number,bytes:Uint8Array)=>boolean}} spec
   */
  constructor({ size, pieceLength, verifyPiece = null }) {
    super();
    if (!Number.isInteger(size) || size < 0) throw new PlayerError('PARSE_ERROR', `非法 size: ${size}`);
    if (!Number.isInteger(pieceLength) || pieceLength <= 0) {
      throw new PlayerError('PARSE_ERROR', `非法 pieceLength: ${pieceLength}`);
    }
    this.size = size;
    this.pieceLength = pieceLength;
    this.numPieces = Math.max(1, Math.ceil(size / pieceLength));
    this.verifyPiece = verifyPiece;

    /** @type {Map<number,Uint8Array>} 已完成 piece */
    this.#done = new Map();
    /** 头部连续前缀已覆盖的字节数 */
    this._prefixBytes = 0;
    /** @type {Array<{needEnd:number, resolve:Function}>} 等头部推进的等待者 */
    this.#prefixWaiters = [];
    this._destroyed = false;
  }

  #done;
  #prefixWaiters;

  get progress() {
    return this.numPieces ? this.#done.size / this.numPieces : 1;
  }

  /** 头部连续前缀字节数（头部齐备即产前缀） */
  get prefixBytes() { return this._prefixBytes; }

  get complete() { return this.#done.size >= this.numPieces; }

  /** 某片是否已完成 */
  has(index) { return this.#done.has(index); }

  /**
   * 写入一个已下载（且已在库内校验）的 piece。
   * @returns {boolean} 是否被接受（重复/越界/毁坏返回 false，不抛）
   */
  writePiece(index, bytes) {
    if (this._destroyed) return false;
    if (!Number.isInteger(index) || index < 0 || index >= this.numPieces) return false;
    if (this.#done.has(index)) return false;
    const expected = index === this.numPieces - 1
      ? this.size - this.pieceLength * index // 末片可为部分长度
      : this.pieceLength;
    if (!(bytes instanceof Uint8Array) || bytes.length !== expected) return false;
    if (this.verifyPiece && !this.verifyPiece(index, bytes)) return false;

    this.#done.set(index, bytes);
    this.emit('piece', { index });
    if (this.complete) this.emit('complete', {});
    this.#advancePrefix();
    return true;
  }

  /** 头部连续前缀推进；唤醒所有等到新前缀的 read() */
  #advancePrefix() {
    let idx = Math.floor(this._prefixBytes / this.pieceLength);
    // 对齐：若 _prefixBytes 不是片界（末片截断），从所在片继续
    while (idx < this.numPieces && this.#done.has(idx)) {
      const piece = this.#done.get(idx);
      const pieceStart = idx * this.pieceLength;
      this._prefixBytes = Math.min(this.size, pieceStart + piece.length);
      idx += 1;
    }
    this.emit('prefix', { prefixBytes: this._prefixBytes });
    this.#prefixWaiters = this.#prefixWaiters.filter((w) => {
      if (this._prefixBytes >= w.needEnd) { w.resolve(); return false; }
      return true;
    });
  }

  /** 头部前缀是否覆盖 [offset, offset+length) */
  canReadNow(offset, length) {
    return offset + length <= this._prefixBytes || offset >= this.size;
  }

  /**
   * 读字节：所需数据在前缀内立即返回；否则等待头部推进到位（挂起不抛）。
   * @returns {Promise<Uint8Array>}
   */
  async read(offset, length) {
    if (this._destroyed) throw new PlayerError('STATE_ERROR', 'assembler 已销毁');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new PlayerError('SOURCE_ERROR', `read 参数非法: offset=${offset} length=${length}`);
    }
    if (length === 0) return new Uint8Array(0);
    // 契约 §2.1：完全越界 → reject SOURCE_ERROR（尾部跨末尾由调用方钳制后到达此处仍安全）
    if (offset >= this.size) {
      throw new PlayerError('SOURCE_ERROR', `越界读取: offset=${offset} ≥ size=${this.size}`);
    }

    const end = Math.min(offset + length, this.size);
    if (end > this._prefixBytes) {
      // 等待续传：挂起直至前缀覆盖目标区间（不抛错、不超时——由上层策略控制放弃）
      await new Promise((resolve) => this.#prefixWaiters.push({ needEnd: end, resolve }));
      if (this._destroyed) throw new PlayerError('ABORTED', 'assembler 在等待中被销毁');
      if (end > this._prefixBytes) {
        throw new PlayerError('SOURCE_ERROR', '前缀仍未覆盖目标区间');
      }
    }
    const out = new Uint8Array(end - offset);
    let cursor = offset;
    while (cursor < end) {
      const idx = Math.floor(cursor / this.pieceLength);
      const piece = this.#done.get(idx);
      if (!piece) throw new PlayerError('SOURCE_ERROR', `piece #${idx} 缺失（内部状态不一致）`);
      const relInPiece = cursor - idx * this.pieceLength;
      const take = Math.min(piece.length - relInPiece, end - cursor);
      out.set(piece.subarray(relInPiece, relInPiece + take), cursor - offset);
      cursor += take;
    }
    return out;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const waiters = this.#prefixWaiters;
    this.#prefixWaiters = [];
    for (const w of waiters) w.resolve(); // 唤醒挂起的 read → 走 ABORTED 分支
    this.#done.clear();
  }
}
