import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRange } from '../skin.js';

class FakeClassList {
  #values = new Set();
  add(name) { this.#values.add(name); }
  remove(name) { this.#values.delete(name); }
  contains(name) { return this.#values.has(name); }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.min = '0';
    this.max = '100';
    this.value = '50';
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== listener));
  }
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
  }
  setAttribute() {}
  closest() { return null; }
}

function withWindow(fn) {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = new FakeElement();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });
  try { return fn(window); }
  finally {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete globalThis.window;
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete globalThis.document;
  }
}

test('bindRange：pointercancel 清理拖动态，disposer 同样复位并撤销监听', () => {
  withWindow(window => {
    const range = new FakeElement();
    const dispose = bindRange(range);
    range.dispatchEvent({ type: 'input', target: range });
    assert.equal(range.classList.contains('is-scrubbing'), true);

    window.dispatchEvent({ type: 'pointercancel' });
    assert.equal(range.classList.contains('is-scrubbing'), false);

    range.dispatchEvent({ type: 'input', target: range });
    dispose();
    assert.equal(range.classList.contains('is-scrubbing'), false);
    range.classList.add('is-scrubbing');
    window.dispatchEvent({ type: 'pointercancel' });
    assert.equal(range.classList.contains('is-scrubbing'), true, 'disposer 后不应执行已移除监听');
  });
});
