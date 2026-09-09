/**
 * wav/src/demuxer.js — WavDemuxer（对齐 docs/CONTRACTS.md §2 形状）
 * ------------------------------------------------------------
 * 点播型 ByteSource demuxer：直接产出 pcm-* Sample。
 * 并行期说明：暂不继承 core BaseDemuxer（共享看板约定，解析层先行），
 * 事件模型与状态机以最小内建 Emitter 实现；core 稳定后切换基类，
 * 对外接口（probe/parseInit/samples/seek/stop）保持不变。
 */
import { parseWavHeader } from './riff-parser.js';
import { stateError, sourceError, timeoutError } from './errors.js';

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

/** 迷你事件发射器（'error'|'media-info'|'end'|'pause'|'resume'） */
class MiniEmitter {
  #m = new Map();
  on(e, f) { let l = this.#m.get(e); if (!l) this.#m.set(e, (l = [])); l.push(f); return () => this.off(e, f); }
  off(e, f) { const l = this.#m.get(e); if (!l) return; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  emit(e, p) { for (const f of [...(this.#m.get(e) || [])]) { try { f(p); } catch (err) { console.error(err); } } }
}

export class WavDemuxer {
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
    this.#source = source;
    this.#chunkFrames = options?.chunkFrames ?? CHUNK_FRAMES;
    /** §2.4：open()/parseInit() 的解析超时上界，超时 reject TIMEOUT */
    this.#initTimeoutMs = options?.initTimeoutMs ?? 10000;
    /** §2.4 暂停标记（直播推送语义；wav 为点播，仅维护标记与事件一致性） */
    this.pausedFlag = false;
    /** 生命周期状态机：idle → parsing → ready ⇄ seeking → ended | error */
    this.state = 'idle';
    /** @type {MediaInfo|null} parseInit 成功后的媒体信息 */
    this.mediaInfo = null;
    this.emitter = new MiniEmitter();
  }

  #source;
  #chunkFrames;
  #initTimeoutMs;
  /** @type {ReturnType<typeof parseWavHeader>|null} */
  #header = null;
  /** 下一次 samples() 迭代的起始帧（seek 后非 0） */
  #startFrame = 0;

  /** 订阅事件：'error'(PlayerError) | 'media-info'(MediaInfo) | 'end'({reason}) | 'pause' | 'resume' */
  on(event, fn) { return this.emitter.on(event, fn); }

  /**
   * 解析初始化段（RIFF 头 + fmt + data 定位）。
   * @returns {Promise<MediaInfo>}
   */
  async parseInit() {
    if (this.state === 'destroyed') throw stateError('demuxer 已销毁，不可复用');
    if (this.state !== 'idle') throw stateError(`parseInit 需处于 idle 态，当前 ${this.state}`);
    this.state = 'parsing';
    // §2.4：initTimeoutMs 超时 reject TIMEOUT（防护慢源/卡死源让解析永久挂起）
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError(`parseInit() timed out after ${this.#initTimeoutMs}ms`));
      }, this.#initTimeoutMs);
      // 不阻塞进程退出
      if (typeof timer?.unref === 'function') timer.unref();
    });
    try {
      // 头部通常 < 100KB；读前 64KB 已足够定位 fmt 与 data 偏移
      const head = await Promise.race([
        (async () => {
          const headLen = Math.min(65536, this.#source.size ?? 65536);
          return this.#source.read(0, headLen);
        })(),
        guard,
      ]);
      this.#header = parseWavHeader(head);

      const f = this.#header.format;
      this.mediaInfo = /** @type {MediaInfo} */ ({
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
      this.state = 'ready';
      this.emitter.emit('media-info', this.mediaInfo);
      return this.mediaInfo;
    } catch (e) {
      this.state = 'error';
      this.emitter.emit('error', e);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 拉取音频轨的 Sample 异步迭代器（点播首选用法，天然背压）。
   * seek 之后再次调用本方法，将从 seek 落点开始产出。
   * @param {number} trackId 仅支持 1（WAV 单轨）
   */
  samples(trackId) {
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
              if (!self.#endEmitted) { self.emitter.emit('end', { reason: 'eos' }); self.#endEmitted = true; }
              return { done: true, value: undefined };
            }
            const startFrame = nextFrame;
            const count = Math.min(self.#chunkFrames, totalFrames - startFrame);
            let data;
            try {
              data = await self.#source.read(
                dataOff + startFrame * Math.max(1, fmt.blockAlign),
                count * Math.max(1, fmt.blockAlign),
              );
            } catch (e) {
              self.state = 'error';
              self.emitter.emit('error', e);
              throw e;
            }
            nextFrame += count;
            if (nextFrame >= totalFrames && self.state === 'ready') self.state = 'ended';
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
    const prev = this.state;
    this.state = 'seeking';
    try {
      const fmt = this.#header.format;
      const totalFrames = Math.floor(this.#header.dataChunk.size / Math.max(1, fmt.blockAlign));
      let target = Math.round((timestampUs / 1e6) * fmt.sampleRate);
      target = Math.min(Math.max(target, 0), Math.max(totalFrames - 1, 0));
      this.#startFrame = target; // 下一次 samples() 从这里继续
      this.#reader = null; this.#readerActive = false;
      // 评审严重2：从 ended seek 后必须回到 ready，否则 samples() 永久 STATE_ERROR
      this.state = 'ready';
      return { actualTimestampUs: Math.round((target / fmt.sampleRate) * 1e6) };
    } catch (e) {
      this.state = 'error';
      throw e;
    }
  }

  /* ---- CONTRACTS v0.2 §2.2 定稿方法名 ---- */

  /** 定稿名：打开并解析初始化段（= parseInit） */
  open() { return this.parseInit(); }

  /** 定稿名：拉取下一样本（pull 主通道）。EOS resolve null。 */
  async readSample(trackId) {
    if (!this.#reader || !this.#readerActive) {
      this.#reader = this.samples(trackId)[Symbol.asyncIterator]();
      this.#readerActive = true;
    }
    const r = await this.#reader.next();
    if (r.done) { this.#readerActive = false; return null; }
    return r.value;
  }
  #reader = null;
  #readerActive = false;
  #endEmitted = false;

  /* ---- §2.4 直播推送控制：wav 为点播容器，仅维护标记与事件语义一致 ---- */

  /** 暂停吐包（缓冲继续累积） */
  pause() {
    this.pausedFlag = true;
    this.emitter.emit('pause', undefined);
  }

  /** 恢复推送 */
  resume() {
    this.pausedFlag = false;
    this.emitter.emit('resume', undefined);
  }

  /** 定稿名：销毁（幂等）；之后一切调用抛 STATE_ERROR */
  async destroy() {
    await this.stop();
    this.state = 'destroyed';
  }

  /** 已缓冲区间查询：WAV 为整段可得的点播容器，返回全区间 */
  getBufferedRanges(_trackId) {
    if (!this.#header || !this.mediaInfo) return [];
    return [{ startUs: 0, endUs: this.mediaInfo.durationUs ?? 0 }];
  }

  /** 释放数据源，幂等 */
  async stop() {
    if (this.#source && typeof this.#source.close === 'function') {
      try { await this.#source.close(); } catch { /* 关闭失败不阻断 */ }
    }
    if (this.state !== 'error') this.state = 'idle';
  }
}
