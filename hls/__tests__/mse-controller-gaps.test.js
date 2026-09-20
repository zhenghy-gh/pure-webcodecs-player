/**
 * mse-controller-gaps.test.js —— HLS MSE 控制器残余分支补测（wave 164）
 *
 * 覆盖：Quota 回调异常吞掉、remove error 事件拒绝、destroy 期 removeSourceBuffer 异常吞掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MseController } from '../src/mse-controller.js';

class FakeSourceBuffer {
  constructor() { this.listeners = new Map(); this.buffered = { length: 30, start: () => 0, end: () => 1 }; this.updating = false; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  fire(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type }); }
  appendBuffer() {}
  remove() {}
  abort() {}
}

class FakeMediaSource {
  static isTypeSupported() { return true; }
  constructor() { this.readyState = 'open'; this.listeners = new Map(); this.sb = new FakeSourceBuffer(); queueMicrotask(() => this.fire('sourceopen')); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  fire(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type }); }
  addSourceBuffer() { return this.sb; }
  removeSourceBuffer() { throw new Error('SB 已移除'); }
  endOfStream() {}
}

async function withMse(fn) {
  const oldMs = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  const oldUrl = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  Object.defineProperty(globalThis, 'MediaSource', { value: FakeMediaSource, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'URL', { value: { createObjectURL: () => 'blob:gaps', revokeObjectURL() {} }, configurable: true, writable: true });
  try { return await fn(); } finally {
    if (oldMs) Object.defineProperty(globalThis, 'MediaSource', oldMs); else delete globalThis.MediaSource;
    if (oldUrl) Object.defineProperty(globalThis, 'URL', oldUrl); else delete globalThis.URL;
  }
}

test('append：配额回调抛错不影响 DECODE_ERROR 拒绝（110-111）', async () => {
  await withMse(async () => {
    const c = new MseController();
    await c.attach({ src: '', removeAttribute() {} });
    const sb = c.addSourceBuffer('video', 'video/mp4');
    c._onQuotaEvict = () => { throw new Error('上层裁剪故障'); };
    const p = c.append('video', new Uint8Array([1]));
    queueMicrotask(() => sb.fire('error'));
    await assert.rejects(p, (e) => e.code === 'DECODE_ERROR');
  });
});

test('remove：error 事件清理监听并以 DECODE_ERROR 拒绝（151-152）', async () => {
  await withMse(async () => {
    const c = new MseController();
    await c.attach({ src: '', removeAttribute() {} });
    const sb = c.addSourceBuffer('video', 'video/mp4');
    const p = c.remove('video', 0, 1);
    queueMicrotask(() => sb.fire('error'));
    await assert.rejects(p, (e) => e.code === 'DECODE_ERROR' && e.detail?.type === 'video');
  });
});

test('destroy：removeSourceBuffer 抛错被销毁期 catch 吞掉（278-279）', async () => {
  await withMse(async () => {
    const c = new MseController();
    await c.attach({ src: '', removeAttribute() {} });
    c.addSourceBuffer('video', 'video/mp4');
    c.mediaSource.endOfStream = () => { throw new Error('结束竞态'); };
    assert.doesNotThrow(() => c.destroy());
    assert.equal(c.mediaSource, null);
    assert.equal(c.video, null);
  });
});
