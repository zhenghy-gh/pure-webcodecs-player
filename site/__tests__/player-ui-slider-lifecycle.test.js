import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerUI } from '../player-ui.js';

class FakeClassList {
  #values = new Set();
  add(name) { this.#values.add(name); }
  remove(name) { this.#values.delete(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.#values.has(name) : force;
    if (next) this.add(name); else this.remove(name);
    return next;
  }
  contains(name) { return this.#values.has(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.className = '';
    this.dataset = {};
    this.style = { width: '', left: '', setProperty() {} };
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.pointerCaptures = new Set();
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
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
  querySelector(selector) {
    const wanted = selector.startsWith('.') ? selector.slice(1) : '';
    for (const child of this.children) {
      if (wanted && (child.classList.contains(wanted) || child.className.split(/\s+/).includes(wanted))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  contains(node) {
    return node === this || this.children.some(child => child.contains(node));
  }
  set innerHTML(value) {
    this.children = [];
    const classes = [...String(value).matchAll(/class="([^"]+)"/g)];
    for (const match of classes) {
      const child = new FakeElement('div');
      for (const name of match[1].split(/\s+/)) child.classList.add(name);
      this.appendChild(child);
    }
  }
  get innerHTML() { return ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  setPointerCapture(pointerId) { this.pointerCaptures.add(pointerId); }
  releasePointerCapture(pointerId) { this.pointerCaptures.delete(pointerId); }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  remove() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
}

function withGlobals(fn) {
  const saved = ['document', 'window'];
  const descriptors = Object.fromEntries(saved.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new FakeElement('document');
  document.body = new FakeElement('body');
  document.createElement = tagName => new FakeElement(tagName);
  document.querySelector = () => null;
  const window = new FakeElement('window');
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  try { return fn({ document, window }); }
  finally {
    for (const name of saved) {
      if (descriptors[name]) Object.defineProperty(globalThis, name, descriptors[name]);
      else delete globalThis[name];
    }
  }
}

test('createPlayerUI：unbind 与 adapter 切换时取消当前滑杆拖动', () => {
  withGlobals(() => {
    const ui = createPlayerUI({ keyboard: false });
    const adapter = {
      duration: () => 10,
      currentTime: () => 2,
      seek() {},
      pause() {},
      play() {},
    };
    ui.bind(adapter);
    const progress = ui.el.querySelector('.pui__progress');

    progress.dispatchEvent({ type: 'pointerdown', clientX: 20, pointerId: 1 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), true);
    ui.unbind();
    assert.equal(progress.classList.contains('pui__progress--dragging'), false);

    ui.bind(adapter);
    progress.dispatchEvent({ type: 'pointerdown', clientX: 30, pointerId: 2 });
    ui.bind({ ...adapter });
    assert.equal(progress.classList.contains('pui__progress--dragging'), false);
    progress.dispatchEvent({ type: 'pointerdown', clientX: 40, pointerId: 3 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), true);
    ui.destroy();
  });
});

test('createPlayerUI：忽略非活动指针的滑杆移动', () => {
  withGlobals(() => {
    const ui = createPlayerUI({ keyboard: false });
    const seekCalls = [];
    ui.bind({
      duration: () => 10,
      currentTime: () => 2,
      seek: value => seekCalls.push(value),
      pause() {},
      play() {},
    });
    const progress = ui.el.querySelector('.pui__progress');

    progress.dispatchEvent({ type: 'pointerdown', clientX: 20, pointerId: 1 });
    progress.dispatchEvent({ type: 'pointermove', clientX: 90, pointerId: 2 });
    assert.deepEqual(seekCalls, [2]);
    progress.dispatchEvent({ type: 'pointermove', clientX: 40, pointerId: 1 });
    assert.deepEqual(seekCalls, [2, 4]);
    ui.destroy();
  });
});

test('createPlayerUI：连续方向键 seek 基于最近的快捷键目标累计', () => {
  withGlobals(({ window }) => {
    const ui = createPlayerUI();
    const seekCalls = [];
    ui.bind({
      duration: () => 20,
      currentTime: () => 2,
      seek: value => seekCalls.push(value),
      pause() {},
      play() {},
    });

    window.dispatchEvent({ type: 'keydown', key: 'ArrowRight', target: null, preventDefault() {} });
    window.dispatchEvent({ type: 'keydown', key: 'ArrowRight', target: null, preventDefault() {} });
    window.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', target: null, preventDefault() {} });
    assert.deepEqual(seekCalls, [7, 12, 7]);
    ui.destroy();
  });
});

test('createPlayerUI：窗口级 pointerup/pointercancel 结束滑杆拖动并在销毁时撤销', () => {
  withGlobals(({ window }) => {
    const ui = createPlayerUI({ keyboard: false });
    const seekCalls = [];
    ui.bind({
      duration: () => 10,
      currentTime: () => 2,
      seek: value => seekCalls.push(value),
      pause() {},
      play() {},
    });
    const progress = ui.el.querySelector('.pui__progress');

    progress.dispatchEvent({ type: 'pointerdown', clientX: 20, pointerId: 1 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), true);
    window.dispatchEvent({ type: 'pointerup', pointerId: 99 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), true);
    window.dispatchEvent({ type: 'pointerup', pointerId: 1 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), false);

    progress.dispatchEvent({ type: 'pointerdown', clientX: 30, pointerId: 2 });
    window.dispatchEvent({ type: 'pointercancel', pointerId: 2 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), false);

    ui.destroy();
    progress.dispatchEvent({ type: 'pointerdown', clientX: 50, pointerId: 3 });
    assert.equal(progress.classList.contains('pui__progress--dragging'), false);
    assert.equal(seekCalls.length, 2);
  });
});
