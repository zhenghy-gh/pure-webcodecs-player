/**
 * WsFlvPlayer —— WebSocket-FLV（RTMP 桥接形态）播放器。
 *
 * 状态机：idle → connecting → playing ⇄ reconnecting → stopped / error
 *   - 断线自动重连：指数退避（Backoff，可配 base/factor/max/jitter），
 *     稳定运行超过 stableResetMs 后重置退避节奏；
 *   - eos 缺席的空闲断流：转发 source 的 'stall'（等待上游重推自动续播，§9.2）；
 *   - 错误码对齐 CONTRACTS §11.3（NETWORK_ERROR/TIMEOUT/PARSE_ERROR/ABORTED/STATE_ERROR）。
 *
 * 管线：GatewayChunkSource → FlvDemuxer → Fmp4Remuxer → sink
 *   - sink 可选实现：{ onInitSegment(bytes), onFragment(bytes),
 *                      onSample(sample), onTrack(track), onMetadata(meta) }
 *   - 不传 sink 时为「无头模式」，sample 事件直接外抛（供单测/自定义消费）。
 */

import { MiniEmitter } from './mini-emitter.js';
import { GatewayChunkSource } from './gateway-source.js';
import { FlvDemuxer } from './flv-demuxer.js';
import { Fmp4Remuxer } from './mp4-mux.js';
import { resolveSourceUrl } from './url.js';
import { errors } from './errors.js';

export const PLAYER_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  PLAYING: 'playing',
  RECONNECTING: 'reconnecting',
  STOPPED: 'stopped',
  ERROR: 'error',
});

export class WsFlvPlayer extends MiniEmitter {
  constructor(options = {}) {
    super();
    this.opts = {
      /** 首数据超时：连接建立后该时间内无任何字节 → TIMEOUT */
      firstDataTimeoutMs: options.firstDataTimeoutMs ?? 10000,
      /** remux 片段冲刷节奏（毫秒），直播建议 ≤1s */
      flushIntervalMs: options.flushIntervalMs ?? 500,
      /** 视为连接稳定的时长；超过后退避策略复位 */
      stableMs: options.stableMs ?? 10000,
      backoff: options.backoff ?? { baseMs: 500, factor: 2, maxMs: 30000 },
      /** 最大连续重连次数；Infinity 表示不限 */
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      sink: options.sink ?? null,
      urlResolver: options.urlResolver ?? resolveSourceUrl,
    };
    this.state = PLAYER_STATES.IDLE;
    this.stats = {
      connects: 0,
      reconnects: 0,
      bytesIn: 0,
      samples: 0,
      lastError: null,
    };
    this.mediaInfo = null;
    /** @type {{codec:string, codecString:string, description:Uint8Array, width?:number, height?:number}|null} */
    this.videoTrack = null;
    this.audioTrack = null;

    this._source = null;
    this._demuxer = null;
    this._remuxer = new Fmp4Remuxer();
    this._flushTimer = null;
    this._firstDataTimer = null;
    this._stableTimer = null;
    this._backoffAttempt = 0;
    this._userStopped = false;
    this._lastUrlInput = '';
    this._reconnectTimer = null;
    this._initSent = false;
  }

  #setState(to) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.emit('statechange', { from, to });
  }

  /**
   * 启动播放。url 支持 ws-flv:// / wss-flv:// / ws(s):// / rtmp(s):// 映射（见 url.js）。
   * @returns {Promise<void>} resolve 于首个媒体配置就绪（track 或 metadata）
   */
  async start(inputUrl) {
    if (this.state !== PLAYER_STATES.IDLE && this.state !== PLAYER_STATES.STOPPED) {
      throw errors.state(`当前状态 ${this.state} 不能 start`);
    }
    this._userStopped = false;
    this._lastUrlInput = inputUrl;
    await this.#connect(inputUrl);
  }

  async #connect(inputUrl) {
    const wsUrl = this.opts.urlResolver(inputUrl);
    this.#setState(this.stats.connects === 0 ? PLAYER_STATES.CONNECTING : PLAYER_STATES.RECONNECTING);

    // —— 每次连接使用全新的 source/demux 实例（旧实例随关闭事件自然废弃）——
    const source = new GatewayChunkSource({
      url: wsUrl,
      idleTimeoutMs: this.opts.firstDataTimeoutMs,
    });
    const demuxer = new FlvDemuxer();
    this._source = source;
    this._demuxer = demuxer;

    source.on('data', (chunk) => {
      this.stats.bytesIn += chunk.length;
      clearTimeout(this._firstDataTimer);
      if (this.state === PLAYER_STATES.CONNECTING || this.state === PLAYER_STATES.RECONNECTING) {
        this.#setState(PLAYER_STATES.PLAYING);
        this.#onStable();
      }
      demuxer.push(chunk);
    });
    source.on('meta', (meta) => this.emit('signaling', meta));
    source.on('stall', (info) => this.emit('stall', info));
    source.on('close', ({ code } = {}) => {
      demuxer.flush();
      this.#scheduleReconnect(errors.network(`网关连接被关闭(${code ?? '?'})`));
    });

    demuxer.on('header', (h) => {
      this.mediaInfo = {
        container: 'flv',
        live: true,
        durationUs: null,
        seekable: false,
        hasAudio: h.hasAudio,
        hasVideo: h.hasVideo,
        tracks: [],
      };
      this.emit('open', h);
    });
    demuxer.on('metadata', (meta) => {
      this.emit('metadata', meta);
      this.opts.sink?.onMetadata?.(meta);
    });
    demuxer.on('warn', (msg) => this.emit('warn', msg));
    demuxer.on('track', (track) => {
      if (track.kind === 'video') {
        this.videoTrack = track;
        try {
          this._remuxer.setVideoTrack(track);
        } catch (e) {
          this.#fail(e);
          return;
        }
      } else if (track.kind === 'audio') {
        this.audioTrack = track;
        try {
          this._remuxer.setAudioTrack(track);
        } catch (e) {
          this.#fail(e);
          return;
        }
      }
      if (this.mediaInfo) {
        this.mediaInfo.tracks = [...this.tracksSnapshot()];
      }
      this.emit('track', track);
      this.opts.sink?.onTrack?.(track);
      this.#startFlushLoop();
    });
    demuxer.on('sample', (sample) => {
      this.stats.samples++;
      try {
        this._remuxer.addSample(sample);
      } catch (e) {
        this.#fail(e);
        return;
      }
      this.emit('sample', sample);
      this.opts.sink?.onSample?.(sample);
    });
    demuxer.on('error', (err) => {
      this.emit('warn', err); // 解析层错误尽力恢复：不终止播放
    });

    try {
      await source.start();
    } catch (err) {
      this.#fail(err);
      throw err;
    }
    this.stats.connects++;

    // 首数据超时保护
    clearTimeout(this._firstDataTimer);
    this._firstDataTimer = setTimeout(() => {
      if (this.state === PLAYER_STATES.PLAYING) return;
      this.#scheduleReconnect(errors.timeout('连接成功但迟迟无媒体数据'));
      this.emit('error', errors.timeout('连接成功但迟迟无媒体数据（firstDataTimeout）'));
    }, this.opts.firstDataTimeoutMs);
    this._firstDataTimer.unref?.();
  }

  /** 稳定运行计时：超过 stableMs 后复位退避节奏 */
  #onStable() {
    clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      this._backoffAttempt = 0;
    }, this.opts.stableMs);
    this._stableTimer.unref?.();
  }

  #startFlushLoop() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => {
      this.flushPending({ force: false });
    }, Math.max(50, this.opts.flushIntervalMs));
    this._flushTimer.unref?.();
    this.flushPending({ force: true });
  }

  /**
   * 手动/定时冲刷 remux 队列 → sink.onInitSegment/onFragment
   * @param {{force?: boolean}} [opts] force 预留给调用方语义（定时冲刷与手动冲刷
   *   共用同一实现，当前无差异行为）；此前调用点传的布尔实参被静默忽略。
   */
  flushPending(opts) {
    if (!this._remuxer.ready) return;
    if (!this._initSent && this._remuxer.pendingSamples > 0) {
      this._initSent = true;
      this.opts.sink?.onInitSegment?.(this._remuxer.initSegment());
    }
    if (!this._remuxer.pendingSamples) return;
    const frag = this._remuxer.buildFragment();
    if (frag) this.opts.sink?.onFragment?.(frag);
  }

  /** 停止并退出状态机（不再重连） */
  stop() {
    if (this.state === PLAYER_STATES.IDLE || this.state === PLAYER_STATES.STOPPED) {
      this.state = PLAYER_STATES.STOPPED;
      this.emit('statechange', { from: PLAYER_STATES.IDLE, to: PLAYER_STATES.STOPPED });
      return;
    }
    this._userStopped = true;
    this.#teardownTimers();
    this._source?.stop();
    this._demuxer?.destroy();
    this.#setStateSafe(PLAYER_STATES.STOPPED);
  }

  #teardownTimers() {
    clearTimeout(this._firstDataTimer);
    clearTimeout(this._stableTimer);
    clearTimeout(this._reconnectTimer);
    clearInterval(this._flushTimer);
    this._flushTimer = null;
  }

  _reconnectTimer = null;

  #scheduleReconnect(err) {
    if (this._userStopped) return;
    this.stats.lastError = err;
    if (this._backoffAttempt >= this.opts.maxReconnectAttempts) {
      this.#fail(errors.network('重连次数已达上限', err));
      return;
    }
    this.stats.reconnects++;
    const delay = this.#nextBackoffMs();
    // attempt 在本计时器触发前保持不变（供断言/展示判定「这是第几次重连」）。
    // #nextBackoffMs() 内部已 ++，故此处用重连次数而非 _backoffAttempt。
    const attemptThisRound = this.stats.reconnects;
    this.#setStateSafe(PLAYER_STATES.RECONNECTING);
    this.emit('will-reconnect', { delayMs: delay, attempt: attemptThisRound, reason: err?.message });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this._userStopped) return;
      this.#connect(this._lastUrlInput).catch(() => {
        /* 连接失败已走 #fail → 继续由 close/错误路径调度下一次 */
      });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  #nextBackoffMs() {
    const { baseMs = 500, factor = 2, maxMs = 30000, jitter = 0.3 } = this.opts.backoff;
    const raw = Math.min(baseMs * factor ** this._backoffAttempt, maxMs);
    const j = raw * jitter * (Math.random() * 2 - 1);
    this._backoffAttempt++;
    return Math.max(30, Math.round(raw + j));
  }

  #fail(err) {
    this.stats.lastError = err;
    this.#setStateSafe(PLAYER_STATES.ERROR);
    this.emit('error', err);
  }

  #setStateSafe(to) {
    try {
      this.#setState(to);
    } catch {}
  }

  tracksSnapshot() {
    const out = [];
    if (this.videoTrack) out.push({ kind: 'video', ...pickPublic(this.videoTrack) });
    if (this.audioTrack) out.push({ kind: 'audio', ...pickPublic(this.audioTrack) });
    return out;
  }
}

function pickPublic(t) {
  const { kind, codec, codecString, width, height, sampleRate, numberOfChannels } = t;
  return { codec, codecString, width, height, sampleRate, numberOfChannels };
}
