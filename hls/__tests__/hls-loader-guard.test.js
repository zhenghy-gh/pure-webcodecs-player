/**
 * SegmentLoader 防御分支单测（第二十五波）
 * 覆盖：410 Gone、5xx 耗尽、file: 协议拒绝、maxBytes 熔断、外部预取消、
 * fetch 直接 reject 的网络异常归一化。Range 头 / 超时 / credentials 已有专测，不重复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentLoader, LoadError } from '../src/segment-loader.js';

/** 文本响应桩（走 ReadableStream 路径） */
function textRes(text, status = 200) {
  const encoded = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(encoded.byteLength) },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => (done ? { done: true } : ((done = true), { done: false, value: encoded })),
        };
      },
    },
  };
}

test('410 Gone：4xx 家族 → SOURCE_ERROR fatal 不重试', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 410, headers: { get: () => null }, text: async () => '' };
    },
  });
  await assert.rejects(
    () => loader.load('https://cdn/gone.ts'),
    (e) => e instanceof LoadError && e.code === 'SOURCE_ERROR' && e.status === 410 && e.fatal === true
  );
  assert.equal(attempts, 1, '410 不可恢复，不得重试');
});

test('5xx 持续失败：按上限重试后抛 NETWORK_ERROR（非 fatal）', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    maxRetry: 2,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
    },
  });
  await assert.rejects(
    () => loader.load('https://cdn/broken.ts'),
    (e) => e instanceof LoadError && e.code === 'NETWORK_ERROR' && e.status === 500 && e.fatal === false
  );
  assert.equal(attempts, 3, 'maxRetry=2 → 1 次首发 + 2 次重试');
});

test('file: 协议清单 URI：构造期白名单拒绝（NETWORK_ERROR fatal，fetch 零调用）', async () => {
  let calls = 0;
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      calls += 1;
      return textRes('');
    },
  });
  await assert.rejects(
    () => loader.load('file:///etc/passwd'),
    (e) => e instanceof LoadError && e.code === 'NETWORK_ERROR' && e.fatal === true && /协议不允许/.test(e.message)
  );
  assert.equal(calls, 0, '不安全协议不得触达 fetch');
});

test('maxBytes 熔断：流式超限 → SOURCE_ERROR fatal 且 reader.cancel 被调用', async () => {
  let cancelled = 0;
  let attempts = 0;
  const chunk = new Uint8Array(8).fill(1);
  const loader = new SegmentLoader({
    maxBytes: 10,
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => '999' },
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: chunk }),
            cancel: async () => {
              cancelled += 1;
            },
          }),
        },
      };
    },
  });
  await assert.rejects(
    () => loader.load('https://cdn/huge.ts'),
    (e) => e instanceof LoadError && e.code === 'SOURCE_ERROR' && e.fatal === true && /字节上界/.test(e.message)
  );
  assert.equal(attempts, 1, '熔断属 fatal，不重试');
  assert.equal(cancelled, attempts, '每次熔断都应取消在途流');
});

test('外部 signal 已预取消：立即 ABORTED 透传，fetch 零调用', async () => {
  let calls = 0;
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      calls += 1;
      return textRes('');
    },
  });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => loader.load('https://cdn/x.ts', { signal: ctrl.signal }),
    (e) => e instanceof LoadError && e.code === 'ABORTED' && e.fatal === true
  );
  assert.equal(calls, 0);
});

test('fetch 直接 reject（连接失败）：重试耗尽后归一化为 NETWORK_ERROR', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    maxRetry: 1,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed: ECONNREFUSED');
    },
  });
  await assert.rejects(
    () => loader.load('https://cdn/x.ts'),
    (e) => e instanceof LoadError && e.code === 'NETWORK_ERROR' && e.network === true && /ECONNREFUSED/.test(e.message)
  );
  assert.equal(attempts, 2, '非致命网络异常应重试');
});

test('在途外部取消：abort 事件转 ABORTED 且不重试', async () => {
  let attempts = 0;
  const ctrl = new AbortController();
  const loader = new SegmentLoader({
    maxRetry: 3,
    retryDelayMs: 1,
    fetchImpl: (url, init = {}) =>
      new Promise((_resolve, reject) => {
        attempts += 1;
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  const pending = loader.load('https://cdn/x.ts', { signal: ctrl.signal });
  queueMicrotask(() => ctrl.abort());
  await assert.rejects(
    () => pending,
    (e) => e instanceof LoadError && e.code === 'ABORTED'
  );
  assert.equal(attempts, 1, '用户取消不得进入重试循环');
});
