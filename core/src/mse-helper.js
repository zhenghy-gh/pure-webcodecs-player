/**
 * MSE Helper：MediaSource 封装。
 *
 * 职责：
 * 1. 创建 MediaSource 并 attach 到 <video>/<audio>；
 * 2. 按轨管理 SourceBuffer，串行化 appendBuffer（浏览器要求同一 SB 不允许并发更新）；
 * 3. 提供 buffered 查询、remove、endOfStream、销毁时的 URL 回收。
 *
 * 兼容：优先 MediaSource；iOS 17+ 可选 ManagedMediaSource（构造参数开启）。
 */
import { Emitter } from './emitter.js';
import { stateError, decodeError, notSupported } from './errors.js';
import { mseIsTypeSupported } from './codec-string.js';

/**
 * 判定 mime 是否被当前 MediaSource 支持。
 * isTypeSupported 是构造器静态方法（实例上没有），故优先用静态探测；
 * 若注入的实现自带实例方法（测试/宿主自定义），则尊重实例方法。
 */
function isTypeSupported(mediaSource, mimeType) {
  if (mediaSource && typeof mediaSource.isTypeSupported === 'function') {
    return !!mediaSource.isTypeSupported(mimeType);
  }
  return mseIsTypeSupported(mimeType);
}

function nowSec() {
  return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
}

/** 单个 SourceBuffer 的写入队列 */
class SourceBufferChannel extends Emitter {
  constructor(sourceBuffer, label) {
    super();
    this.sb = sourceBuffer;
    this.label = label;
    this.queue = Promise.resolve();
    this.closed = false;
    const onError = () => {
      // 当前 update 出错时让队列继续流动并广播错误
      this.emit('error', decodeError(`${label}: sourcebuffer update failed`));
    };
    this.sb.addEventListener('error', onError);
    this._offError = () => this.sb.removeEventListener('error', onError);
  }

  /** 排队执行一次 SourceBuffer 操作（updateend 后 resolve） */
  enqueue(operation) {
    if (this.closed) return Promise.reject(stateError(`${this.label}: channel closed`));
    const run = this.queue.then(
      () =>
        new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(decodeError(`${this.label}: sourcebuffer update failed`));
          };
          const cleanup = () => {
            this.sb.removeEventListener('updateend', finish);
            this.sb.removeEventListener('error', fail);
          };
          this.sb.addEventListener('updateend', finish);
          this.sb.addEventListener('error', fail);
          try {
            operation(this.sb);
            // 非更新类调用不会触发 updateend
            if (!this.sb.updating) finish();
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : stateError(String(err)));
          }
        }),
    );
    // 队列吞错继续（错误经返回的 promise 与 error 事件双通道上报）
    this.queue = run.catch(() => {});
    return run;
  }

  append(data) {
    return this.enqueue((sb) => sb.appendBuffer(data));
  }

  remove(startSec, endSec) {
    return this.enqueue((sb) => sb.remove(startSec, endSec));
  }

  abortThenClear() {
    return this.enqueue((sb) => {
      if (sb.updating) sb.abort();
      if (typeof sb.changeType === 'function') {
        /* no-op: 预留转码场景 */
      }
    });
  }
}

export class MseHelper extends Emitter {
  /**
   * @param {HTMLMediaElement} mediaElement
   * @param {{managed?: boolean}} [options] managed: 使用 ManagedMediaSource（iOS17+/后台播放）
   */
  constructor(mediaElement, options = {}) {
    super();
    this.element = mediaElement;
    this.managed = options.managed === true;
    this.mediaSource = null;
    this.objectUrl = null;
    /** @type {Map<string, SourceBufferChannel>} */
    this.channels = new Map();
    this.opened = false;
    this.destroyed = false;
  }

  _ctor() {
    if (this.managed && typeof ManagedMediaSource === 'function') return ManagedMediaSource;
    if (typeof MediaSource !== 'undefined') return MediaSource;
    throw notSupported('MediaSource is not supported in this environment', { managed: this.managed });
  }

  /**
   * 打开 MediaSource 并等待 sourceopen。必须先于 addTrack 调用。
   * @returns {Promise<void>}
   */
  open() {
    if (this.destroyed) return Promise.reject(stateError('MseHelper destroyed'));
    if (this.opened) return Promise.resolve();
    const Ctor = this._ctor();
    return new Promise((resolve, reject) => {
      const ms = new Ctor();
      this.mediaSource = ms;
      const url = URL.createObjectURL(ms);
      this.objectUrl = url;
      const onOpen = () => {
        cleanup();
        ms.removeEventListener?.('sourceopen', onOpen);
        this.opened = true;
        this.emit('open');
        resolve();
      };
      const cleanup = () => ms.removeEventListener('sourceopen', onOpen);
      ms.addEventListener('sourceopen', onOpen);
      // ManagedMediaSource 在部分实现里需要 startstreaming 提示
      if (this.managed && typeof ms.startStreaming === 'function') {
        ms.startStreaming();
      }
      try {
        this.element.src = url;
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : stateError(String(err)));
      }
    });
  }

  /**
   * 增加一条轨的 SourceBuffer。
   * @param {string} key 轨标识（如 'v0'/'a0'）
   * @param {string} mimeType 完整 mime，如 'video/mp4; codecs="avc1.42E01E"'
   */
  async addTrack(key, mimeType) {
    this._ensureOpen();
    if (this.channels.has(key)) return this.channels.get(key);
    if (!isTypeSupported(this.mediaSource, mimeType)) {
      throw notSupported(`mime not supported: ${mimeType}`);
    }
    const sb = this.mediaSource.addSourceBuffer(mimeType);
    const channel = new SourceBufferChannel(sb, key);
    channel.on('error', (err) => this.emit('bufferError', err));
    this.channels.set(key, channel);
    this.emit('trackAdded', { key, mimeType });
    return channel;
  }

  /** 追加一段封装好的媒体数据（fMP4 segment 等） */
  append(key, data) {
    this._ensureOpen();
    const channel = this.channels.get(key);
    if (!channel) throw stateError(`unknown track key: ${key}`);
    return channel.append(data);
  }

  /** 清空某轨已缓冲内容并重置解析器（清晰度切换用） */
  async resetTrack(key, keepPosition = true) {
    const channel = this.channels.get(key);
    if (!channel) return;
    const sb = channel.sb;
    const ranges = this.buffered(key);
    if (keepPosition && this.element.currentTime >= 0 && ranges.length > 0) {
      // 移除当前位置之后的全部数据
      await channel.remove(this.element.currentTime + 1e-4, this.durationOr(ranges.end(ranges.length - 1)));
    } else {
      await channel.abortThenClear();
      await channel.remove(0, this.durationOr(Number.MAX_SAFE_INTEGER / 1000));
    }
    void sb;
  }

  durationOr(fallback) {
    const d = this.mediaSource?.duration;
    return Number.isFinite(d) && d > 0 ? d : fallback;
  }

  /** @returns {TimeRanges|null} */
  buffered(key) {
    return this.channels.get(key)?.sb.buffered ?? null;
  }

  /** 当前缓冲水位（秒），无缓冲返回 0 */
  bufferedAhead(key, currentTime = undefined) {
    const ranges = this.buffered(key);
    if (!ranges || ranges.length === 0) return 0;
    const t = currentTime ?? this.element.currentTime ?? 0;
    let ahead = 0;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (t >= start && t <= end) ahead += end - t;
      else if (start > t) ahead += end - start;
    }
    return ahead;
  }

  async setDuration(sec) {
    this._ensureOpen();
    this.mediaSource.duration = sec;
  }

  async endOfStream(reason = undefined) {
    this._ensureOpen();
    await this.drainAll();
    if (reason !== undefined) this.mediaSource.endOfStream(reason);
    else this.mediaSource.endOfStream();
  }

  drainAll() {
    return Promise.all([...this.channels.values()].map((c) => c.queue));
  }

  _ensureOpen() {
    if (!this.opened) throw stateError('MseHelper.open() must complete first');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const channel of this.channels.values()) {
      channel.closed = true;
      channel.removeAllListeners();
      channel._offError?.();
    }
    this.channels.clear();
    try {
      if (this.opened && this.mediaSource?.readyState !== 'closed') {
        this.mediaSource.endOfStream?.();
      }
    } catch {
      /* readyState 竞态可忽略 */
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.element && this.element.src?.startsWith?.('blob:')) {
      this.element.removeAttribute('src');
      this.element.load?.();
    }
    this.emit('destroy');
    this.removeAllListeners();
  }
}

export { nowSec as mseMonotonicTime };
