/**
 * utils.js —— 轻量工具集
 *
 * PlayerError 直接复用 core 定稿实现（十码封闭枚举，签名 (code, message)），
 * 本模块不再私设错误类型（契约 §11.3 / §0.1）。
 */
import { PlayerError, ErrorCode } from '../../core/src/errors.js';
export { PlayerError, ErrorCode };

/** 极简 EventEmitter（on/off/once/emit） */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, set = new Set());
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        // 单个监听器异常不阻断其他监听器
        console.error(`[emitter:${type}]`, err);
      }
    }
  }
}

/** 带超时的 Promise 竞速；超时抛 PlayerError('TIMEOUT')（契约 §11.3） */
export function withTimeout(promise, ms, tag = 'operation') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new (PlayerError)('TIMEOUT', `${tag} 超时(${ms}ms)`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** 字节数人性化显示（demo/UI 复用） */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
