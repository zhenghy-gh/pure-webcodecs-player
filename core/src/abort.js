/**
 * AbortSignal 竞速原语 —— CONTRACTS v0.2 §12.3 演进项。
 *
 * 背景：§12.3 冻结 `readSample(trackId)` 签名，但明确「**新增可选成员 = 允许**
 * （minor 版本）」，仅删除 / 改名 / 改语义才需 captain+leader 双签。本模块为
 * `readSample(trackId, options?)` 的可选 `options.signal` 提供底层能力：
 *
 * - **不传 signal → 行为与冻结版完全一致**（`raceAbort` 直接返回原 promise，
 *   不包一层 Promise、不注册监听器），既有调用方零感知、零开销。
 * - 传 signal 且已 aborted → 同步 reject `ABORTED`，不等待底层 IO。
 * - 传 signal 且运行中 abort → reject `ABORTED`（PlayerError 十码之一，
 *   构造器为既有 `abortedError`），底层 promise 继续飞行但不再被等待。
 *
 * 设计取舍（勿擅自改动）：
 * - **abort 不 emit('error')**。'error' 事件语义是「模块内部故障」，而 abort 是
 *   调用方主动取消，属预期控制流；由 `readSample` 直接向上抛，不污染事件面。
 * - **abort 不推进迭代器状态**。`entry.done` 保持原值，中断后仍可继续 `readSample`
 *   续读（异步生成器会串行排队，不丢样本）；这与 destroy 的终态语义不同。
 * - **不接管 destroy 的实时性**。§41 已用「标记 done + 清空映射」工程化缓解
 *   destroy 挂起，并明确不引入 AbortSignal 作为隐式机制；本原语只服务
 *   **调用方显式传入**的场景，不改变 destroy 默认行为。
 */

import { abortedError } from './errors.js';

/**
 * 同步前置检查：signal 已中断则立即抛 ABORTED。
 * 用于 readSample 入口，避免已取消的调用仍触碰数据源。
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message]
 * @returns {void}
 * @throws {import('./errors.js').PlayerError} ABORTED
 */
export function throwIfAborted(signal, message = 'aborted') {
  if (signal && signal.aborted) {
    throw abortedError(message, { reason: signal.reason });
  }
}

/**
 * 让 promise 可被 signal 中断。
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|null|undefined} signal 为 null/undefined 时原样返回（零开销直通）
 * @param {string} [message]
 * @returns {Promise<T>} 中断时 reject PlayerError('ABORTED')
 */
export function raceAbort(promise, signal, message = 'aborted') {
  if (!signal) return /** @type {Promise<T>} */ (promise);

  if (signal.aborted) {
    // 已中断：仍要消费底层 promise，避免后续真实 reject 变成 unhandled rejection
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortedError(message, { reason: signal.reason }));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortedError(message, { reason: signal.reason }));
    };
    const cleanup = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return; // 已被 abort 抢先 reject，丢弃落地结果
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      },
    );
  });
}
