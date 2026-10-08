import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRange } from '../js/skin.js';

class FakeClassList {
  #values = new Set();
  add(name) { this.#values.add(name); }
  remove(name) { this.#values.delete(name); }
  toggle(name, force) {
    if (force === undefined ? !this.#values.has(name) : force) this.add(name);
    else this.remove(name);
  }
  contains(name) { return this.#values.has(name); }
}

class FakeElement {
  constructor(tagName, parent = null) {
    this.tagName = tagName.toUpperCase();
    this.parentElement = parent;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.min = '0';
    this.max = '100';
    this.value = '20';
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(item => item !== listener));
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === '.controls' && node.classList.contains('controls')) return node;
      if (selector === '.stage' && node.classList.contains('stage')) return node;
      node = node.parentElement;
    }
    return null;
  }
  replaceWith() {}
  appendChild() {}
  setAttribute() {}
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  remove() {}
}

function withGlobals(fn) {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedEvent = Object.getOwnPropertyDescriptor(globalThis, 'Event');
  const controls = new FakeElement('div');
  controls.classList.add('controls');
  const stage = new FakeElement('div');
  stage.classList.add('stage');
  controls.parentElement = stage;
  const range = new FakeElement('input', controls);
  const window = new FakeElement('window');
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => new FakeElement('span') },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'Event', {
    value: class Event { constructor(type) { this.type = type; } },
    configurable: true,
  });
  try {
    return fn({ controls, stage, range, window });
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete globalThis.document;
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete globalThis.window;
    if (savedEvent) Object.defineProperty(globalThis, 'Event', savedEvent);
    else delete globalThis.Event;
  }
}

test('bindRange：pointercancel 清除拖动态并撤销监听', () => {
  withGlobals(({ controls, stage, range, window }) => {
    const dispose = bindRange(range);
    range.dispatchEvent(new Event('pointerdown'));
    assert.equal(controls.classList.contains('is-scrubbing'), true);
    assert.equal(stage.classList.contains('is-scrubbing'), true);

    window.dispatchEvent(new Event('pointercancel'));
    assert.equal(controls.classList.contains('is-scrubbing'), false);
    assert.equal(stage.classList.contains('is-scrubbing'), false);

    range.dispatchEvent(new Event('pointerdown'));
    dispose();
    window.dispatchEvent(new Event('pointercancel'));
    assert.equal(controls.classList.contains('is-scrubbing'), false, 'disposer 应复位拖动态并移除监听');
    assert.equal(stage.classList.contains('is-scrubbing'), false);
  });
});
