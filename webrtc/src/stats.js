/**
 * stats.js —— WebRTC 延迟与质量统计（getStats 提取层）
 *
 * 指标口径（全部为可解释的公开标准字段，不猜内部实现）：
 *  - RTT：nominated/succeeded 的 candidate-pair.currentRoundTripTime（秒）
 *  - 码率：inbound-rtp.bytesReceived 差分
 *  - 丢包/抖动：packetsLost / jitter（秒）
 *  - 解码帧：framesDecoded / framesDropped / framesPerSecond
 *  - 播放端缓冲延迟：jitterBufferDelay / jitterBufferEmittedCount 的商（秒）
 *  - 端到端延迟估计：remote-outbound-rtp.remoteTimestamp 与本地收到时刻的差
 *    （仅当服务端开启 remote-outbound 报告时可用；标注 estimated）
 *
 * extractMetrics(report, prev) 为纯函数，Node 可直接单测。
 */

/** @param {number|null} v 秒 → 毫秒 */
const sec2ms = (v) => (v == null ? null : Math.round(v * 1000));

/**
 * 从一次 getStats 输出中提取结构化指标。
 * @param {Map<string,Object>|Array<Object>} report RTCStatsReport 或其可迭代形态
 * @param {{bytesVideo?:number, bytesAudio?:number, ts?:number}} [prev] 上次采样（用于差分）
 * @param {()=>number} [clock] 时间源注入（测试用；缺省 Date.now）
 * @returns {object} metrics
 */
export function extractMetrics(report, prev = {}, clock = Date.now) {
  const now = clock();
  const out = {
    timestamp: now,
    rttMs: null,
    video: { kbps: null, packetsLost: 0, jitterMs: null, framesDecoded: 0, framesDropped: 0, framesPerSecond: null, bufferDelayMs: null },
    audio: { kbps: null, packetsLost: 0, jitterMs: null, bufferDelayMs: null },
    latencyEstimateMs: null,
  };

  const entries = typeof report.entries === 'function'
    ? [...report.entries()].map(([, v]) => v)
    : [...report];

  let pairRttSec = null;

  for (const s of entries) {
    if (!s || typeof s !== 'object') continue;
    switch (s.type) {
      case 'candidate-pair': {
        // 优先 nominated 且 succeeded 的配对
        if ((s.nominated || s.selected) && s.state === 'succeeded' && s.currentRoundTripTime != null) {
          if (pairRttSec == null || (s.selected && !out._selected)) {
            pairRttSec = s.currentRoundTripTime;
          }
        }
        break;
      }
      case 'inbound-rtp': {
        const kind = s.kind || s.mediaType;
        if (!kind || !out[kind]) break;
        const bucket = out[kind];
        bucket.packetsLost = Math.max(0, s.packetsLost ?? bucket.packetsLost);
        if (s.jitter != null) bucket.jitterMs = sec2ms(s.jitter);

        // 差分码率
        const bytesKey = kind === 'video' ? 'bytesVideo' : 'bytesAudio';
        if (prev[bytesKey] != null && s.bytesReceived != null) {
          const dtSec = (now - (prev.ts ?? now)) / 1000;
          if (dtSec > 0.05) {
            bucket.kbps = Math.max(0, Math.round(((s.bytesReceived - prev[bytesKey]) * 8) / dtSec / 1000));
          }
        }
        if (kind === 'video') {
          // framesDecoded/framesDropped 规范上单调递增。浏览器某次 report 缺
          // 这些字段时不应归零（bucket 初始 0），而应保留上一轮值：把
          // framesDecoded/framesDropped 也纳入 nextPrev 通道，回退顺序：
          // 当前报告 → prev → bucket 初始（恒 0，作为最终兜底）。
          const prevFrames = prev.framesDecoded ?? bucket.framesDecoded;
          const prevDropped = prev.framesDropped ?? bucket.framesDropped;
          bucket.framesDecoded = s.framesDecoded ?? prevFrames;
          bucket.framesDropped = s.framesDropped ?? prevDropped;
          bucket.framesPerSecond = s.framesPerSecond ?? null;
        }
        // 播放端抖动缓冲平均驻留
        if (s.jitterBufferDelay != null && s.jitterBufferEmittedCount > 0) {
          bucket.bufferDelayMs = sec2ms(s.jitterBufferDelay / s.jitterBufferEmittedCount);
        }
        // 记录供下一次差分
        out[`_${bytesKey}`] = s.bytesReceived;
        break;
      }
      case 'remote-outbound-rtp': {
        if (s.remoteTimestamp) {
          const sentAt = Date.parse(s.remoteTimestamp);
          if (!Number.isNaN(sentAt)) {
            out.latencyEstimateMs = Math.max(0, now - sentAt);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  out.rttMs = sec2ms(pairRttSec);

  return {
    ...out,
    /** 下一次采样的 prev 参数（调用方原样传回即可） */
    nextPrev: {
      bytesVideo: out._bytesVideo ?? prev.bytesVideo ?? null,
      bytesAudio: out._bytesAudio ?? prev.bytesAudio ?? null,
      framesDecoded: out.video.framesDecoded,
      framesDropped: out.video.framesDropped,
      ts: now,
    },
    _bytesVideo: undefined,
    _bytesAudio: undefined,
    _selected: undefined,
  };
}

/**
 * 周期采集器。
 * @param {RTCPeerConnection|null} pc
 * @param {number} intervalMs
 */
export class StatsCollector {
  constructor(pc, intervalMs = 2000) {
    this.pc = pc;
    this.intervalMs = intervalMs;
    this.latest = null;
    this._timer = null;
    this._prev = {};
  }

  /** 开始采集；每轮回调最新指标 */
  start(onSample) {
    const tick = async () => {
      if (!this.pc || this.pc.connectionState === 'closed') return;
      try {
        const report = await this.pc.getStats();
        const m = extractMetrics(report, this._prev);
        this._prev = m.nextPrev;
        delete m.nextPrev;
        this.latest = m;
        onSample(m);
      } catch {
        /* getStats 失败不中断播放 */
      }
      this._timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }
}
