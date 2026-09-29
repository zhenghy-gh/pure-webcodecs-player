import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from '../js/skin.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.style = {};
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document?.body;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    children.forEach(child => this.appendChild(child));
  }
  querySelector(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    if (className === 'toast__close') {
      return this.children.find(child => child.className === className) || null;
    }
    if (className === 'toast__title' || className === 'toast__detail') {
      return this._queryTree(className);
    }
    return null;
  }
  _queryTree(className) {
    for (const child of this.children) {
      if (child.className === className) return child;
      const found = child._queryTree?.(className);
      if (found) return found;
    }
    return null;
  }
  set innerHTML(value) {
    if (!value.includes('toast__title')) return;
    const msg = new FakeElement('span');
    const title = new FakeElement('span');
    title.className = 'toast__title';
    const detail = new FakeElement('span');
    detail.className = 'toast__detail';
    msg.append(title, detail);
    const close = new FakeElement('button');
    close.className = 'toast__close';
    this.append(msg, close);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  addEventListener() {}
}

function makeDocument() {
  const doc = {
    body: new FakeElement('body'),
    createElement: tagName => new FakeElement(tagName),
  };
  return doc;
}

async function withFakeDom(fn) {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const document = makeDocument();
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try {
    return await fn(document);
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete globalThis.document;
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete globalThis.window;
  }
}

test('toast：body 重建后重新挂载 toast 容器', async () => {
  await withFakeDom(async document => {
    const closeFirst = toast({ title: '旧页面', timeout: 0 });
    const oldBody = document.body;
    const oldWrap = oldBody.children[0];
    assert.equal(oldWrap.isConnected, true);

    document.body = makeDocument().body;
    const closeSecond = toast({ title: '新页面', timeout: 0 });
    const newWrap = document.body.children[0];

    assert.notEqual(newWrap, oldWrap);
    assert.equal(newWrap.isConnected, true);
    assert.equal(newWrap.children.length, 1);
    assert.equal(newWrap.children[0].children[0].children[0].textContent, '新页面');
    assert.equal(oldWrap.children.length, 1, '旧容器不应接收新提示');

    closeFirst();
    closeSecond();
  });
});
