/**
 * source-gaps.test.js —— source.js 残余分支补测（wave 139）
 *
 * 覆盖：
 *   - BlobSource 构造守卫（无 slice 的对象 → BAD_BLOB）；
 *   - FetchSource HEAD 非 2xx → GET Range:0-0 探测回退（200 / 206 / 双重失败抛 HTTP_BAD_STATUS）；
 *   - TypeError（CORS/网络）→ 顺序模式兜底；其他错误原样 rethrow；
 *   - read 越界（byteLength 已知且 offset ≥ size）→ OUT_OF_RANGE；
 *   - 顺序模式 openStream GET 失败 → HTTP_BAD_STATUS；
 *   - createByteSource 无法识别的输入 → BAD_SOURCE。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BlobSource, FetchSource, SourceError, createByteSource,
} from '../src/index.js';

const U8 = (arr) => Uint8Array.from(arr);

/** 构造极简 Response 形状（仅 source.js 用到的字段） */
function fakeRes({ ok = true, status = 200, headers = {}, body = null, bytes = null } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body,
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
  };
}

test('BlobSource 拒绝无 slice 的对象（BAD_BLOB）', () => {
  assert.throws(() => new BlobSource({ size: 10 }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.detail?.reason, 'BAD_BLOB');
    return true;
  });
});

test('FetchSource HEAD 失败回退 GET Range:0-0：200 视为不支持 Range', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    if (calls.length === 1) return fakeRes({ ok: false, status: 405 });
    return fakeRes({
      status: 200,
      headers: { 'content-length': '10', 'content-type': 'video/x-matroska' },
    });
  };
  const src = await FetchSource.open('http://x/test.mkv', { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Range, 'bytes=0-0');
  assert.equal(src.acceptRanges, false);
  assert.equal(src.byteLength, 10);
  assert.equal(src.size, 10);
  assert.equal(src.contentType, 'video/x-matroska');
});

test('FetchSource HEAD 失败回退 GET 返回 206：视为支持 Range', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    if (calls.length === 1) return fakeRes({ ok: false, status: 403 });
    return fakeRes({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/42' },
    });
  };
  const src = await FetchSource.open('http://x/test.mkv', { fetchImpl });
  assert.equal(src.acceptRanges, true);
  assert.equal(src.byteLength, 42);
});

test('FetchSource HEAD 与 GET 回退均失败 → HTTP_BAD_STATUS 且 rethrow', async () => {
  const fetchImpl = async (_url, init) => (
    init.method === 'HEAD'
      ? fakeRes({ ok: false, status: 500 })
      : fakeRes({ ok: false, status: 404 })
  );
  await assert.rejects(
    () => FetchSource.open('http://x/test.mkv', { fetchImpl }),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.detail?.reason, 'HTTP_BAD_STATUS');
      assert.match(err.message, /HTTP 404/);
      return true;
    },
  );
});

test('FetchSource 探测期 TypeError（CORS）→ 顺序模式兜底可读', async () => {
  const fetchImpl = async (url, init) => {
    if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
    // 顺序模式 GET：返回可读流
    const chunks = [U8([1, 2, 3]), U8([4, 5])];
    let i = 0;
    return fakeRes({
      status: 200,
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
    });
  };
  const src = await FetchSource.open('http://x/test.mkv', { fetchImpl });
  assert.equal(src.byteLength, null);
  const data = await src.read(0, 5);
  assert.deepEqual([...data], [1, 2, 3, 4, 5]);
});

test('FetchSource read 越界（byteLength 已知）→ OUT_OF_RANGE', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, headers: { 'content-length': '10' } });
  const src = await FetchSource.open('http://x/test.mkv', { fetchImpl });
  assert.equal(src.byteLength, 10);
  await assert.rejects(
    () => src.read(10, 1),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.detail?.reason, 'OUT_OF_RANGE');
      return true;
    },
  );
});

test('FetchSource 顺序模式 GET 失败 → HTTP_BAD_STATUS', async () => {
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
    return fakeRes({ ok: false, status: 503 });
  };
  const src = await FetchSource.open('http://x/test.mkv', { fetchImpl });
  await assert.rejects(
    () => src.read(0, 4),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.detail?.reason, 'HTTP_BAD_STATUS');
      assert.match(err.message, /HTTP 503/);
      return true;
    },
  );
});

test('createByteSource 无法识别的输入 → BAD_SOURCE', () => {
  assert.throws(() => createByteSource(42), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.detail?.reason, 'BAD_SOURCE');
    return true;
  });
});
