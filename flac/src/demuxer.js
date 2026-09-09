/**
 * flac/src/demuxer.js — FlacDemuxer（对齐 docs/CONTRACTS.md §2 形状）
 * ------------------------------------------------------------
 * 点播型 ByteSource demuxer：产出整帧 FLAC Sample（codec:'flac'）。
 * STREAMINFO 原始 34 字节作为 Track.description 透传（契约 §1.2）。
 *
 * 帧索引策略：FLAC 无帧长字段，边界必须经子帧位级遍历确定。
 * 首次 samples()/seek() 时做一次全文件扫描建索引（小文件毫秒级），
 * 之后按索引切片，零重复解码。流式增量扫描为 M3 整合项。
 */
import { Demuxer } from '../../core/src/demuxer.js';
import { DEFAULT_MAX_SCAN_BYTES, assertByteLength } from '../../core/src/limits.js';
import { parseMetadata } from './metadata.js';
import { findSync } from './frame-header.js';
import { FlacDecoder } from './decoder.js';
import { stateError } from './errors.js';
import { raceAbort, throwIfAborted } from '../../core/src/abort.js';

export class FlacDemuxer extends Demuxer {
  /**
   * 静态嗅探：同步、无副作用、不抛异常。
   * @param {Uint8Array} bytes
   * @returns {{confidence:number, container:'flac', codecsHint:string[]}|null}
   */
  static probe(bytes) {
    try {
      if (bytes.length < 4) return null;
      if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;
      return { confidence: 0.95, container: 'flac', codecsHint: ['flac'] };
    } catch {
      return null;
    }
  }

  /** @param {{size:number|null, read:function(number,number):Promise<Uint8Array>,
                close?:function():Promise<void>}} source ByteSource */
  constructor(source, options = {}) {
    super(source, options);
    this.#source = source;
    /** I5：全量扫描字节上界（默认 256MB），超大文件需显式调大并检查数据源侧上界 */
    this.maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    /** core Demuxer 状态机；FLAC 额外使用 ended/error 作为兼容性标记。 */
    /** @type {(import('./metadata.js').FlacMetadata & {audioOffset:number})|null} */
    this.flacMetadata = null;
    /** @type {{container:'flac', tracks:Array<object>, durationUs:number|null,
                  seekable:boolean, live:boolean, metadata:object}|null} */
    this.mediaInfoValue = null;
    /** @type {Array<{offset:number,size:number,firstSample:number,samples:number}>|null} */
    this.frameIndex = null;
  }

  #source;
  /** 下一次 samples() 的起始帧索引下标（seek 后 > 0） */
  #nextFrameIdx = 0;
  /** readSample 单拉共享 reader（与 samples 游标一致，EOS 后自动释放重建） */
  #reader = null;
  #readerActive = false;


  /** 解析元数据段 → Promise<MediaInfo> */
  async _parseInit() {
    if (this.stateValue !== 'opening') throw stateError(`parseInit 需处于 opening 态，当前 ${this.stateValue}`);
    try {
      // 元数据通常 < 64KB；上限 2MB 兜底异常大封面等
      const cap = Math.min(this.#source.size ?? 65536, 2 * 1024 * 1024);
      let bytes = await this.#source.read(0, Math.min(65536, cap));
      try {
        this.flacMetadata = parseMetadata(bytes);
      } catch (e) {
        if (cap > bytes.length) {
          bytes = await this.#source.read(0, cap);
          this.flacMetadata = parseMetadata(bytes);
        } else throw e;
      }

      const si = this.flacMetadata.streamInfo;
      const durationUs = si.totalSamples > 0 && si.sampleRate > 0
        ? Math.round((si.totalSamples / si.sampleRate) * 1e6)
        : null;

      // STREAMINFO 块体（34 字节）原样作为 description（契约 §1.2 flac 条目）
      const siBlock = this.flacMetadata.blocks.find((b) => b.type === 0);
      const description = siBlock ? bytes.slice(siBlock.offset, siBlock.offset + 34) : null;

      this.mediaInfoValue = {
        container: 'flac',
        tracks: [{
          id: 1,
          type: 'audio',
          codec: 'flac',
          description,
          language: '',
          durationUs,
          audio: { sampleRate: si.sampleRate, numberOfChannels: si.channels },
        }],
        durationUs,
        seekable: true,
        live: false,
        metadata: { ...this.flacMetadata.tags },
      };
      return this.mediaInfoValue;
    } catch (e) {
      throw e;
    }
  }

  /**
   * 拉取音频轨 Sample 迭代器：每个 Sample 为一整个 FLAC 帧。
   * seek 之后再次调用，将从 seek 落点帧继续产出。
   * @param {number} trackId 仅支持 1
   * @param {{signal?:AbortSignal|null}} [options] 可选中断信号（§12.3 新增可选成员）
   */
  samples(trackId, options = undefined) {
    if (this.stateValue !== 'ready') throw stateError('必须先 parseInit 成功再取 samples');
    if (trackId !== 1) throw stateError(`FLAC 只有轨道 1，收到 ${trackId}`);
    const self = this;
    const signal = options?.signal ?? null;
    throwIfAborted(signal, `samples(${trackId}) aborted`);
    let cursor = this.#nextFrameIdx;

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!self.frameIndex) await raceAbort(self.buildFrameIndex(), signal, `samples(${trackId}) aborted`);
            if (self.stateValue === 'ended' || cursor >= self.frameIndex.length) {
              self.emit('end', { reason: 'eos' });
              return { done: true, value: undefined };
            }
            const entry = self.frameIndex[cursor];
            const usPerSample = 1e6 / self.metadata.streamInfo.sampleRate;
            // 先读后推进游标：读取被中断时不吞帧，中断后仍可续读同一帧
            const data = await raceAbort(
              self.#source.read(entry.offset, entry.size),
              signal,
              `samples(${trackId}) aborted`,
            );
            cursor += 1;
            if (cursor >= self.frameIndex.length && self.stateValue === 'ready') self.stateValue = 'ended';
            return {
              done: false,
              value: {
                codec: 'flac',
                timestamp: Math.round(entry.firstSample * usPerSample),
                duration: Math.round(entry.samples * usPerSample),
                data,
                keyframe: true,
              },
            };
          },
        };
      },
    };
  }

  /**
   * seek（µs）：优先 SEEKTABLE 中 ≤ 目标的最近点；无表则线性回退到最近帧起点。
   * @param {number} timestampUs
   * @returns {Promise<{actualTimestampUs:number}>}
   */
  async seek(timestampUs) {
    if (!this.flacMetadata) throw stateError('seek 前必须 parseInit');
    if (this.stateValue !== 'ready' && this.stateValue !== 'ended' && this.stateValue !== 'seeking') {
      throw stateError(`seek 需处于 ready 态，当前 ${this.stateValue}`);
    }
    this.stateValue = 'seeking';
    try {
      const si = this.flacMetadata.streamInfo;
      const targetSample = Math.max(0, Math.floor((timestampUs / 1e6) * si.sampleRate));

      if (!this.frameIndex) await this.buildFrameIndex();

      // 帧索引内找 ≤ 目标的最近帧（音频帧即最小寻址单元）
      let idx = 0;
      for (let i = 0; i < this.frameIndex.length; i++) {
        if (this.frameIndex[i].firstSample <= targetSample) idx = i;
        else break;
      }
      // SEEKTABLE 存在时优先用表项校正落点（两套结果应一致或更近）
      const tablePoint = [...this.flacMetadata.seekPoints].reverse()
        .find((p) => p.sampleNumber <= targetSample);

      this.#nextFrameIdx = idx;
      const landedSample = tablePoint && Math.abs(tablePoint.sampleNumber - targetSample)
        < Math.abs(this.frameIndex[idx].firstSample - targetSample)
        ? tablePoint.sampleNumber
        : this.frameIndex[idx].firstSample;
      // 评审（wav#2 同款修复）：从 ended seek 后必须回到 ready，
      // 否则 samples()/readSample() 永久 STATE_ERROR，播完再 seek 无法恢复迭代
      this.stateValue = 'ready';
      return { actualTimestampUs: Math.round((landedSample / si.sampleRate) * 1e6) };
    } catch (e) {
      this.stateValue = 'error';
      throw e;
    }
  }

  /** 已缓冲区间：点播容器返回全区间 */
  getBufferedRanges(_trackId) {
    if (!this.mediaInfoValue || !this.mediaInfoValue.durationUs) return [];
    return [{ startUs: 0, endUs: this.mediaInfoValue.durationUs }];
  }

  /**
   * 全量扫描建立帧索引（一次性）。数据损坏帧触发向后重同步扫描。
   */
  async buildFrameIndex() {
    if (this.frameIndex) return this.frameIndex;
    const total = this.#source.size ?? 0;
    // I5：全量扫描前先校验总长（size 未知/Infinity 或畸形长度字段不得触发超大读取）
    assertByteLength(total, this.maxScanBytes, 'FLAC 全量扫描');
    const all = await this.#source.read(0, total);
    const si = this.flacMetadata.streamInfo;
    const decoder = new FlacDecoder({
      sampleRate: si.sampleRate, channels: si.channels, bitsPerSample: si.bitsPerSample,
    });

    /** @type {Array<{offset:number,size:number,firstSample:number,samples:number}>} */
    const index = [];
    let samplePos = 0;
    let pos = this.flacMetadata.audioOffset;
    while (pos < all.length - 2) {
      const syncAt = findSync(all, pos);
      if (syncAt < 0) break;
      try {
        const frame = decoder.decodeFrame(all, syncAt);
        index.push({ offset: syncAt, size: frame.endByte - syncAt, firstSample: samplePos, samples: frame.blockSize });
        samplePos += frame.blockSize;
        pos = frame.endByte;
      } catch {
        pos = syncAt + 2; // CRC 不符 → 从下一字节继续扫同步码（重同步）
      }
    }
    this.frameIndex = index;
    return index;
  }

  /* ---- CONTRACTS v0.2 §2.2/§2.4 定稿方法名 ---- */

  /** core Demuxer 钩子：解析初始化段并返回 MediaInfo。 */
  async _doOpen() {
    await this._parseInit();
    return this.mediaInfoValue;
  }

  /** 迁移期别名：旧调用方继续使用 parseInit()。 */
  parseInit() { return this.open(); }

  /** 兼容旧 API：返回 FLAC 专属解析元数据。 */
  get metadata() { return this.flacMetadata; }

  /**
   * 定稿名：拉取下一样本（pull 主通道）。EOS resolve null。
   * @param {number} trackId
   * @param {{signal?:AbortSignal|null}} [options] 可选中断信号（§12.3 新增可选成员）
   */
  async readSample(trackId, options = undefined) {
    const signal = options?.signal ?? null;
    throwIfAborted(signal, `readSample(${trackId}) aborted`);
    if (!this.#reader || !this.#readerActive) {
      this.#reader = this.samples(trackId, options)[Symbol.asyncIterator]();
      this.#readerActive = true;
    }
    const r = await raceAbort(this.#reader.next(), signal, `readSample(${trackId}) aborted`);
    if (r.done) { this.#readerActive = false; return null; }
    return r.value;
  }

  /** 定稿名：销毁（幂等）；之后一切调用抛 STATE_ERROR */
  async destroy() {
    await this.stop();
    this.stateValue = 'destroyed';
  }

  /** 释放数据源，幂等 */
  async stop() {
    if (this.#source && typeof this.#source.close === 'function') {
      try { await this.#source.close(); } catch { /* 忽略 */ }
    }
    if (this.stateValue !== 'error') this.stateValue = 'idle';
  }
}

