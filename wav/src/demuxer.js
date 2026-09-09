/**
 * wav/src/demuxer.js — WavDemuxer（继承 core Demuxer，案 C）
 * ------------------------------------------------------------
 * 点播型 ByteSource demuxer：直接产出 pcm-* Sample。
 *
 * 2026-09-09 案 C 落地（见 docs/review/wav-base-class-alignment.md §8/§9）：
 * - `extends Demuxer`，状态机/事件面/`open()`（含 initTimeoutMs 超时与
 *   'media-info'+'mediaInfo' 双发）/`destroy` 交基类；
 * - `readSample`/`samples`/`seek`/`stop`/`parseInit` 别名保留自实现覆盖，
 *   自有历史结束标记 `ended`/`error` 维持兼容（同 flac 案 C 模式）；
 * - 进一步「完全同构」（案 A）属跨模块裁决项，禁止单模块擅改。
 *
 * 对外接口（probe/parseInit/open/readSample/samples/seek/pause/resume/
 * destroy/stop/getBufferedRanges）与冻结版保持一致。
 */
import { Demuxer } from '../../core/src/demuxer.js';
import { parseWavHeader } from './riff-parser.js';
import { stateError } from './errors.js';
import { raceAbort, throwIfAborted } from '../../core/src/abort.js';

/** 每次迭代产出的采样块大小（帧）：粒度与内存开销的平衡点。 */
const CHUNK_FRAMES = 4096;

/**
 * @typedef {Object} Sample
 * @property {string} codec      规范 codec 字符串（pcm-s16 等）
 * @property {number} timestamp  PTS，整数微秒
 * @property {number} duration   时长，整数微秒
 * @property {Uint8Array} data   裸 PCM 字节
 * @property {boolean} keyframe  音频恒为 true
 */

/**
 * @typedef {Object} MediaInfo
 * @property {'wav'} container
 * @property {Array<object>} tracks
 * @property {number|null} durationUs
 * @property {boolean} seekable
 * @property {boolean} live
 * @property {{title?:string, [k:string]:string}} [metadata]
 */

export class WavDemuxer extends Demuxer {
  /**
   * 静态嗅探：同步、无副作用、不抛异常。
   * @param {Uint8Array} bytes 源头部字节（建议 ≥ 64B）
   * @returns {{confidence:number, container:'wav', codecsHint:string[]}|null}
   */
  static probe(bytes) {
    try {
      if (bytes.length < 12) return null;
      const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (riff !== 'RIFF' || wave !== 'WAVE') return null;
      return { confidence: 0.95, container: 'wav', codecsHint: ['pcm-*'] };
    } catch {
      return null;
    }
  }

  /**
   * @param {{size:number|null, read:function(number,number):Promise<Uint8Array>,
                close?:function():Promise<void>}} source ByteSource（File/Blob/Memory 可适配）
   * @param {{chunkFrames?:number, initTimeoutMs?:number}} [options]
   */
  constructor(source, options = undefined) {
    super(source, options); // 基类：this.source / options.initTimeoutMs / stateValue / pausedFlag / Emitter
    this.#chunkFrames = options?.chunkFrames ?? CHUNK_FRAMES;
  }

  #chunkFrames;
  /** @type {ReturnType<typeof parseWavHeader>|null} */
  #header = null;
  /** 下一次 samples() 迭代的起始帧（seek 后非 0） */
  #startFrame = 0;
  #reader = null;
  #readerActive = false;
  #endEmitted = false;

  /** core Demuxer 钩子：解析 RIFF 头 + fmt + data 定位，返回 MediaInfo。
   *  状态迁移与超时（initTimeoutMs）由基类 `open()` 统一管理。 */
  async _doOpen() {
    // 头部通常 < 100KB；读前 64KB 已足够定位 fmt 与 data 偏移
    const headLen = Math.min(65536, this.source.size ?? 65536);
    const head = await this.source.read(0, headLen);
    this.#header = parseWavHeader(head);

    const f = this.#header.format;
    this.mediaInfoValue = /** @type {MediaInfo} */ ({
      container: 'wav',
      tracks: [{
        id: 1,
        type: 'audio',
        codec: this.#header.codec,
        description: null,
        language: '',
        durationUs: this.#header.durationUs,
        audio: { sampleRate: f.sampleRate, numberOfChannels: f.channels },
      }],
      durationUs: this.#header.durationUs,
      seekable: true,
      live: false,
      metadata: { ...this.#header.info },
    });
    return this.mediaInfoValue;
  }

  /** 迁移期别名：parseInit() 即 open()（旧调用方继续可用）。 */
  parseInit() { return this.open(); }

  /**
   * 拉取音频轨的 Sample 异步迭代器（点播首选用法，天然背压）。
   * seek 之后再次调用本方法，将从 seek 落点开始产出。
   * @param {number} trackId 仅支持 1（WAV 单轨）
   * @param {{signal?:AbortSignal|null}} [options] 可选中断信号（§12.3 新增可选成员）
   */
  samples(trackId, options = undefined) {
    const signal = options?.signal ?? null;
    throwIfAborted(signal, `samples(${trackId}) aborted`);
    if (this.state === 'destroyed') throw stateError('demuxer 已销毁，不可复用');
    if (this.state !== 'ready') throw stateError('必须先 parseInit 成功再取 samples');
    if (trackId !== 1) throw stateError(`WAV 只有轨道 1，收到 ${trackId}`);

    const self = this;
    const header = this.#header;
    const fmt = header.format;
    const dataOff = header.dataChunk.offset;
    const totalFrames = Math.floor(header.dataChunk.size / Math.max(1, fmt.blockAlign));
    const usPerFrame = 1e6 / fmt.sampleRate;
    let nextFrame = this.#startFrame; // 消费游标

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (self.state === 'error') throw stateError('demuxer 已进入 error 态，禁止继续取样本');
            if (self.state === 'ended' || nextFrame >= totalFrames) {
              if (!self.#endEmitted) { self.emit('end', { reason: 'eos' }); self.#endEmitted = true; }
              return { done: true, value: undefined };
            }
            const startFrame = nextFrame;
            const count = Math.min(self.#chunkFrames, totalFrames - startFrame);
            let data;
            try {
              data = await raceAbort(
                self.source.read(
                  dataOff + startFrame * Math.max(1, fmt.blockAlign),
                  count * Math.max(1, fmt.blockAlign),
                ),
                signal,
                `samples(${trackId}) aborted`,
              );
            } catch (e) {
              // abort 是调用方预期控制流：不置 error 态、不进 'error' 事件面，直接上抛
              if (e?.code !== 'ABORTED') {
                self.stateValue = 'error';
                self.emit('error', e);
              }
              throw e;
            }
            nextFrame += count;
            if (nextFrame >= totalFrames && self.state === 'ready') self.stateValue = 'ended';
            return {
              done: false,
              value: {
                codec: header.codec,
                timestamp: Math.round(startFrame * usPerFrame),
                duration: Math.round(count * usPerFrame),
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
   * seek（µs）：把后续迭代起点对齐到目标帧。resolve 实际落点微秒。
   * @param {number} timestampUs
   * @returns {Promise<{actualTimestampUs:number}>}
   */
  async seek(timestampUs) {
    if (!this.#header) throw stateError('seek 前必须 parseInit');
    if (this.state !== 'ready' && this.state !== 'ended' && this.state !== 'seeking') {
      throw stateError(`seek 需处于 ready 态，当前 ${this.state}`);
    }
    if (!Number.isFinite(timestampUs)) throw stateError('seek 入参必须是有限数值（µs）');
    this.stateValue = 'seeking';
    try {
      const fmt = this.#header.format;
      const totalFrames = Math.floor(this.#header.dataChunk.size / Math.max(1, fmt.blockAlign));
      let target = Math.round((timestampUs / 1e6) * fmt.sampleRate);
      target = Math.min(Math.max(target, 0), Math.max(totalFrames - 1, 0));
      this.#startFrame = target; // 下一次 samples() 从这里继续
      this.#reader = null; this.#readerActive = false;
      // 评审严重2：从 ended seek 后必须回到 ready，否则 samples() 永久 STATE_ERROR
      this.stateValue = 'ready';
      return { actualTimestampUs: Math.round((target / fmt.sampleRate) * 1e6) };
    } catch (e) {
      this.stateValue = 'error';
      throw e;
    }
  }

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

  /** 释放数据源，幂等；随后 destroy() 置 destroyed 终态 */
  async stop() {
    if (this.source && typeof this.source.close === 'function') {
      try { await this.source.close(); } catch { /* 关闭失败不阻断 */ }
    }
    if (this.stateValue !== 'error') this.stateValue = 'idle';
  }

  /** 定稿名：销毁（幂等）；之后一切调用抛 STATE_ERROR */
  async destroy() {
    await this.stop();
    this.stateValue = 'destroyed';
  }

  /** 已缓冲区间查询：WAV 为整段可得的点播容器，返回全区间 */
  getBufferedRanges(_trackId) {
    if (!this.#header || !this.mediaInfoValue) return [];
    return [{ startUs: 0, endUs: this.mediaInfoValue.durationUs ?? 0 }];
  }
}
