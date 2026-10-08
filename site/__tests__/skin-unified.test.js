import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRange, syncRange, bindKeys, initSkin, isCurrentPage, formatTime, formatClockUs, toggleFullscreen, disposeFullscreen } from '../skin.js';
import { MODULES } from '../nav.js';
import { bindRange as bindLegacyRange } from '../js/skin.js';

class Element {
  constructor() {
    this.listeners = new Map(); this.attributes = new Map(); this.props = new Map(); this.classes = new Set();
    this.min = '0'; this.max = '1000'; this.value = '200'; this.dataset = {};
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name),
      toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name) };
    this.style = { setProperty: (name, value) => this.props.set(name, value) };
    this.children = [];
  }
  addEventListener(event, fn) { const list = this.listeners.get(event) || []; list.push(fn); this.listeners.set(event, list); }
  removeEventListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== fn)); }
  dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  appendChild(child) { child.parentElement?.removeChild(child); this.children.push(child); child.parentElement = this; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; }
  insertBefore(child, next) { this.appendChild(child); if (next) { this.children.pop(); this.children.splice(this.children.indexOf(next), 0, child); } }
}
async function dom(fn) {
  const originals = ['document', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const window = new Element(); const document = new Element(); document.createElement = () => new Element();
  window.location = { href: 'http://localhost/site/demo/index.html' };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  try { await fn({ window, document }); }
  finally { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } }
}

test('navigation: exact paths, directory index and subpath deployment', () => {
  assert.equal(isCurrentPage('../../hls/demo/index.html', 'https://example.org/player/hls/demo/'), true);
  assert.equal(isCurrentPage('./ref-hls.html', 'https://example.org/player/site/demo/ref-flv.html'), false);
  assert.equal(isCurrentPage('./index.html', 'https://example.org/player/site/demo/'), true);
  assert.equal(isCurrentPage('https://other.org/player/site/demo/', 'https://example.org/player/site/demo/'), false);
  assert.equal(MODULES.length, 16);
  assert.equal(new Set(MODULES.map(item => item.name)).size, 16);
  assert.ok(MODULES.every(item => item.category));
  assert.equal(new Set(MODULES.map(item => item.href)).size, 16);
});
test('formatting: seconds and microseconds remain explicit boundaries', () => {
  assert.equal(formatTime(65), '1:05'); assert.equal(formatClockUs(65_000_000), '01:05');
  assert.equal(formatTime(Infinity), '-:--'); assert.equal(formatTime(3601), '1:00:01');
});
test('range: initial/synchronized paint is not a seek, only change commits', async () => {
  await dom(() => {
    const range = new Element(); const preview = [], commits = [];
    const dispose = bindRange(range, { onInput: value => preview.push(value), onChange: value => commits.push(value) });
    assert.deepEqual(preview, []); assert.deepEqual(commits, []);
    range.value = '400'; syncRange(range); assert.equal(range.props.get('--p'), '40');
    assert.deepEqual(preview, []);
    range.dispatchEvent({ type: 'input' }); assert.deepEqual(preview, [400]); assert.deepEqual(commits, []);
    range.dispatchEvent({ type: 'change' }); assert.deepEqual(commits, [400]);
    dispose(); range.dispatchEvent({ type: 'change' }); assert.deepEqual(commits, [400]);
  });
});
test('range: rebinding has one owner, old disposer cannot remove a new binding', async () => {
  await dom(({ window }) => {
    const range = new Element(); let old = 0, current = 0;
    const first = bindRange(range, { onChange: () => old++ });
    const second = bindRange(range, { onChange: () => current++ });
    first(); range.dispatchEvent({ type: 'change' });
    assert.equal(old, 0); assert.equal(current, 1);
    range.dispatchEvent({ type: 'pointerdown' }); assert.equal(range.classes.has('is-scrubbing'), true);
    window.dispatchEvent({ type: 'pointercancel' }); assert.equal(range.classes.has('is-scrubbing'), false);
    second(); assert.equal(window.listeners.get('pointercancel').length, 0);
  });
});
test('range: minimum, buffered percentage and legacy microseconds mapping', async () => {
  await dom(() => {
    const range = new Element(); range.min = '100'; range.max = '300'; range.value = '200'; range.dataset.buffered = '80';
    syncRange(range); assert.equal(range.props.get('--p'), '50'); assert.equal(range.props.get('--b'), '80');
    range.min = '0'; range.max = '10000000'; range.value = '2000000'; range.dataset.unit = 'us';
    const calls = []; const dispose = bindLegacyRange(range, { onCommit: value => calls.push(value) });
    assert.equal(range.attributes.get('aria-valuetext'), '00:02'); assert.deepEqual(calls, []);
    range.dispatchEvent({ type: 'change' }); assert.deepEqual(calls, [2000000]); dispose();
  });
});
test('skin initialization: manually owned ranges are not rebound', async () => {
  await dom(({ document, window }) => {
    const range = new Element(); document.querySelectorAll = selector => selector === 'input.pp-range' ? [range] : [];
    let calls = 0; const manual = bindRange(range, { onChange: () => calls++ });
    const first = initSkin({ ranges: false }); const second = initSkin({ ranges: false });
    first(); assert.equal(window.__PP_SKIN_DISPOSER__, second);
    range.dispatchEvent({ type: 'change' }); assert.equal(calls, 1);
    second(); manual();
  });
});
test('keyboard: typing, focused controls and modified shortcuts stay native', async () => {
  await dom(({ window }) => {
    let calls = 0; const off = bindKeys({ ' ': () => calls++ });
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'BUTTON' }, { tagName: 'DIV', isContentEditable: true }])
      window.dispatchEvent({ type: 'keydown', key: ' ', target, preventDefault() { throw new Error('native event intercepted'); } });
    window.dispatchEvent({ type: 'keydown', key: ' ', target: null, ctrlKey: true });
    window.dispatchEvent({ type: 'keydown', key: ' ', target: null, preventDefault() {} });
    assert.equal(calls, 1); off();
    window.dispatchEvent({ type: 'keydown', key: ' ', target: null, preventDefault() {} }); assert.equal(calls, 1);
  });
});
test('fullscreen: rejection restores controls and removes listeners', async () => {
  await dom(async ({ document }) => {
    const stage = new Element(), parent = new Element(), controls = new Element(); parent.appendChild(controls);
    stage.requestFullscreen = () => Promise.reject(new Error('denied'));
    toggleFullscreen(stage, controls); await Promise.resolve();
    assert.equal(controls.parentElement, parent); assert.equal(document.listeners.get('fullscreenchange').length, 0);
    disposeFullscreen(stage);
  });
});
test('fullscreen: exit and explicit destruction restore controls idempotently', async () => {
  await dom(({ document }) => {
    const stage = new Element(), parent = new Element(), controls = new Element(); parent.appendChild(controls);
    stage.requestFullscreen = () => { document.fullscreenElement = stage; document.dispatchEvent({ type: 'fullscreenchange' }); };
    toggleFullscreen(stage, controls); assert.equal(controls.parentElement, stage); assert.equal(stage.classes.has('is-fullscreen'), true);
    document.fullscreenElement = null; document.dispatchEvent({ type: 'fullscreenchange' });
    assert.equal(controls.parentElement, parent); assert.equal(stage.classes.has('is-fullscreen'), false);
    toggleFullscreen(stage, controls); disposeFullscreen(stage); disposeFullscreen(stage);
    assert.equal(controls.parentElement, parent); assert.equal(document.listeners.get('fullscreenchange').length, 0);
  });
});

test('range: non-active pointer cancellation cannot end an active drag', async () => {
  await dom(({ window }) => {
    const range = new Element(); const off = bindRange(range);
    range.dispatchEvent({ type: 'pointerdown', pointerId: 7 });
    window.dispatchEvent({ type: 'pointercancel', pointerId: 9 }); assert.equal(range.classes.has('is-scrubbing'), true);
    window.dispatchEvent({ type: 'pointerup', pointerId: 7 }); assert.equal(range.classes.has('is-scrubbing'), false);
    off();
  });
});
test('automatic skin initialization never steals a manual binding', async () => {
  await dom(({ document }) => {
    const range = new Element(); document.querySelectorAll = selector => selector === 'input.pp-range' ? [range] : [];
    let calls = 0; const manual = bindRange(range, { onChange: () => calls++ });
    const skin = initSkin(); range.dispatchEvent({ type: 'change' }); skin(); range.dispatchEvent({ type: 'change' });
    assert.equal(calls, 2); manual();
  });
});
