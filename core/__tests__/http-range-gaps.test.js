/**
 * HttpRangeDataSource 残余分支补测（第一百二十波）
 * ------------------------------------------------------------
 * 覆盖：无 fetch 环境构造抛错、open 退路探测的两类失败、body.cancel
 * 抛错吞并、read 越界、Range 请求非 206/200、服务器无视 Range 返 200
 * （start>0 抛错 / start=0 可用）、206 短响应。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HttpRangeDataSource } from '../src/http-range-source.js';

function makeWhole(len = 1024) {
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = i & 0xff;
  return u8;
}

const HDR = { get() { return null; } };
/** 无 content-range 等响应头、可携带自定义头与 body 的最小响应替身 */
const fakeRes = (status, { headers = {}, body = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body,
  arrayBuffer: async () => body ?? new ArrayBuffer(0),
});

test('构造：环境无 fetch → SOURCE_ERROR（非 TypeError）', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
  try {
    assert.throws(
      () => new HttpRangeDataSource('http://fixture.invalid/a.mp4'),
      (e) => e.code === 'SOURCE_ERROR' && /fetch is not available/.test(e.message),
    );
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  }
});

test('open 退路：GET 0-0 无 Content-Range → SOURCE_ERROR（不支持 Range）', async () => {
  const whole = makeWhole(256);
  const ds = new HttpRangeDataSource('http://fixture.invalid/nr.mp4', {
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(405);
      return fakeRes(200, { body: whole }); // 无 content-range 头
    },
  });
  await assert.rejects(
    () => ds.open(),
    (e) => e.code === 'SOURCE_ERROR' && /does not support HTTP Range/.test(e.message),
  );
});

test('open 退路：Content-Range 总长不可解析 → SOURCE_ERROR；body.cancel 抛错被吞并', async () => {
  const ds = new HttpRangeDataSource('http://fixture.invalid/bad.mp4', {
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(405);
      return fakeRes(206, {
        headers: { 'content-range': 'bytes 0-0/*' },
        body: { cancel() { throw new Error('cancel boom'); } },
      });
    },
  });
  await assert.rejects(
    () => ds.open(),
    (e) => e.code === 'SOURCE_ERROR' && /cannot determine file size/.test(e.message),
  );
});

test('open 退路：探测响应 body.cancel 抛错 → 吞并且 open 成功', async () => {
  const whole = makeWhole(256);
  const ds = new HttpRangeDataSource('http://fixture.invalid/ok.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(405);
      const range = init.headers?.Range ?? '';
      if (range === 'bytes=0-0') {
        return fakeRes(206, {
          headers: { 'content-range': `bytes 0-0/${whole.length}` },
          body: { cancel() { throw new Error('cancel boom'); } },
        });
      }
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const [s, e] = [Number(m[1]), Number(m[2])];
      return fakeRes(206, { body: whole.slice(s, e + 1) });
    },
  });
  await ds.open();
  assert.equal(ds.size, 256);
  const part = await ds.read(100, 10);
  assert.deepEqual([...part], [...whole.subarray(100, 110)]);
});

test('read：offset ≥ size 或 < 0 → SOURCE_ERROR', async () => {
  const whole = makeWhole(256);
  const ds = new HttpRangeDataSource('http://fixture.invalid/oob.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') {
        return fakeRes(200, { headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' } });
      }
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '');
      const [s, e] = [Number(m[1]), Number(m[2])];
      return fakeRes(206, { body: whole.slice(s, e + 1) });
    },
  });
  await ds.open();
  await assert.rejects(() => ds.read(300, 10), /read out of range: offset=300/);
  await assert.rejects(() => ds.read(-1, 10), /read out of range: offset=-1/);
});

test('_rangeGet：非 206/200 状态 → SOURCE_ERROR（range request failed）', async () => {
  const ds = new HttpRangeDataSource('http://fixture.invalid/404.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '256', 'accept-ranges': 'bytes' } });
      return fakeRes(404);
    },
  });
  await ds.open();
  await assert.rejects(() => ds.read(0, 10), /range request failed \(404\)/);
});

test('_rangeGet：服务器无视 Range 返 200（start>0）→ SOURCE_ERROR 且 body 被取消', async () => {
  const whole = makeWhole(512);
  let cancelled = false;
  const ds = new HttpRangeDataSource('http://fixture.invalid/ignore.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' } });
      return fakeRes(200, { body: { cancel: () => { cancelled = true; } } });
    },
  });
  await ds.open();
  await assert.rejects(() => ds.read(128, 10), /server ignored Range header \(got 200\)/);
  assert.equal(cancelled, true, '应取消整文件响应体避免浪费带宽');
});

test('_rangeGet：取消整文件响应体自身抛错也不覆盖原 SOURCE_ERROR', async () => {
  const whole = makeWhole(512);
  const ds = new HttpRangeDataSource('http://fixture.invalid/ignore-cancel-fails.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' } });
      return fakeRes(200, { body: { cancel: () => { throw new Error('cancel failed'); } } });
    },
  });
  await ds.open();
  await assert.rejects(() => ds.read(128, 10), (e) =>
    e.code === 'SOURCE_ERROR' && /server ignored Range header \(got 200\)/.test(e.message),
  );
});

test('_rangeGet：206 短响应且未到文件尾 → SOURCE_ERROR（short range response）', async () => {
  const whole = makeWhole(1024);
  const ds = new HttpRangeDataSource('http://fixture.invalid/short.mp4', {
    chunkSize: 256,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' } });
      return fakeRes(206, { body: whole.slice(0, 100) }); // 期望 256 只给 100
    },
  });
  await ds.open();
  await assert.rejects(() => ds.read(0, 100), /short range response: got 100, want 256/);
});

test('_rangeGet：200 整文件且 start=0 → 直接截取可用区间', async () => {
  const whole = makeWhole(512);
  const ds = new HttpRangeDataSource('http://fixture.invalid/full.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' } });
      return fakeRes(200, { body: whole.slice(0) }); // 200 全量
    },
  });
  await ds.open();
  const part = await ds.read(0, 20);
  assert.deepEqual([...part], [...whole.subarray(0, 20)]);
  assert.equal(ds.acceptRanges, true);
});
