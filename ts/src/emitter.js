/**
 * emitter.js —— 极简事件发射器
 *
 * 解析层统一接口依赖 5 个事件：tracks / sample / metadata / complete / error。
 * 不引第三方依赖，各模块各自内联同一份实现（约 40 行），保持模块独立可拷贝。
 */

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /**
   * 订阅事件
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void} 取消订阅函数
   */
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('on(event, fn): fn 必须是函数');
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    const set = this._handlers.get(event);
    if (set) set.delete(fn);
  }

  /**
   * 触发事件；监听器抛出的异常统一转发到 'error'，
   * 避免 demuxer 内部回调把整个解析循环打断。
   */
  emit(event, ...args) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        if (event !== 'error') this.emit('error', err);
        else console.error('emitter: error 处理器自身抛出异常', err);
      }
    }
  }

  removeAllListeners() {
    this._handlers.clear();
  }
}
