/**
 * mse-controller.js —— MediaSource 封装
 *
 * 职责：
 *  - 创建 MediaSource 并绑定 <video>，生成 ObjectURL
 *  - 管理 video / audio 双 SourceBuffer（fMP4 分片直通）
 *  - appendBuffer 队列化：浏览器要求同一 SourceBuffer 上一次只允许一个 append，
 *    这里用 Promise 队列串行化，并处理 QuotaExceededError（缓冲满则移除旧数据）
 *
 * 已知限制：
 *  - Safari 桌面版对 MSE 的 fMP4 支持自 macOS Monterey 起；更老版本建议走原生 HLS
 */

import { logger } from './utils.js';
import { notSupported, stateError, decodeError } from '../../core/src/errors.js';

const log = logger('mse');

export class MseController {
  constructor() {
    /** @type {MediaSource|null} */
    this.mediaSource = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {Object<string,SourceBuffer>} */
    this.sourceBuffers = {};
    this._queues = {}; // type -> Promise 队列尾部
    this._objectUrl = null;
    this._onQuotaEvict = null; // (type, start, end) => void
  }

  /**
   * 绑定 video 元素并就绪 MediaSource。
   * @returns {Promise<{mediaSource: MediaSource}>}
   */
  attach(video) {
    // 双环境红线（契约 §0.3）：不裸引用 window；Node 下给出可诊断错误而非 ReferenceError
    const MSE = typeof globalThis.MediaSource === 'function' ? globalThis.MediaSource : null;
    const MMS = typeof globalThis.ManagedMediaSource === 'function' ? globalThis.ManagedMediaSource : null;
    if (!MSE && !MMS) {
      throw notSupported('当前环境不支持 MSE（MediaSource），请改用 WebCodecs 渲染路线');
    }
    const Ctor = MMS || MSE;
    this.video = video;
    return new Promise((resolve, reject) => {
      const ms = new Ctor();
      this.mediaSource = ms;
      ms.addEventListener('sourceopen', () => resolve({ mediaSource: ms }), { once: true });
      ms.addEventListener('sourceerror', () => reject(decodeError('MediaSource sourceerror')), { once: true });
      this._objectUrl = URL.createObjectURL(ms);
      video.src = this._objectUrl;
    });
  }

  /**
   * 添加 SourceBuffer。
   * @param {'video'|'audio'} type
   * @param {string} mimeType 如 'video/mp4; codecs="avc1.640028"'
   */
  addSourceBuffer(type, mimeType) {
    const ms = this.mediaSource;
    if (!ms || ms.readyState !== 'open') throw stateError('MediaSource 未 open，无法添加 SourceBuffer');
    const MSCtor = this._MSCtor || (typeof globalThis.MediaSource === 'function' ? globalThis.MediaSource : null);
    if (!MSCtor) throw notSupported('当前环境不支持 MSE（MediaSource），无法校验编码支持');
    if (!MSCtor.isTypeSupported(mimeType)) {
      throw notSupported(`浏览器不支持该编码: ${mimeType}`);
    }
    const sb = ms.addSourceBuffer(mimeType);
    sb.mode = 'segments';
    this.sourceBuffers[type] = sb;
    this._queues[type] = Promise.resolve();

    // 缓冲配额处理：append 抛 QuotaExceeded 时回调上层决定移除区间后重试
    sb.addEventListener('error', (e) => log.error('SourceBuffer error', e));
    return sb;
  }

  /**
   * 追加 fMP4 数据（队列化、可等待）。
   * @param {'video'|'audio'} type
   * @param {Uint8Array} data
   */
  append(type, data) {
    const sb = this.sourceBuffers[type];
    if (!sb) return Promise.reject(stateError(`未初始化 ${type} SourceBuffer`));

    const task = this._queues[type].then(
      () =>
        new Promise((resolve, reject) => {
          try {
            const onEnd = () => {
              cleanup();
              resolve();
            };
            const onErr = () => {
              cleanup();
              // I3 健壮性：appendBuffer 触发错误后 Chrome 会移除该 SourceBuffer，
              // 此时读 sb.buffered 抛异常 —— 必须先 try 判配额，再以 DECODE_ERROR 上报。
              let overQuota = false;
              try {
                overQuota = sb.buffered && sb.buffered.length >= 30;
              } catch {
                overQuota = false; // SB 已移除，读 buffered 失败 ⇒ 按普通 append 错误上报
              }
              if (overQuota) {
                // 配额超限：先通知上层裁剪旧缓冲（若已注册回调）
                try {
                  this._onQuotaEvict?.(type, this.getBuffered(type));
                } catch {
                  /* 回调异常不影响错误上报 */
                }
                reject(decodeError('SourceBuffer 配额异常（QuotaExceeded）', { type }));
              } else {
                reject(decodeError('appendBuffer error', { type }));
              }
            };
            const cleanup = () => {
              sb.removeEventListener('updateend', onEnd);
              sb.removeEventListener('error', onErr);
            };
            sb.addEventListener('updateend', onEnd);
            sb.addEventListener('error', onErr);
            sb.appendBuffer(data instanceof Uint8Array ? data : new Uint8Array(data));
          } catch (err) {
            // 同步抛出（如 QuotaExceededError）
            reject(err);
          }
        })
    );
    // 队列失败不阻塞后续任务（错误由调用方通过返回的 promise 感知）
    this._queues[type] = task.catch(() => {});
    return task;
  }

  /**
   * 移除时间区间（用于内存回收 / 断点重对齐）。
   * @param {number} start 秒
   * @param {number} end   秒
   */
  remove(type, start, end) {
    const sb = this.sourceBuffers[type];
    if (!sb) return Promise.resolve();
    const task = this._queues[type].then(
      () =>
        new Promise((resolve, reject) => {
          const onEnd = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(decodeError('remove error', { type }));
          };
          const cleanup = () => {
            sb.removeEventListener('updateend', onEnd);
            sb.removeEventListener('error', onErr);
          };
          sb.addEventListener('updateend', onEnd);
          sb.addEventListener('error', onErr);
          try {
            if (sb.updating) sb.abort();
            sb.remove(start, end);
          } catch (err) {
            cleanup();
            reject(err);
          }
        })
    );
    this._queues[type] = task.catch(() => {});
    return task;
  }

  /** 更新时长并进入可播放状态 */
  async finalize(duration) {
    const ms = this.mediaSource;
    if (ms && duration && Number.isFinite(duration)) {
      try {
        if (ms.duration !== duration) ms.duration = duration;
      } catch (e) {
        log.warn('设置 duration 失败', e.message);
      }
    }
  }

  async endOfStream() {
    const ms = this.mediaSource;
    if (ms && ms.readyState === 'open') {
      await this.drainAll();
      try {
        ms.endOfStream();
      } catch (e) {
        log.warn('endOfStream 异常', e.message);
      }
    }
  }

  async drainAll() {
    await Promise.all(Object.values(this._queues).map((q) => q.catch(() => {})));
  }

  /** 当前某类型 buffer 的缓冲区间列表 [[start,end],...]（SB 被移除时安全返回 []） */
  getBuffered(type = 'video') {
    const sb = this.sourceBuffers[type];
    if (!sb) return [];
    try {
      const out = [];
      for (let i = 0; i < sb.buffered.length; i++) {
        out.push([sb.buffered.start(i), sb.buffered.end(i)]);
      }
      return out;
    } catch {
      return []; // SourceBuffer 已从 MediaSource 移除（错误恢复期），读 buffered 属正常失败
    }
  }

  /** 计算视频当前播放点之后的可用缓冲秒数 */
  currentBufferSeconds() {
    if (!this.video) return 0;
    const t = this.video.currentTime;
    let total = 0;
    for (const [s, e] of this.getBuffered('video')) {
      if (t >= s - 0.5 && t <= e) total = Math.max(total, e - t);
    }
    if (total === 0) {
      for (const [s, e] of this.getBuffered('audio')) {
        if (t >= s - 0.5 && t <= e) total = Math.max(total, e - t);
      }
    }
    return total;
  }

  /**
   * 周期缓冲回收：移除播放点前后过远、与当前播放完全脱钩的历史缓冲区间，
   * 抑制长直播 / EVENT（未收尾）会话的 SourceBuffer 内存持续增长。
   *
   * 仅整段落在保留窗口之外的区间会被移除；与窗口存在部分重叠的区间一律保留，
   * 避免误删正在播放或紧邻可 seek 范围的缓冲。
   *
   * 设计取舍（评审 §15.3）：当前 append 仅在 QuotaExceeded 时被动回调上层裁剪，
   * 长会话即使未触发配额也会无限累积后退缓冲。此处改为由播放点主动周期修剪。
   *
   * @param {object} [opts]
   * @param {number} [opts.behindSec] 播放点之前保留的秒数（默认 30）
   * @param {number} [opts.aheadSec]  播放点之后保留的秒数（默认 30）
   * @param {number} [opts.currentTime] 显式播放点（默认 this.video.currentTime），便于测试/无 video 环境
   * @returns {Promise<Array<{type:string,start:number,end:number}>>} 实际发起移除的区间
   */
  async trim({ behindSec = 30, aheadSec = 30, currentTime = null } = {}) {
    const t = currentTime != null ? currentTime : this.video ? this.video.currentTime : 0;
    if (!Number.isFinite(t)) return [];
    const keepStart = t - behindSec;
    const keepEnd = t + aheadSec;
    const removed = [];
    for (const type of Object.keys(this.sourceBuffers)) {
      for (const [s, e] of this.getBuffered(type)) {
        // 整段落在窗口左侧（完全在 keepStart 之前）→ 移除整段
        if (e <= keepStart) {
          removed.push({ type, start: s, end: e });
          await this.remove(type, s, e);
        } else if (s >= keepEnd) {
          // 整段落在窗口右侧（完全在 keepEnd 之后）→ 移除整段
          removed.push({ type, start: s, end: e });
          await this.remove(type, s, e);
        }
        // 部分重叠：保守保留，避免误删播放/seek 范围
      }
    }
    return removed;
  }

  destroy() {
    for (const type of Object.keys(this.sourceBuffers)) {
      try {
        const sb = this.sourceBuffers[type];
        if (sb.updating) sb.abort();
        this.mediaSource.removeSourceBuffer(sb);
      } catch {
        /* 忽略销毁期异常 */
      }
      delete this.sourceBuffers[type];
      delete this._queues[type];
    }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* noop */
      }
    }
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    if (this.video) this.video.removeAttribute('src');
    this.mediaSource = null;
    this.video = null;
  }
}
