/**
 * llhls-parts.js —— LL-HLS part 加载策略骨架
 *
 * LL-HLS 的播放端核心问题：
 *  - 何时刷新清单（阻塞重载 ?_HLS_msn&_HLS_part）；
 *  - part 时间线的状态管理（pending/loading/ready/gap）；
 *  - preload hint 预测下一个 part 提前发起请求；
 *  - 从最近的 INDEPENDENT part 快速起播。
 *
 * 本文件是纯逻辑骨架：不做 IO，输入输出皆为可序列化对象，
 * 由 hls/ 或统一内核的加载器驱动。Node 可直接单测。
 */

/** 单个 part 的状态 */
export const PartState = Object.freeze({
  PENDING: 'pending',     // 清单里出现但尚未决定加载
  LOADING: 'loading',     // 加载中
  READY: 'ready',         // 字节就绪可喂 demuxer
  GAP: 'gap',             // 服务端标记的空洞，跳过
});

export class PartTimeline {
  constructor({ partTargetDuration } = {}) {
    this.partTargetDuration = partTargetDuration || 0.5;
    /** @type {Map<string,{uri:string,sn:number,partIndex:number,state:string,independent:boolean,duration:number}>} */
    this.parts = new Map();
    this.lastMsn = -1;   // 最后一个完整分片序号
    this.lastPart = -1;  // 该分片内最后一个 part 下标
  }

  /** key 规则：分片序号 + part 序号，保证跨清单更新稳定 */
  static key(sn, partIndex) {
    return `${sn}:${partIndex}`;
  }

  /**
   * 用一次清单更新合并 part 信息。
   * @param {Array<{sn:number, parts:Array<{uri:string,duration:number,independent:boolean,gap:boolean}>}>} segments parseMedia().segments
   */
  updateFromPlaylist(segments) {
    for (const seg of segments) {
      seg.parts.forEach((p, i) => {
        const key = PartTimeline.key(seg.sn, i);
        const existing = this.parts.get(key);
        if (existing && existing.state !== PartState.PENDING) return; // 已推进的不回退
        this.parts.set(key, {
          uri: p.uri,
          sn: seg.sn,
          partIndex: i,
          state: p.gap ? PartState.GAP : existing?.state || PartState.PENDING,
          independent: !!p.independent,
          duration: p.duration,
        });
      });
      if (seg.parts.length) {
        this.lastMsn = Math.max(this.lastMsn, seg.sn);
        this.lastPart = Math.max(this.lastMsn === seg.sn ? this.lastPart : -1, seg.parts.length - 1);
      }
    }
  }

  /** 标记某 part 开始/结束加载 */
  markLoading(uri) {
    for (const p of this.parts.values()) if (p.uri === uri) p.state = PartState.LOADING;
  }
  markReady(uri) {
    for (const p of this.parts.values()) if (p.uri === uri) p.state = PartState.READY;
  }

  /**
   * 选出下一批应加载的 part（策略核心）：
   *  - 只加载"尾部窗口"内未完成的 PENDING（避免追赶历史）；
   *  - 起播场景优先最近一个 INDEPENDENT part。
   * @param {{startup?:boolean, maxAhead?:number}} opts
   */
  pickNext({ startup = false, maxAhead = 2 } = {}) {
    const list = [...this.parts.values()].filter((p) => p.state === PartState.PENDING);
    list.sort((a, b) => a.sn - b.sn || a.partIndex - b.partIndex);
    if (startup) {
      // 从尾部往回找最近的独立 part
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].independent) return [list[i]];
      }
      return list.length ? [list[list.length - 1]] : [];
    }
    // 常规：最多预取 maxAhead 个尾部 pending
    return list.slice(-maxAhead);
  }

  /** 是否可以开始起播（存在 READY 且其后无未完成的独立依赖） */
  canStartPlayback() {
    for (const p of this.parts.values()) {
      if (p.state === PartState.LOADING) return false;
      if (p.state === PartState.PENDING && p.independent) return false;
    }
    return [...this.parts.values()].some((p) => p.state === PartState.READY);
  }
}

/**
 * 构造阻塞式重载 URL。
 * @param {string} playlistUrl 当前媒体清单地址
 * @param {{msn:number, part?:number|null}} target
 * @returns {string} 带 _HLS_msn/_HLS_part 查询参数的地址
 */
export function buildBlockingReloadUrl(playlistUrl, { msn, part = null }) {
  const u = new URL(playlistUrl);
  u.searchParams.set('_HLS_msn', String(msn));
  if (part != null) u.searchParams.set('_HLS_part', String(part));
  return u.href;
}

/**
 * 计算下一次轮询应请求的目标位置。
 * 策略：请求"最后已知完整分片 +1"，LL-HLS 再带上 part 下标让服务端挂起直到新数据。
 * @param {{lastMsn:number,lastPart:number,serverControl:{canBlockReload:boolean}|null}} tl
 */
export function nextPollTarget(tl) {
  const msn = tl.lastMsn + 1;
  if (tl.serverControl && tl.serverControl.canBlockReload) {
    return { msn, part: Math.max(0, tl.lastPart) };
  }
  return { msn, part: null };
}

/**
 * PRELOAD-HINT 预取决策：
 * 返回 true 表示应立即对 hint URI 发起请求（比清单轮询更快拿到下一 part）。
 */
export function shouldPrefetchPreloadHint(preloadHint, timeline, { inFlight = 0, maxInFlight = 2 } = {}) {
  if (!preloadHint || preloadHint.type !== 'PART' || !preloadHint.uri) return false;
  if (inFlight >= maxInFlight) return false;
  // 时间线中已知的 part 一律不预取（含 GAP——已知空洞，重取浪费带宽）
  for (const p of timeline.parts.values()) {
    if (p.uri === preloadHint.uri) return false;
  }
  return true;
}
