/**
 * 迷你事件发射器（CONTRACTS v0.2 §2.3 规范的自实现版本）。
 *
 * - 不依赖 DOM EventTarget（Node 测试环境可用）；
 * - 监听器抛错只记日志，不影响管线与其它监听器；
 * - 契约事件名全集（demuxer 侧）：'error' / 'media-info' / 'sample' / 'progress' / 'end'；
 *   player 侧另有 'statechange'/'timeupdate'/'ended'/'firstframe'/'trackschange'/'cue'/'stall'/'underrun'。
 * - `'error'` 与 Promise rejection 双通道并存，消费方两侧都要接。
 */
export class Emitter {
  #listeners = new Map();

  /**
   * 订阅事件
   * @param {string} event 事件名
   * @param {(payload?: any) => void} fn 回调
   * @returns {() => void} 取消订阅函数
   */
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let list = this.#listeners.get(event);
    if (!list) {
      list = [];
      this.#listeners.set(event, list);
    }
    list.push(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.#listeners.delete(event);
  }

  /**
   * 同步派发事件；单个监听器抛错只记日志（契约：禁止影响管线）。
   * @param {string} event
   * @param {any} [payload]
   * @returns {boolean} 是否存在监听器
   */
  emit(event, ...args) {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) {
      try {
        fn(...args);
      } catch (err) {
        // 契约 §2.3：其余监听器抛错只记日志
        console.error(`[emitter] listener error for "${event}"`, err);
      }
    }
    return true;
  }

  removeAllListeners(event = undefined) {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  listenerCount(event) {
    const list = this.#listeners.get(event);
    return list ? list.length : 0;
  }
}
