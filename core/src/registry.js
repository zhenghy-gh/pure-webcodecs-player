/**
 * Demuxer 注册表（CONTRACTS §10 模块注册约定的 core 收口实现）。
 *
 * 各容器模块 src/index.js 按契约形状导出：
 *   containerName / extensions / mimeTypes /
 *   probe(bytes)->ProbeResult|null / createDemuxer(source,options)->Promise<Demuxer> / 主类
 *
 * 本表提供：
 *   registerDemuxer(module)            注册（幂等：按 containerName 去重覆盖）
 *   probeBuffer(bytes)                 遍历注册项，confidence 最高者胜；无 ≥0.8 命中返回 null
 *   createDemuxerAuto(source,options)  探测→胜者 createDemuxer；全部不识别 reject PROBE_FAILED
 *   detectFromUrl(url,options)         取头部 4KiB 后走 probeBuffer（fetchImpl 可注入离线测试）
 */
import { probeFailed } from './errors.js';

/** @type {Array<{containerName:string, extensions?:string[], mimeTypes?:string[], probe:Function, createDemuxer:Function}>} */
const MODULES = [];

/**
 * 注册一个容器模块（幂等：同 containerName 覆盖）。
 * @param {{containerName:string, probe:Function, createDemuxer:Function, extensions?:string[], mimeTypes?:string[]}} module
 */
export function registerDemuxer(module) {
  if (!module || typeof module.probe !== 'function' || typeof module.createDemuxer !== 'function') {
    throw new TypeError('registerDemuxer: module must provide probe() and createDemuxer()');
  }
  const i = MODULES.findIndex((m) => m.containerName === module.containerName);
  if (i >= 0) MODULES[i] = module;
  else MODULES.push(module);
  return module;
}

/** 注销（测试用） */
export function unregisterDemuxer(containerName) {
  const i = MODULES.findIndex((m) => m.containerName === containerName);
  if (i >= 0) MODULES.splice(i, 1);
}

/** 清空并可选重注册（测试隔离用） */
export function resetRegistry() {
  MODULES.length = 0;
}

/** 当前已注册模块快照 */
export function listRegistered() {
  return MODULES.map((m) => ({
    containerName: m.containerName,
    extensions: m.extensions ?? [],
    mimeTypes: m.mimeTypes ?? [],
  }));
}

/**
 * 字节嗅探：遍历注册表取置信度最高者。
 * @param {Uint8Array} bytes 建议 ≥64B（最好 4KiB）
 * @returns {ProbeResult|null} 无任何 ≥0.8 命中时为 null
 */
export function probeBuffer(bytes) {
  let best = null;
  let bestScore = 0;
  for (const m of MODULES) {
    try {
      const r = m.probe(bytes);
      if (r && r.confidence > bestScore) {
        best = r;
        bestScore = r.confidence;
      }
    } catch {
      /* 单个模块嗅探异常按未命中处理（§2.2 probe 不抛异常的兜底） */
    }
  }
  return bestScore >= 0.8 ? best : null;
}

/** 从数据源读头部字节（供探测），size 未知的流式源最多读 4KiB */
async function readHead(source, len = 4096) {
  const size = typeof source.size === 'number' ? source.size : null;
  const n = size === null ? len : Math.min(len, size);
  if (n <= 0) return new Uint8Array(0);
  return source.read(0, n);
}

/**
 * 自动选路工厂：探测→胜者建 demuxer 并 open。
 * @param {DataSource|ChunkSource} source
 * @param {{options?: object, headBytes?: Uint8Array}} [opts]
 *   options: 透传给具体 createDemuxer 的初始化参数
 *   headBytes: 调用方已读出的头部（避免重复 IO）
 * @returns {Promise<Demuxer>}
 */
export async function createDemuxerAuto(source, opts = {}) {
  const head = opts.headBytes ?? await readHead(source);
  const hit = probeBuffer(head);
  if (!hit) {
    const detail = {};
    for (const m of MODULES) {
      try {
        const r = m.probe(head);
        detail[m.containerName] = r?.confidence ?? 0;
      } catch {
        detail[m.containerName] = 0;
      }
    }
    throw probeFailed('所有已注册 demuxer 均无法识别该数据', detail);
  }
  const winner = MODULES.find((m) => m.containerName === hit.container);
  if (!winner) {
    throw probeFailed(`探测命中 ${hit.container} 但未注册对应模块`, { hit });
  }
  return winner.createDemuxer(source, opts.options ?? {});
}

/**
 * URL 入口：Range 拉头部 4KiB → 探测 → 用 HttpRangeDataSource 建完整 demuxer。
 * @param {string} url
 * @param {{options?: object, fetchImpl?: typeof fetch}} [opts]
 */
export async function detectFromUrl(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== 'function') {
    throw probeFailed('detectFromUrl: fetch unavailable in this environment');
  }
  const res = await fetchImpl(url, { headers: { Range: 'bytes=0-4095' } });
  if (!res.ok && res.status !== 206) {
    throw probeFailed(`detectFromUrl: head request failed (${res.status})`, { status: res.status });
  }
  const head = new Uint8Array(await res.arrayBuffer());
  if (res.body) {
    // arrayBuffer() 已消费流：cancel 可能以被拒绝的 Promise 形式出现，必须显式吞掉
    try {
      await Promise.resolve(res.body.cancel()).catch(() => {});
    } catch {
      /* 忽略 */
    }
  }
  const hit = probeBuffer(head);
  if (!hit) {
    throw probeFailed('所有已注册 demuxer 均无法识别该 URL 内容');
  }
  // HttpRangeDataSource 延迟引入避免循环依赖（其自身只依赖 errors/codec-string）
  const { HttpRangeDataSource } = await import('./http-range-source.js');
  const source = new HttpRangeDataSource(url, { fetchImpl });
  const winner = MODULES.find((m) => m.containerName === hit.container);
  return winner.createDemuxer(source, opts.options ?? {});
}
