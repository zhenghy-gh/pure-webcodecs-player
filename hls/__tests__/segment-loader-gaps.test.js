/**
 * SegmentLoader 残余分支补测（134 波）：
 * 无 fetch 环境（构造期 _fetch=null，首次请求 NOT_SUPPORTED）、
 * readStream reader.cancel 抛错被吞噬（原错误优先）、
 * delay 的 signal 三形态（监听中止 / 预先已中止）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SegmentLoader, LoadError } from '../src/segment-loader.js';

test('SegmentLoader：服务器忽略 BYTERANGE 并返回完整 200 时 fail closed', async () => {
  const bytes = new TextEncoder().encode('abcdefghij');
  let rangeHeader;
  const loader = new SegmentLoader({
    maxRetry: 0,
    fetchImpl: async (_url, init) => {
      rangeHeader = init.headers.Range;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'content-length' ? String(bytes.length) : null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  });

  await assert.rejects(
    () => loader.load('https://cdn.example.test/shared.ts', { byteRange: { offset: 3, length: 4 } }),
    (error) => error instanceof LoadError && error.code === 'SOURCE_ERROR' && error.fatal,
  );
  assert.equal(rangeHeader, 'bytes=3-6');
});

test('SegmentLoader：拒绝长度不匹配或 Content-Range 错位的 206 响应', async () => {
  const validBytes = new TextEncoder().encode('defg');
  const valid = new SegmentLoader({
    maxRetry: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 206,
      headers: { get: (name) => name.toLowerCase() === 'content-range' ? 'bytes 3-6/10' : '4' },
      arrayBuffer: async () => validBytes.buffer.slice(validBytes.byteOffset, validBytes.byteOffset + validBytes.byteLength),
    }),
  });
  const result = await valid.load('https://cdn.example.test/shared.ts', { byteRange: { offset: 3, length: 4 } });
  assert.equal(new TextDecoder().decode(result.data), 'defg');

  const wildcardLoader = new SegmentLoader({
    maxRetry: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 206,
      headers: { get: (name) => name.toLowerCase() === 'content-range' ? 'bytes 3-6/*' : null },
      arrayBuffer: async () => validBytes.buffer.slice(validBytes.byteOffset, validBytes.byteOffset + validBytes.byteLength),
    }),
  });
  const wildcardResult = await wildcardLoader.load('https://cdn.example.test/shared.ts', { byteRange: { offset: 3, length: 4 } });
  assert.equal(wildcardResult.byteLength, 4, 'unknown complete length is permitted with exact partial interval');

  const cases = [
    { body: 'defg', contentRange: null },
    { body: 'defg', contentRange: 'items 3-6/10' },
    { body: 'defg', contentRange: 'bytes 2-5/10' },
    { body: 'defg', contentRange: 'bytes 3-6/6' },
    { body: 'abc', contentRange: 'bytes 3-6/10' },
    { body: 'defgh', contentRange: 'bytes 3-6/10' },
    { body: 'defg', contentRange: 'bytes 3-6/10', contentLength: '3' },
    { body: 'defg', contentRange: 'bytes 3-6/10', contentLength: 'invalid' },
  ];
  for (const response of cases) {
    const body = new TextEncoder().encode(response.body);
    const loader = new SegmentLoader({
      maxRetry: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 206,
        headers: { get: (name) => name.toLowerCase() === 'content-range' ? response.contentRange :
          (name.toLowerCase() === 'content-length' ? response.contentLength ?? null : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      }),
    });
    await assert.rejects(
      () => loader.load('https://cdn.example.test/shared.ts', { byteRange: { offset: 3, length: 4 } }),
      (error) => error instanceof LoadError && error.code === 'SOURCE_ERROR',
    );
  }
});

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

test('重试退避期间外部中止 → delay 的 abort 监听触发，透传 AbortError', async () => {
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
    (e) => e.name === 'AbortError',
  );
});

test('delay：进入退避前 signal 已中止 → 立即 reject AbortError', async () => {
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
    (e) => e.name === 'AbortError',
  );
});
