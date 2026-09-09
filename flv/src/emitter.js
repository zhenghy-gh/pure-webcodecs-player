/**
 * emitter.js —— 极简事件发射器（与 ts/src 同一份实现，模块保持独立可拷贝）
 */

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

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
