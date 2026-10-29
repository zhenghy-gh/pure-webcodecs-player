/**
 * SegmentLoader 残余分支补测（134 波）：
 * 无 fetch 环境（构造期 _fetch=null，首次请求 NOT_SUPPORTED）、
 * readStream reader.cancel 抛错被吞噬（原错误优先）、
 * delay 的 signal 三形态（监听中止 / 预先已中止）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SegmentLoader, LoadError } from '../src/segment-loader.js';

test('无 fetch 环境：构造不炸，首次请求报 NOT_SUPPORTED', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
  try {
    const loader = new SegmentLoader();
    await assert.rejects(
      loader.load('https://cdn.example.test/seg1.ts'),
      (e) => e instanceof LoadError && e.code === 'NOT_SUPPORTED' && /无 fetch/.test(e.message),
    );
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
  }
});

test('readStream：maxBytes 熔断时 reader.cancel 抛错 → 吞噬，仍抛 SOURCE_ERROR', async () => {
  let cancelCalled = 0;
  const body = {
    getReader() {
      return {
        read: async () => ({ done: false, value: new Uint8Array(32).fill(1) }),
        cancel: async () => {
          cancelCalled++;
          throw new Error('cancel down');
        },
      };
    },
  };
  const loader = new SegmentLoader({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body,
    }),
    maxBytes: 10,
    maxRetry: 0,
  });
  await assert.rejects(
    loader.load('https://cdn.example.test/big.ts'),
    (e) => e instanceof LoadError && e.code === 'SOURCE_ERROR' && /超过字节上界\(10\)/.test(e.message),
  );
  assert.equal(cancelCalled, 1);
});

test('重试退避正常完成后移除 abort 监听器', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener);
    },
  };
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      throw new TypeError('net down');
    },
    maxRetry: 1,
    retryDelayMs: 1,
  });
  await assert.rejects(loader.load('https://cdn.example.test/seg.ts', { signal }), /网络错误/);
  assert.equal(listeners.size, 0);
});
test('重试退避期间外部中止 → 统一返回 ABORTED LoadError', async () => {
  const ctrl = new AbortController();
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      throw new TypeError('net down');
    },
    maxRetry: 1,
    retryDelayMs: 80,
  });
  setTimeout(() => ctrl.abort(), 15);
  await assert.rejects(
    loader.load('https://cdn.example.test/seg.ts', { signal: ctrl.signal }),
    (e) => e instanceof LoadError && e.code === 'ABORTED' && e.fatal,
  );
});

test('BYTERANGE 非整数或终点溢出时在 fetch 前拒绝', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, status: 206, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(2) };
    },
    maxRetry: 2,
    retryDelayMs: 1,
  });

  for (const byteRange of [
    { offset: 0.5, length: 2 },
    { offset: Number.MAX_SAFE_INTEGER, length: 2 },
    { offset: 0, length: NaN },
  ]) {
    await assert.rejects(
      loader.load('https://cdn.example.test/seg.ts', { byteRange }),
      (error) => error instanceof LoadError && error.code === 'SOURCE_ERROR' && error.fatal,
    );
  }
  assert.equal(attempts, 0);
});

test('delay：进入退避前 signal 已中止 → 统一返回 ABORTED LoadError', async () => {
  const ctrl = new AbortController();
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      ctrl.abort(); // 在抛错前同步中止
      throw new TypeError('net down');
    },
    maxRetry: 1,
    retryDelayMs: 80,
  });
  await assert.rejects(
    loader.load('https://cdn.example.test/seg.ts', { signal: ctrl.signal }),
    (e) => e instanceof LoadError && e.code === 'ABORTED' && e.fatal,
  );
});
