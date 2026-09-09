/**
 * player.js —— 轻量 HLS 播放器主类（对标 hls.js 最小核心）
 *
 * 架构：
 *
 *   m3u8 解析 ──► 清晰度控制 ──► 分片加载器 ──► 格式识别/转封装 ──► MSE ──► <video>
 *   (m3u8-parser) (LevelController) (SegmentLoader)  (Transmuxer)   (MseController)
 *
 * 能力：
 *  - VOD 全量顺序加载 + 直播滑动窗口轮询刷新
 *  - MASTER 播放列表自动选择清晰度（EWMA 带宽估计 ABR）与手动切换
 *  - fMP4 分片直通 MSE；TS 分片经 ts/ 适配器转封装（未集成时给出友好错误）
 *  - LL-HLS：解析 EXT-X-PART/SERVER-CONTROL，支持 CAN-BLOCK-RELOAD 阻塞式轮询参数
 *  - 事件总线对外发布 manifest/levelswitch/error/bufferappended 等事件
 *
 * 已知限制（诚实标注）：
 *  - AES-128 已按契约 §2.6 支持（decrypter.js）；SAMPLE-AES/DRM 报 NOT_SUPPORTED
 *  - 音频 Rendition 独立播放列表（EXT-X-MEDIA AUDIO URI）暂合并进主轨道处理，
 *    仅当主列表分片自含音轨时可用
 *  - I-frame 播放列表、字幕轨仅登记不支持渲染
 */

import { parseMaster, parseMedia, detectPlaylistType } from './m3u8-parser.js';
import { SegmentLoader, LoadError } from './segment-loader.js';
import { LevelController } from './level-controller.js';
import { MseController } from './mse-controller.js';
import { Transmuxer } from './transmuxer.js';
import { Aes128Decrypter } from './decrypter.js';
import { EventBus, buildMime, logger } from './utils.js';
import { ErrorCode, stateError } from '../../core/src/errors.js';

const log = logger('player');

export const PlayerState = {
  IDLE: 'idle',
  LOADING: 'loading',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
  DESTROYED: 'destroyed',
};

export class HlsPlayer {
  /**
   * @param {object} [config]
   * @param {number} [config.startLevel] 初始清晰度下标（0=最高清），缺省自适应
   * @param {boolean} [config.lowLatencyMode] LL-HLS 下从最近的独立 part 起播（默认 false）
   * @param {number} [config.maxBufferSeconds] 前向缓冲目标（默认 30s）
   * @param {number} [config.backBufferSeconds] 后退缓冲保留（默认 30s，仅长直播/EVENT 周期回收时生效）
   * @param {('omit'|'same-origin'|'include')} [config.credentials] fetch 凭据策略（默认 omit；
   *   带 Cookie 的授权源传 'same-origin' 或 'include'）
   */
  constructor(config = {}) {
    this.config = {
      lowLatencyMode: false,
      maxBufferSeconds: 30,
      backBufferSeconds: 30,
      ...config,
    };
    this.events = new EventBus();
    this.loader = new SegmentLoader(config.credentials ? { credentials: config.credentials } : {});
    this.mse = new MseController();
    /** @type {LevelController|null} */
    this.levels = null;
    /** @type {Transmuxer|null} */
    this.transmuxer = null;
    /** AES-128 解密层（契约 §2.6：位于 Source 与 demux 之间） */
    this.decrypter = new Aes128Decrypter(config.crypto ? { crypto: config.crypto } : {});

    this.state = PlayerState.IDLE;
    this.playlistUrl = ''; // 当前 media playlist 地址
    this.manifestUrl = '';
    /** @type {object|null} 当前的 media playlist 解析结果 */
    this.mediaPlaylist = null;
    this.nextSegmentIdx = 0;
    this._abortCtrl = null;
    this._pollTimer = null;
    /** 最近一次成功 append 的分片媒体序号（跨清单续播锚点，null=尚未消费任何分片） */
    this._lastAppendedSn = null;
    this._appending = false;
    this._loadedInitUrls = new Set();
    this._destroyed = false;
    /** stall 快速降档回调（绑定引用以便 destroy 时解绑） */
    this._onVideoWaiting = () => this._maybeStallDowngrade();
    this._stats = {
      bytesLoaded: 0,
      segmentsLoaded: 0,
      levelsSwitched: 0,
    };
  }

  on(type, fn) {
    return this.events.on(type, fn);
  }

  _emit(type, payload) {
    log.info(type, payload && payload.type !== undefined ? payload.type : '');
    this.events.emit(type, payload);
  }

  _setState(s) {
    if (this.state !== s) {
      this.state = s;
      this._emit('statechange', { state: s });
    }
  }

  /**
   * 挂载 video 并开始播放。
   * @param {string} url m3u8 地址（MASTER 或 MEDIA）
   * @param {HTMLVideoElement} video
   */
  async attach(url, video) {
    this._abortCtrl = new AbortController();
    await this.mse.attach(video);
    // stall 快速降档（评审 §18.3）：监听 waiting，缓冲近零时绕过带宽估计切最低档
    video.addEventListener('waiting', this._onVideoWaiting);
    return this.loadSource(url);
  }

  /** 加载（或重定向到新的）m3u8 源 */
  async loadSource(url) {
    try {
      this._setState(PlayerState.LOADING);
      this.manifestUrl = url;
      const signal = this._abortCtrl.signal;
      const text = await this.loader.loadText(url, signal);
      let parsed;
      try {
        parsed =
          detectPlaylistType(text) === 'master' ? parseMaster(text, url) : parseMedia(text, url);
      } catch (e) {
        throw new LoadError(ErrorCode.PARSE_ERROR, `m3u8 解析错误: ${e.message}`, { url, fatal: true });
      }

      if (parsed.type === 'master') {
        this.levels = new LevelController(parsed.levels, { startLevel: this.config.startLevel });
        this._emit('manifest', { levels: parsed.levels, audioTracks: parsed.audioTracks });
        const lvl = this.levels.current;
        this.playlistUrl = lvl.url;
        return this._loadMediaPlaylist(this.playlistUrl);
      }
      // 直接是 media playlist（单码率）
      this.mediaPlaylist = parsed;
      this._checkTdViolation(parsed);
      this.playlistUrl = url;
      this._emit('manifest', { levels: [] });
      this._startPipeline();
      return parsed;
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }

  async _loadMediaPlaylist(url, opts = {}) {
    try {
      const text = await this.loader.loadText(url, this._abortCtrl.signal);
      const parsed = parseMedia(text, url);
      // 续播放位置：优先按"最后装载 sn+1"衔接（直播/切档），VOD 按播放时刻映射，
      // 均不可用才回到列表头。绝不静默回退到 0 重放。
      const anchorSn = this._lastAppendedSn;
      let resumeIdx;
      if (anchorSn != null) {
        resumeIdx = computeResumeIndexBySn(parsed.segments, anchorSn);
      } else if (opts.resumeFromUs != null && opts.resumeFromUs > 0) {
        resumeIdx = computeResumeIndexByTimeUs(parsed.segments, opts.resumeFromUs);
      } else {
        resumeIdx = 0;
      }
      this.mediaPlaylist = parsed;
      this._checkTdViolation(parsed);
      this.nextSegmentIdx = resumeIdx;
      this._emit('playlist', {
        live: parsed.live,
        segments: parsed.segments.length,
        resumeIdx,
      });
      this._startPipeline(resumeIdx);
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 主流水线：循环取下一个待加载分片 -> 下载 -> 转封装 -> append         */
  /* ------------------------------------------------------------------ */

  /**
   * 启动装载流水线。
   * @param {number} [startIdx=0] 起始分片下标（切档/续播由 _loadMediaPlaylist 计算后传入）。
   *   评审 hls#3 残余修复：旧实现忽略入参恒置 0，导致 VOD 中途切档回到片头。
   */
  _startPipeline(startIdx = 0) {
    this.nextSegmentIdx = startIdx;
    // 仅首次装载清空续播锚点；切档/续播必须保留，否则直播轮询失去衔接依据
    if (!(startIdx > 0)) this._lastAppendedSn = null;
    this._pump();
    this._scheduleLivePoll();
  }

  async _pump() {
    if (this._destroyed || this._appending) return;
    const pl = this.mediaPlaylist;
    if (!pl) return;

    // 长直播 / EVENT：主动周期回收后退缓冲，抑制长会话内存增长（评审 §15.3）
    if (pl.live) this._maybeTrim();

    const buffered = this.mse.currentBufferSeconds();
    if (buffered > this.config.maxBufferSeconds) {
      // 缓冲已满，等待消耗后再继续
      this._timer('bufferfull', () => this._pump(), 1000);
      return;
    }

    if (this.nextSegmentIdx >= pl.segments.length) {
      if (!pl.live) {
        await this.mse.endOfStream();
        this._emit('ended', {});
        return;
      }
      this._timer('waitsegments', () => this._pump(), 500); // 等直播窗口推进
      return;
    }

    const seg = pl.segments[this.nextSegmentIdx];
    this._appending = true;
    try {
      // 1. EXT-X-MAP（fMP4 init segment）：URL 变化时重新加载
      if (seg.map && !this._loadedInitUrls.has(seg.map.uri)) {
        const initData = await this.loader.load(seg.map.uri, {
          byteRange: seg.map.byteRange || undefined,
          signal: this._abortCtrl.signal,
        });
        this._stats.bytesLoaded += initData.byteLength;
        const mCodecs = this.levels
          ? { video: this.levels.current.videoCodec, audio: this.levels.current.audioCodec }
          : { video: '', audio: '' };
        await this._ensureSourceBuffers(mCodecs);
        if (!this.mse.sourceBuffers.video && !this.mse.sourceBuffers.audio && !this._audioOnlyHint) {
          // master 无 CODECS 且无兜底：默认按含视频流处理（EXT-X-MAP 存在即 fMP4 流）
          this.mse.addSourceBuffer('video', 'video/mp4; codecs="avc1.42E01E"');
        }
        if (!this.mse.sourceBuffers.video && !this.mse.sourceBuffers.audio) {
          this.mse.addSourceBuffer('audio', 'audio/mp4; codecs="mp4a.40.2"');
        }
        await this._append(initData.data, 'video');
        this._loadedInitUrls.add(seg.map.uri);
      }

      // 2. 加载媒体分片
      const t0 = performanceNow();
      const res = await this.loader.load(seg.url, {
        byteRange: seg.byteRange || undefined,
        signal: this._abortCtrl.signal,
        onProgress: () => {},
      });
      const elapsed = Math.max(1, performanceNow() - t0);
      this._stats.bytesLoaded += res.byteLength;
      this._stats.segmentsLoaded += 1;

      // 2.5 解密层（契约 §2.6）：SAMPLE-AES 等在 assertSupported 即抛 NOT_SUPPORTED
      let segmentBytes = res.data;
      if (seg.key && seg.key.method !== 'NONE') {
        this.decrypter.assertSupported(seg.key); // 尽早失败，避免下载后才发现不支持
        segmentBytes = await this.decrypter.decryptSegment(res.data, seg.key, {
          sn: seg.sn,
        });
      }

      // 3. 回填带宽样本并复核 ABR
      if (this.levels) {
        this.levels.reportLoad(res.byteLength, elapsed, buffered, (sw) => {
          this._stats.levelsSwitched += 1;
          this._emit('levelswitch', sw);
          // 切档续播：以最近装载的 sn 为锚点，在新档位清单中衔接（不从片头重放）
          this._loadMediaPlaylist(this.levels.current.url, { afterSn: this._lastAppendedSn });
        });
      }

      // 4. 识别格式并转封装（TS → fMP4；fMP4 直通）
      if (!this.transmuxer) this.transmuxer = new Transmuxer();
      const out = await this.transmuxer.process(segmentBytes, {
        isInit: false,
        discontinuity: !!seg.discontinuity,
      });

      // 5. 确保 SourceBuffer 就绪（拿到真实编码串后再建）
      const codecs =
        out.kind === 'transmuxed'
          ? out.codecs
          : this.levels
            ? { video: this.levels.current.videoCodec, audio: this.levels.current.audioCodec }
            : { video: '', audio: '' };
      if (out.kind === 'transmuxed') {
        // 转封装产物是权威信号：只有音频产出 ⇒ 标记纯音频流
        if (out.audio && !out.video) this._audioOnlyHint = true;
      } else if (!codecs.video && codecs.audio) {
        this._audioOnlyHint = true;
      }
      await this._ensureSourceBuffers(codecs);

      // 6. append：转封装产物按轨追加；直通产物进视频轨
      if (out.kind === 'transmuxed') {
        for (const key of ['video', 'audio']) {
          const t = out[key];
          if (!t) continue;
          if (t.initSegment && this.mse.sourceBuffers[key]) {
            await this._append(t.initSegment, key);
          }
          if (this.mse.sourceBuffers[key]) {
            await this._append(t.mediaSegment, key);
          }
        }
      } else {
        await this._append(out.mediaSegment, 'video');
      }

      this._emit('bufferappended', {
        sn: seg.sn,
        duration: seg.duration,
        buffered: this.mse.currentBufferSeconds(),
      });
      this._lastAppendedSn = seg.sn;

      this.nextSegmentIdx += 1;

      // 断点续接：discontinuity 后时间线跳变由 fMP4 内部 tfdt 保证，无需特殊处理；
      // 若浏览器报重叠错误可在此触发 remove()（见 README 已知限制）

      // 自动起播：首帧数据就位即尝试播放
      this._maybeAutoplay();

      this._appending = false;
      this._pump(); // 继续装载
    } catch (err) {
      this._appending = false;
      if (err && err.name === 'AbortError') return; // 主动取消
      this._fail(err);
    }
  }

  async _ensureSourceBuffers(codecs) {
    if (this.mse.sourceBuffers.video || this.mse.sourceBuffers.audio) return;
    const vc = codecs?.video || '';
    const ac = codecs?.audio || '';
    if (vc) {
      this.mse.addSourceBuffer('video', buildMime(vc, ''));
    }
    if (ac) {
      this.mse.addSourceBuffer('audio', buildMime('', ac));
    }
    // CODECS 全缺失时的兜底：仅对确有视频内容的流强建视频轨。
    // 纯音频流（如音频 Rendition）强建 avc1 视频轨必然失败，改为建音频轨。
    if (!vc && !ac) {
      const audioOnlyHint = this._audioOnlyHint === true;
      if (audioOnlyHint) {
        this.mse.addSourceBuffer('audio', 'audio/mp4; codecs="mp4a.40.2"');
      } else {
        this.mse.addSourceBuffer('video', 'video/mp4; codecs="avc1.42E01E"');
      }
    }
  }

  /**
   * 长直播 / EVENT 会话的后退缓冲周期回收（评审 §15.3）。
   * 仅对 live 清单生效，避免误删 VOD 的可 seek 缓冲。fire-and-forget + 重入保护，
   * 不阻塞 append 流水线；remove 经 MseController 同类型队列串行化，与 append 不冲突。
   */
  _maybeTrim() {
    if (this._trimming) return;
    this._trimming = true;
    this.mse
      .trim({
        behindSec: this.config.backBufferSeconds,
        aheadSec: this.config.maxBufferSeconds,
      })
      .catch(() => {
        /* 修剪失败不影响播放流水线 */
      })
      .finally(() => {
        this._trimming = false;
      });
  }

  async _append(data, type) {
    try {
      await this.mse.append(type, data);
    } catch (err) {
      // 缓冲重叠等异常：移除全部旧缓冲重试一次
      log.warn(`append 失败(${err.message})，尝试清空旧缓冲重试`);
      const ranges = this.mse.getBuffered(type);
      if (ranges.length) {
        await this.mse.remove(type, ranges[0][0], ranges[ranges.length - 1][1]);
        await this.mse.append(type, data);
      } else {
        throw err;
      }
    }
  }

  _maybeAutoplay() {
    const v = this.mse.video;
    if (v && v.paused && v.readyState >= 3 && !v.autoplayGuard) {
      v.autoplayGuard = true;
      v.play().catch(() => {
        // 浏览器自动播放策略拦截：保持暂停状态等待用户手势
        log.warn('自动播放被浏览器策略阻止，等待用户交互');
      });
    }
  }

  /**
   * 播放饥饿快速降档（评审 §18.3）：video 'waiting' 且缓冲近零时触发。
   * 手动锁定档位 / 无多码率 / 非播放中（paused）在 handleStall 或前置闸被过滤；
   * 切档后以最近装载 sn 为锚点在新档位清单衔接，避免从片头重放。
   */
  _maybeStallDowngrade() {
    if (this._destroyed || !this.levels) return;
    const v = this.mse.video;
    if (!v || v.paused) return;
    if (this.mse.currentBufferSeconds() > 1.5) return;
    const sw = this.levels.handleStall();
    if (sw) {
      this._stats.levelsSwitched += 1;
      this._emit('levelswitch', sw);
      this._loadMediaPlaylist(this.levels.current.url, { afterSn: this._lastAppendedSn });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 直播轮询                                                            */
  /* ------------------------------------------------------------------ */

  /** TARGETDURATION 违例诊断（解析器已把声明值自愈提升至实际最大分片时长，此处仅提示、不静默） */
  _checkTdViolation(pl) {
    if (pl && pl.type === 'media' && pl.targetDurationViolations) {
      log.warn(
        `TARGETDURATION 违例：${pl.targetDurationViolations} 个分片 EXTINF 超过声明值，` +
          `targetDuration 已自愈提升至 ${pl.targetDuration}s`
      );
    }
  }

  _scheduleLivePoll() {
    if (this._destroyed || !this.mediaPlaylist || !this.mediaPlaylist.live) return;
    const sc = this.mediaPlaylist.serverControl;
    const target = this.mediaPlaylist.targetDuration || 6;
    // 规范建议：普通 HLS 至少 target duration 后刷新；LL-HLS 按 part-hold-back
    let intervalSec = target / 2;
    if (sc && sc.partHoldBack > 0 && this.config.lowLatencyMode) intervalSec = sc.partHoldBack;
    else if (sc && sc.holdBack > 0) intervalSec = sc.holdBack;
    const delayMs = Math.max(400, intervalSec * 1000);

    this._pollTimer = setTimeout(async () => {
      if (this._destroyed) return;
      try {
        const url = this._buildReloadUrl();
        const text = await this.loader.loadText(url, this._abortCtrl.signal);
        const prev = this.mediaPlaylist;
        const next = parseMedia(text, this.playlistUrl);
        // 滑动窗口推进：以最近成功消费的 sn 为锚点衔接
        const anchorSn = this._lastAppendedSn ?? prev.segments[prev.segments.length - 1]?.sn ?? next.mediaSequence - 1;
        this.mediaPlaylist = next;
        this._checkTdViolation(next);
        this.nextSegmentIdx = computeResumeIndexBySn(next.segments, anchorSn);
        this._emit('liverefresh', { msn: next.mediaSequence, pending: next.segments.length - this.nextSegmentIdx });
        this._pump();
      } catch (err) {
        log.warn('直播刷新失败:', err.message);
        this._emit('error', { type: 'network', fatal: false, detail: err.message });
      } finally {
        this._scheduleLivePoll();
      }
    }, delayMs);
  }

  /**
   * 构造下一次轮询 URL。
   * 支持 LL-HLS 的阻塞式重载（_HLS_msn/_HLS_part），服务器支持时可显著降低无效请求。
   */
  _buildReloadUrl() {
    const pl = this.mediaPlaylist;
    const sc = pl.serverControl;
    if (!(sc && sc.canBlockReload)) return this.playlistUrl;
    const lastSeg = pl.segments[pl.segments.length - 1];
    const msn = lastSeg ? lastSeg.sn + 1 : pl.mediaSequence;
    let part = null;
    const lastWithParts = [...pl.segments].reverse().find((s) => s.parts.length);
    if (lastWithParts) part = lastWithParts.parts.length;
    const u = new URL(this.playlistUrl);
    u.searchParams.set('_HLS_msn', String(msn));
    if (part != null) u.searchParams.set('_HLS_part', String(part));
    return u.href;
  }

  /* ------------------------------------------------------------------ */
  /* 控制接口                                                            */
  /* ------------------------------------------------------------------ */

  /** 手动切换清晰度；index=-1 恢复 auto */
  setLevel(index) {
    if (!this.levels) throw stateError('当前源为单码率，无清晰度可切换');
    const sw = this.levels.switchTo(index);
    if (sw) {
      this._stats.levelsSwitched += 1;
      this._emit('levelswitch', sw);
      this._loadMediaPlaylist(this.levels.current.url, { afterSn: this._lastAppendedSn });
    }
    return sw;
  }

  get currentLevel() {
    return this.levels ? this.levels.currentLevel : -1;
  }

  get stats() {
    return {
      ...this._stats,
      bandwidthBps: this.levels ? Math.round(this.levels.bandwidthEstimator.bandwidth) : 0,
      bufferSeconds: this.mse.currentBufferSeconds(),
      state: this.state,
    };
  }

  play() {
    return this.mse.video && this.mse.video.play();
  }

  pause() {
    if (this.mse.video) this.mse.video.pause();
  }

  _timer(key, fn, ms) {
    clearTimeout(this[`_t_${key}`]);
    this[`_t_${key}`] = setTimeout(fn, ms);
  }

  _fail(err) {
    if (this._destroyed) return;
    this._setState(PlayerState.ERROR);
    const info = {
      type: err instanceof LoadError ? (err.network ? 'network' : 'other') : 'mse',
      fatal: !(err instanceof LoadError) || err.fatal,
      detail: err.message,
      error: err,
    };
    this._emit('error', info);
    log.error(info.type, err.message);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._abortCtrl) this._abortCtrl.abort();
    clearTimeout(this._pollTimer);
    clearTimeout(this._t_bufferfull);
    clearTimeout(this._t_waitsegments);
    if (this.transmuxer) this.transmuxer.destroy();
    // 解绑 video waiting 监听（mse.destroy 会清空 video 引用，须先摘除）
    this.mse.video?.removeEventListener('waiting', this._onVideoWaiting);
    this.mse.destroy();
    this.events.removeAllListeners();
    this._setState(PlayerState.DESTROYED);
  }
}

function performanceNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
