/**
 * loader.js —— webtorrent 可选依赖加载器（优雅降级入口）
 *
 * 本模块把 webtorrent 视为【可选增强依赖】：运行时按以下顺序获取，全部失败则
 * 返回 null 并由调用方进入降级模式（UI 提示 + 本地文件播放仍可用）：
 *   1. 全局已注入的 window.WebTorrent（CDN <script> 标签方式）
 *   2. 动态 import() CDN 的 ESM 构建（免 script 标签）
 *
 * README「可选依赖」一节给出两种引入方式的完整示例。
 */

import { assertSafeImportUrl } from '../../core/src/url-guard.js';
import { withTimeout } from './utils.js';

/** 默认 CDN 列表：webtorrent v2 起官方 dist 即 ESM */
export const DEFAULT_CDN_URLS = Object.freeze([
  'https://cdn.jsdelivr.net/npm/webtorrent@2/dist/webtorrent.min.js',
  'https://unpkg.com/webtorrent@2/dist/webtorrent.min.js',
]);

/**
 * 加载 WebTorrent 构造类；不可用返回 null（不抛错）。
 * @param {{cdnUrls?:string[], timeoutMs?:number}} opts
 * @returns {Promise<(typeof import('webtorrent').default)|null>}
 */
export async function loadWebTorrent(opts = {}) {
  const cdnUrls = opts.cdnUrls ?? DEFAULT_CDN_URLS;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // 1) 全局注入（经典 <script src=…> 场景；旧版本暴露为全局构造器）
  const globalCtor = globalThis.WebTorrent;
  if (typeof globalCtor === 'function') return globalCtor;

  // 2) 逐个尝试动态 import
  for (const raw of cdnUrls) {
    // I5：CDN 地址最终进入 import()，必须限制为 http(s)——
    // data:/blob: 形式的 import 可直接执行任意代码
    let url;
    try {
      url = assertSafeImportUrl(raw, { what: 'WebTorrent CDN' });
    } catch {
      continue; // 非法协议：跳过该源，继续下一个
    }
    try {
      const mod = await withTimeout(import(/* @vite-ignore */ url), timeoutMs, 'WebTorrent CDN');
      const ctor = mod?.default ?? mod?.WebTorrent ?? null;
      if (typeof ctor === 'function') return ctor;
    } catch {
      // 网络/CORS/离线/超时：尝试下一个源
    }
  }
  return null;
}
