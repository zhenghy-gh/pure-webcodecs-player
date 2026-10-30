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

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('构造：非法分块或缓存配置同步 SOURCE_ERROR，且不发请求', () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return fakeRes(200); };
  const nonNumbers = ['4', true, false, {}, [], 1n, Symbol('option')];
  const cases = [
    ['chunkSize', [0, -0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, ...nonNumbers]],
    ['maxCachedBlocks', [-1, 0.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1, ...nonNumbers]],
  ];
  for (const [name, values] of cases) {
    for (const value of values) {
      assert.throws(() => new HttpRangeDataSource('https://fixture.invalid/options.mp4', {
        fetchImpl, [name]: value,
      }), (error) => error.code === 'SOURCE_ERROR' && error.message.includes(name));
    }
  }
  for (const value of [undefined, null]) {
    const ds = new HttpRangeDataSource('https://fixture.invalid/default-options.mp4', {
      fetchImpl, chunkSize: value, maxCachedBlocks: value,
    });
    assert.equal(ds.chunkSize, 1 << 18);
    assert.equal(ds.maxCachedBlocks, 64);
  }
  assert.doesNotThrow(() => new HttpRangeDataSource('https://fixture.invalid/boundary-options.mp4', {
    fetchImpl, chunkSize: Number.MAX_SAFE_INTEGER, maxCachedBlocks: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(requests, 0);
});

test('构造：chunkSize=1 且零缓存时跨块、尾读及重读完整', async () => {
  const whole = makeWhole(5);
  for (const capacity of [0, -0]) {
    const ranges = [];
    let heads = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/no-cache.mp4', {
      chunkSize: 1, maxCachedBlocks: capacity,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') {
          heads++;
          return fakeRes(200, { headers: { 'content-length': '5' } });
        }
        ranges.push(init.headers.Range);
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
        return fakeRes(206, { body: whole.slice(Number(start), Number(end) + 1) });
      },
    });
    assert.deepEqual([...await ds.read(1, 3)], [1, 2, 3]);
    assert.equal(ds._cache.size, 0);
    assert.deepEqual([...await ds.read(4, 9)], [4]);
    assert.equal(ds._cache.size, 0);
    assert.deepEqual([...await ds.read(1, 3)], [1, 2, 3]);
    assert.equal(ds._cache.size, 0);
    assert.deepEqual(ranges, ['bytes=1-3', 'bytes=4-4', 'bytes=1-3']);
    assert.equal(heads, 1);
    await ds.close();
  }
});

test('构造：Infinity 缓存容量保留命中且不淘汰', async () => {
  const whole = makeWhole(6);
  const ranges = [];
  const ds = new HttpRangeDataSource('https://fixture.invalid/unbounded-cache.mp4', {
    chunkSize: 2, maxCachedBlocks: Infinity,
    fetchImpl: async (_url, init) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '6' } });
      ranges.push(init.headers.Range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      return fakeRes(206, { body: whole.slice(Number(start), Number(end) + 1) });
    },
  });
  assert.deepEqual([...await ds.read(0, 2)], [0, 1]);
  assert.deepEqual([...await ds.read(4, 2)], [4, 5]);
  assert.deepEqual([...await ds.read(0, 2)], [0, 1]);
  assert.deepEqual(ranges, ['bytes=0-1', 'bytes=4-5']);
  assert.equal(ds._cache.size, 2);
  await ds.close();
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

test('HEAD 非法 Content-Length 回退探测，随后可读正确数据', async () => {
  for (const value of ['-1', '-0', '1.5', '1e3', '+1', '0x10', '', '  ', '9007199254740992', '9007199254740993', '1e999', null]) {
    let probes = 0;
    let dataRequests = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/head-invalid.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return new Response(null, {
          headers: value == null ? {} : { 'Content-Length': value, 'Accept-Ranges': 'bytes' },
        });
        if (init.headers.Range === 'bytes=0-0') {
          probes++;
          return new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/4' } });
        }
        dataRequests++;
        assert.equal(init.headers.Range, 'bytes=0-3');
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206, headers: { 'Content-Range': 'bytes 0-3/4' },
        });
      },
    });
    await ds.open();
    assert.equal(ds.size, 4, String(value));
    assert.equal(ds.acceptRanges, true);
    assert.equal(probes, 1);
    assert.deepEqual([...await ds.read(0, 4)], [1, 2, 3, 4]);
    assert.equal(dataRequests, 1);
    await ds.close();
  }
});

test('HEAD 合法非负安全长度包含零，不额外发 GET', async () => {
  for (const value of ['0', '000', '1', '00012', ' 42 ', String(Number.MAX_SAFE_INTEGER)]) {
    let requests = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/head-valid.mp4', {
      fetchImpl: async (_url, init) => {
        requests++;
        assert.equal(init.method, 'HEAD');
        return new Response(null, { headers: { 'Content-Length': value, 'Accept-Ranges': 'bytes' } });
      },
    });
    await ds.open();
    await ds.open();
    assert.equal(ds.size, Number(value));
    assert.equal(ds.acceptRanges, true);
    assert.equal(requests, 1);
    if (ds.size === 0) await assert.rejects(() => ds.read(0, 1), (error) => error.code === 'SOURCE_ERROR');
    assert.equal(requests, 1);
    await ds.close();
  }
});

test('HEAD 非法长度且探测失败不污染元数据，重试可成功', async () => {
  let heads = 0;
  let probes = 0;
  let cancelled = 0;
  const ds = new HttpRangeDataSource('https://fixture.invalid/head-retry.mp4', {
    fetchImpl: async (_url, init) => {
      if (init.method === 'HEAD') {
        heads++;
        return new Response(null, {
          headers: { 'Content-Length': '9007199254740993', 'Accept-Ranges': 'bytes' },
        });
      }
      assert.equal(init.headers.Range, 'bytes=0-0');
      probes++;
      return fakeRes(probes === 1 ? 416 : 206, {
        headers: { 'content-range': probes === 1 ? 'bytes */0' : 'bytes 0-0/4' },
        body: { cancel() { cancelled++; } },
      });
    },
  });
  await assert.rejects(() => ds.open(), (error) => error.code === 'SOURCE_ERROR' && error.detail.status === 416);
  assert.equal(ds.size, Infinity);
  assert.equal(ds.acceptRanges, false);
  assert.equal(ds._opened, false);
  assert.equal(heads, 1);
  assert.equal(probes, 1);
  assert.equal(cancelled, 1);
  await ds.open();
  assert.equal(ds.size, 4);
  assert.equal(ds.acceptRanges, true);
  assert.equal(ds._opened, true);
  assert.equal(heads, 2);
  assert.equal(probes, 2);
  assert.equal(cancelled, 2);
  await ds.close();
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

test('open 探测拒绝非 206 状态，失败不写元数据且可重试', async () => {
  for (const [status, contentRange] of [[416, 'bytes */0'], [416, 'bytes */512'], [404, 'bytes 0-0/512'], [500, 'bytes 0-0/512'], [200, 'bytes 0-0/512']]) {
    let probes = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/probe-status.mp4', {
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return new Response(null, { status: 405 });
        assert.equal(init.headers.Range, 'bytes=0-0');
        probes++;
        return new Response(null, { status: probes === 1 ? status : 206,
          headers: { 'Content-Range': probes === 1 ? contentRange : 'bytes 0-0/512' } });
      },
    });
    await assert.rejects(() => ds.open(), (error) => error.code === 'SOURCE_ERROR' && error.detail?.status === status);
    assert.equal(ds.size, Infinity);
    assert.equal(ds.acceptRanges, false);
    assert.equal(ds._opened, false);
    await ds.open();
    assert.equal(ds.size, 512);
    assert.equal(probes, 2);
    await ds.close();
  }
});

test('open 探测拒绝非法区间或总长，并尽力清理失败响应体', async () => {
  const invalid = ['bytes 1-1/512', 'bytes 0-1/512', 'bytes */512', 'items 0-0/512', 'nonsense/512',
    'bytes 0-0/0', 'bytes 0-0/-1', 'bytes 0-0/1.5', 'bytes 0-0/', 'bytes 0-0/*', 'bytes 0-0/9007199254740993', null];
  for (const contentRange of invalid) {
    let cancelled = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/probe-range.mp4', {
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return fakeRes(405);
        return fakeRes(206, { headers: { 'content-range': contentRange },
          body: { cancel() { cancelled++; return Promise.reject(new Error('cancel failed')); } } });
      },
    });
    await assert.rejects(() => ds.open(), (error) => error.code === 'SOURCE_ERROR' && error.detail?.status === 206);
    assert.equal(ds.size, Infinity);
    assert.equal(ds.acceptRanges, false);
    assert.equal(ds._opened, false);
    assert.equal(cancelled, 1);
  }
});

test('open 探测接受合法首字节与正安全总长，不等待响应体清理', async () => {
  for (const total of [1, 512, Number.MAX_SAFE_INTEGER]) {
    let cancelled = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/probe-valid.mp4', {
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return fakeRes(405);
        return fakeRes(206, { headers: { 'content-range': '  BYTES 0-0/' + total + '  ' },
          body: { cancel() { cancelled++; return new Promise(() => {}); } } });
      },
    });
    await ds.open();
    assert.equal(ds.size, total);
    assert.equal(ds.acceptRanges, true);
    assert.equal(ds._opened, true);
    assert.equal(cancelled, 1);
    await ds.close();
  }
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

test('read 零长度：冷源只探长，不下载业务块，随后仍可正常读取', async () => {
  let heads = 0;
  let allowData = false;
  const ranges = [];
  const ds = new HttpRangeDataSource('https://fixture.invalid/empty-read.mp4', {
    chunkSize: 4, maxReadLength: 2,
    fetchImpl: async (_url, init) => {
      if (init.method === 'HEAD') { heads++; return fakeRes(200, { headers: { 'content-length': '10' } }); }
      ranges.push(init.headers.Range);
      assert.equal(allowData, true, '零长度不应下载业务块');
      return fakeRes(206, { body: makeWhole(4) });
    },
  });
  for (const offset of [0, 1, 4, 9]) {
    assert.deepEqual(await ds.read(offset, 0), new Uint8Array(0));
    assert.equal(ds._cache.size, 0);
  }
  assert.equal(heads, 1);
  assert.deepEqual(ranges, []);
  await assert.rejects(() => ds.read(10, 0), (e) => e.code === 'SOURCE_ERROR');
  for (const length of [-1, 3]) await assert.rejects(() => ds.read(1, length), (e) => e.code === 'PARSE_ERROR');
  allowData = true;
  assert.deepEqual([...await ds.read(1, 2)], [1, 2]);
  assert.deepEqual(ranges, ['bytes=0-3']);
  await ds.close();
});

test('read 零长度：热源不改变多块 LRU、引用或触发缺块下载', async () => {
  const ranges = [];
  const whole = makeWhole(12);
  const ds = new HttpRangeDataSource('https://fixture.invalid/empty-read-cache.mp4', {
    chunkSize: 4, maxCachedBlocks: 2,
    fetchImpl: async (_url, init) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '12' } });
      ranges.push(init.headers.Range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      assert.ok(Number(start) < 8, '零长度缺块不应依赖网络');
      return fakeRes(206, { body: whole.slice(Number(start), Number(end) + 1) });
    },
  });
  await ds.read(0, 4);
  await ds.read(4, 4);
  const cached = [...ds._cache];
  const contents = cached.map(([, bytes]) => [...bytes]);
  for (const offset of [1, 4, 7, 9]) {
    assert.equal((await ds.read(offset, 0)).byteLength, 0);
    assert.deepEqual([...ds._cache.keys()], [0, 1]);
    for (const [key, bytes] of cached) assert.equal(ds._cache.get(key), bytes);
    assert.deepEqual([...ds._cache.values()].map((bytes) => [...bytes]), contents);
  }
  assert.deepEqual(ranges, ['bytes=0-3', 'bytes=4-7']);
  assert.deepEqual([...await ds.read(1, 2)], [1, 2]);
  await ds.close();
});

test('read 零长度：保留 HEAD 回退探测 GET、EOF 及空源拒绝', async () => {
  const calls = [];
  let cancelled = 0;
  const ds = new HttpRangeDataSource('https://fixture.invalid/empty-read-probe.mp4', {
    chunkSize: 4,
    fetchImpl: async (_url, init) => {
      calls.push(init.method === 'HEAD' ? 'HEAD' : init.headers.Range);
      if (init.method === 'HEAD') return fakeRes(405);
      assert.equal(init.headers.Range, 'bytes=0-0');
      return fakeRes(206, { headers: { 'content-range': 'bytes 0-0/10' }, body: { cancel() { cancelled++; } } });
    },
  });
  assert.equal((await ds.read(1, 0)).byteLength, 0);
  assert.deepEqual(calls, ['HEAD', 'bytes=0-0']);
  assert.equal(cancelled, 1);
  assert.equal(ds.size, 10);
  assert.equal(ds._cache.size, 0);
  await assert.rejects(() => ds.read(10, 0), (e) => e.code === 'SOURCE_ERROR');
  assert.deepEqual(calls, ['HEAD', 'bytes=0-0']);
  await ds.close();
  let emptyHeads = 0;
  const empty = new HttpRangeDataSource('https://fixture.invalid/empty-source.mp4', {
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'HEAD');
      emptyHeads++;
      return fakeRes(200, { headers: { 'content-length': '0' } });
    },
  });
  await assert.rejects(() => empty.read(0, 0), (e) => e.code === 'SOURCE_ERROR');
  assert.equal(emptyHeads, 1);
  await empty.close();
});

test('read 非法 offset 在打开前拒绝，不发 HEAD 或 Range 请求', async () => {
  const invalid = [0.5, NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, true, {}, 1n, Symbol('offset')];
  for (const offset of invalid) {
    let requests = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/invalid-offset.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        requests++;
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '16' } });
        return fakeRes(206, { body: makeWhole(16) });
      },
    });
    await assert.rejects(() => ds.read(offset, 2), (error) => error.code === 'SOURCE_ERROR' && /offset/.test(error.message));
    assert.equal(requests, 0);
    assert.equal(ds._opened, false);
    assert.equal(ds.size, Infinity);
    assert.equal(ds._cache.size, 0);
  }
});

test('read 已缓存时仍拒绝非法 offset，合法跨块和尾部读取不变', async () => {
  const whole = makeWhole(16);
  const ranges = [];
  let heads = 0;
  const ds = new HttpRangeDataSource('https://fixture.invalid/cached-offset.mp4', {
    chunkSize: 4,
    fetchImpl: async (_url, init) => {
      if (init.method === 'HEAD') {
        heads++;
        return fakeRes(200, { headers: { 'content-length': '16' } });
      }
      ranges.push(init.headers.Range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      return fakeRes(206, { body: whole.slice(Number(start), Number(end) + 1) });
    },
  });
  assert.deepEqual([...await ds.read(0, 4)], [0, 1, 2, 3]);
  const cached = [...ds._cache].map(([key, bytes]) => [key, [...bytes]]);
  for (const offset of [0.5, NaN, '1']) {
    await assert.rejects(() => ds.read(offset, 2), (error) => error.code === 'SOURCE_ERROR');
    assert.deepEqual([...ds._cache].map(([key, bytes]) => [key, [...bytes]]), cached);
    assert.deepEqual(ranges, ['bytes=0-3']);
    assert.equal(heads, 1);
  }
  assert.deepEqual([...await ds.read(-0, 1)], [0]);
  assert.deepEqual([...await ds.read(3, 4)], [3, 4, 5, 6]);
  assert.deepEqual([...await ds.read(14, 8)], [14, 15]);
  await assert.rejects(() => ds.read(16, 1), (error) => error.code === 'SOURCE_ERROR');
  assert.deepEqual(ranges, ['bytes=0-3', 'bytes=4-7', 'bytes=12-15']);
  assert.equal(heads, 1);
  await ds.close();
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

test('_rangeGet：取消异步拒绝或不结束仍保留原 Range 错误', async () => {
  for (const mode of ['reject', 'pending']) {
    let cancelled = 0;
    let bodyReads = 0;
    const controller = new AbortController();
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled++;
        return mode === 'reject' ? Promise.reject(new Error('cancel rejected')) : new Promise(() => {});
      },
    }), { status: 200 });
    response.arrayBuffer = async () => { bodyReads++; throw new Error('must not read rejected body'); };
    const ds = new HttpRangeDataSource('https://fixture.invalid/cancel-async.mp4', {
      chunkSize: 4, requestInit: { signal: controller.signal },
      fetchImpl: async (_url, init) => {
        assert.equal(init.signal, controller.signal);
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '16' } });
        assert.equal(init.headers.Range, 'bytes=4-7');
        return response;
      },
    });
    await assert.rejects(() => ds.read(4, 1), (error) => error.code === 'SOURCE_ERROR'
      && /server ignored Range header/.test(error.message));
    assert.equal(cancelled, 1);
    assert.equal(bodyReads, 0);
    assert.equal(ds._cache.size, 0);
    assert.equal(controller.signal.aborted, false);
    await new Promise((resolve) => setImmediate(resolve));
    await ds.close();
  }
});

test('_rangeGet：错误状态丢弃响应体且清理失败不覆盖状态错误', async () => {
  for (const status of [404, 500]) {
    for (const mode of ['throw', 'reject', 'pending', 'no-body']) {
      let cancelled = 0;
      let bodyReads = 0;
      const controller = new AbortController();
      const response = {
        status,
        body: mode === 'no-body' ? null : { cancel() {
          cancelled++;
          if (mode === 'throw') throw new Error('cancel threw');
          return mode === 'reject' ? Promise.reject(new Error('cancel rejected')) : new Promise(() => {});
        } },
        async arrayBuffer() { bodyReads++; throw new Error('must not read rejected body'); },
      };
      const ds = new HttpRangeDataSource('https://fixture.invalid/cancel-status.mp4', {
        chunkSize: 4, requestInit: { signal: controller.signal },
        fetchImpl: async (_url, init) => {
          assert.equal(init.signal, controller.signal);
          if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '16' } });
          assert.equal(init.headers.Range, 'bytes=4-7');
          return response;
        },
      });
      await assert.rejects(() => ds.read(4, 1), (error) => error.code === 'SOURCE_ERROR'
        && error.message.includes('range request failed (' + status + ')'));
      assert.equal(cancelled, mode === 'no-body' ? 0 : 1);
      assert.equal(bodyReads, 0);
      assert.equal(ds._cache.size, 0);
      assert.equal(controller.signal.aborted, false);
      await new Promise((resolve) => setImmediate(resolve));
      await ds.close();
    }
  }
});

test('_rangeGet：200 短响应在切块前拒绝，重试不命中不足块', async () => {
  const whole = makeWhole(8);
  for (const got of [2, 0, 1, 3]) {
    let heads = 0;
    let requests = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/short-200.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') { heads++; return fakeRes(200, { headers: { 'content-length': '8' } }); }
        assert.equal(init.headers.Range, 'bytes=0-3');
        requests++;
        return fakeRes(200, { body: whole.slice(0, requests === 1 ? got : whole.length) });
      },
    });
    // 旧实现只读首字节即可安全暴露接受短块，避免执行跨出不足块的危险组装。
    await assert.rejects(() => ds.read(0, 1), (e) => e.code === 'SOURCE_ERROR'
      && e.message === 'short range response: got ' + got + ', want 4');
    assert.equal(ds._cache.size, 0);
    assert.equal(requests, 1);
    assert.equal(ds.size, 8);
    assert.deepEqual([...await ds.read(0, 1)], [0]);
    assert.deepEqual([...await ds.read(3, 1)], [3]);
    assert.equal(ds._cache.get(0).byteLength, 4);
    assert.equal(requests, 2);
    assert.equal(heads, 1);
    await ds.close();
  }
});

test('_rangeGet：200 覆盖本次区间即可，保留超出区间截取和尾块', async () => {
  for (const [size, bodyLength, length, range] of [
    [8, 4, 4, 'bytes=0-3'], [8, 6, 4, 'bytes=0-3'], [8, 8, 4, 'bytes=0-3'],
    [6, 6, 9, 'bytes=0-5'],
  ]) {
    const whole = makeWhole(size);
    let requests = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/valid-200.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': String(size) } });
        assert.equal(init.headers.Range, range);
        requests++;
        return fakeRes(200, { body: whole.slice(0, bodyLength) });
      },
    });
    const expected = whole.slice(0, Math.min(length, size));
    assert.deepEqual(await ds.read(0, length), expected);
    assert.deepEqual(await ds.read(0, length), expected);
    assert.equal(requests, 1);
    assert.equal(ds.size, size);
    await ds.close();
  }
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


test('requestInit.method 不能覆盖内部 HEAD 与 Range GET', async () => {
  for (const override of ['POST', 'HEAD', 'DELETE']) {
    const requests = [];
    const whole = makeWhole(8);
    const ds = new HttpRangeDataSource('https://fixture.invalid/fixed-method.mp4', {
      chunkSize: 4,
      requestInit: { method: override, credentials: 'include', headers: { Authorization: 'token' } },
      fetchImpl: async (_url, init) => {
        requests.push(init);
        assert.equal(init.credentials, 'include');
        assert.equal(init.headers.Authorization, 'token');
        if (init.headers.Range === undefined) {
          assert.equal(init.method, 'HEAD');
          return fakeRes(200, { headers: { 'content-length': '8' } });
        }
        assert.equal(init.method, 'GET');
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
        return fakeRes(206, { body: whole.slice(Number(start), Number(end) + 1) });
      },
    });
    assert.deepEqual([...await ds.read(4, 2)], [4, 5]);
    assert.deepEqual(requests.map((request) => request.method), ['HEAD', 'GET']);
    await ds.close();
  }
});

test('requestInit.method 不改变 Range GET 探测方法', async () => {
  const methods = [];
  const ds = new HttpRangeDataSource('https://fixture.invalid/probe-method.mp4', {
    chunkSize: 4,
    requestInit: { method: 'POST' },
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'HEAD') return fakeRes(405);
      assert.equal(init.method, 'GET');
      if (init.headers.Range === 'bytes=0-0') {
        return fakeRes(206, { headers: { 'content-range': 'bytes 0-0/4' } });
      }
      return fakeRes(206, { body: new Uint8Array([1, 2, 3, 4]) });
    },
  });
  assert.deepEqual([...await ds.read(0, 1)], [1]);
  assert.deepEqual(methods, ['HEAD', 'GET', 'GET']);
  await ds.close();
});

test('requestInit.headers：保留自定义头并在探测与分段请求中发送 Range', async () => {
  const whole = makeWhole(256);
  const requests = [];
  const ds = new HttpRangeDataSource('http://fixture.invalid/auth.mp4', {
    chunkSize: 128,
    requestInit: { headers: { Authorization: 'Bearer token' } },
    fetchImpl: async (_url, init = {}) => {
      requests.push(init);
      if (init.method === 'HEAD') return fakeRes(405);
      const range = init.headers?.Range;
      if (range === 'bytes=0-0') {
        return fakeRes(206, {
          headers: { 'content-range': `bytes 0-0/${whole.length}` },
          body: new ArrayBuffer(0),
        });
      }
      const match = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      assert.ok(match, 'Range header must survive requestInit.headers');
      const [start, end] = [Number(match[1]), Number(match[2])];
      return fakeRes(206, { body: whole.slice(start, end + 1) });
    },
  });

  const result = await ds.read(128, 8);

  assert.deepEqual([...result], [...whole.slice(128, 136)]);
  assert.equal(requests[1].headers.Authorization, 'Bearer token');
  assert.equal(requests[1].headers.Range, 'bytes=0-0');
  assert.equal(requests[2].headers.Authorization, 'Bearer token');
  assert.equal(requests[2].headers.Range, 'bytes=128-255');
});
test('HeadersInit 合并保留认证、大小写覆盖及内部 Range', async () => {
  const whole = makeWhole(256);
  const optionHeaders = new Headers({ Authorization: 'old', 'X-Option': 'yes', range: 'bytes=9-9' });
  const requestHeaders = [['authorization', 'Bearer token'], ['X-Repeat', 'one'], ['x-repeat', 'two']];
  const requests = [];
  const ds = new HttpRangeDataSource('https://fixture.invalid/headers.mp4', {
    chunkSize: 128,
    headers: optionHeaders,
    requestInit: { headers: requestHeaders, credentials: 'include' },
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init.headers);
      requests.push({ headers, credentials: init.credentials, raw: init.headers });
      if (headers.get('authorization') !== 'Bearer token') return fakeRes(401);
      if (init.method === 'HEAD') return fakeRes(405);
      const range = headers.get('range');
      if (range === 'bytes=0-0') return fakeRes(206, { headers: { 'content-range': 'bytes 0-0/256' } });
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      assert.ok(match);
      return fakeRes(206, { body: whole.slice(Number(match[1]), Number(match[2]) + 1) });
    },
  });
  assert.deepEqual([...await ds.read(128, 8)], [...whole.slice(128, 136)]);
  assert.deepEqual(requests.map((r) => r.headers.get('range')), ['bytes=9-9', 'bytes=0-0', 'bytes=128-255']);
  for (const request of requests) {
    assert.equal(request.headers.get('authorization'), 'Bearer token');
    assert.equal(request.headers.get('x-option'), 'yes');
    assert.equal(request.headers.get('x-repeat'), 'one, two');
    assert.equal(request.credentials, 'include');
    assert.equal(Object.getPrototypeOf(request.raw), Object.prototype);
  }
  assert.equal(optionHeaders.get('authorization'), 'old');
  assert.deepEqual(requestHeaders, [['authorization', 'Bearer token'], ['X-Repeat', 'one'], ['x-repeat', 'two']]);
});

test('无全局 Headers 时自定义 fetch 仍可合并普通对象和元组', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Headers');
  Object.defineProperty(globalThis, 'Headers', { value: undefined, configurable: true });
  try {
    const ds = new HttpRangeDataSource('https://fixture.invalid/no-headers.mp4', {
      headers: [['authorization', 'old'], ['range', 'bytes=9-9']],
      requestInit: { headers: { Authorization: 'new' } },
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'new');
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '4' } });
        assert.equal(init.headers.Range, 'bytes=0-3');
        assert.equal(Object.keys(init.headers).filter((key) => key.toLowerCase() === 'range').length, 1);
        return fakeRes(206, { body: new Uint8Array([1, 2, 3, 4]) });
      },
      chunkSize: 4,
    });
    assert.deepEqual([...await ds.read(0, 4)], [1, 2, 3, 4]);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'Headers', saved);
    else delete globalThis.Headers;
  }
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

test('206 可见 Content-Range 错位或非法时拒绝，正确重试不命中坏缓存', async () => {
  const invalid = ['bytes 0-3/12', 'bytes 4-8/12', 'garbage', '', 'bytes 9007199254740993-9007199254740996/*'];
  invalid.push(...['0', '6', '8', '11', '13', '9007199254740991', '9007199254740992'].map((total) => 'bytes 4-7/' + total));
  for (const contentRange of invalid) {
    let requests = 0;
    let cancelled = 0;
    let bodyReads = 0;
    const ds = new HttpRangeDataSource('https://fixture.invalid/misaligned.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '12' } });
        assert.equal(init.headers.Range, 'bytes=4-7');
        requests++;
        return {
          status: 206,
          headers: { get: () => requests === 1 ? contentRange : 'bytes 4-7/12' },
          body: { cancel() { cancelled++; return Promise.reject(new Error('best effort')); } },
          async arrayBuffer() { bodyReads++; return new Uint8Array(requests === 1 ? [0, 1, 2, 3] : [4, 5, 6, 7]).buffer; },
        };
      },
    });
    await assert.rejects(() => ds.read(4, 4), (error) => error.code === 'SOURCE_ERROR' && /Content-Range/.test(error.message), contentRange);
    assert.equal(ds._cache.size, 0);
    assert.equal(cancelled, 1);
    assert.equal(bodyReads, 0);
    assert.deepEqual([...await ds.read(4, 4)], [4, 5, 6, 7]);
    assert.equal(requests, 2);
    assert.equal(bodyReads, 1);
    assert.equal(cancelled, 1);
    assert.equal(ds.size, 12);
    assert.deepEqual([...await ds.read(4, 4)], [4, 5, 6, 7]);
    assert.equal(requests, 2);
    await ds.close();
  }
});

test('206 匹配或不可见 Content-Range 保留跨块与尾块读取', async () => {
  const whole = makeWhole(10);
  for (const total of ['10', '00010', '*', null]) {
    const ds = new HttpRangeDataSource('https://fixture.invalid/ranges.mp4', {
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '10' } });
        const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
        const start = Number(startText), end = Number(endText);
        return fakeRes(206, {
          headers: total != null ? { 'content-range': 'BYTES ' + start + '-' + end + '/' + total } : {},
          body: whole.slice(start, end + 1),
        });
      },
    });
    assert.deepEqual([...await ds.read(2, 20)], [...whole.slice(2)]);
    await ds.close();
  }
});

test('close：多段在途 read 正常完成，但不回填已清理缓存', async () => {
  const firstRange = deferred();
  let rangeRequests = 0;
  const ds = new HttpRangeDataSource('https://fixture.invalid/close.mp4', {
    chunkSize: 4,
    fetchImpl: async (_url, init = {}) => {
      if (init.method === 'HEAD') return fakeRes(200, { headers: { 'content-length': '12', 'accept-ranges': 'bytes' } });
      rangeRequests++;
      if (rangeRequests === 1) return firstRange.promise;
      return fakeRes(206, { body: new Uint8Array([9, 10, 11, 12]).buffer });
    },
  });
  await ds.open();
  ds._put(1, new Uint8Array([5, 6, 7, 8]));
  const reading = ds.read(0, 12);
  assert.equal(rangeRequests, 1);

  await ds.close();
  assert.equal(ds._cache.size, 0);
  firstRange.resolve(fakeRes(206, { body: new Uint8Array([1, 2, 3, 4]).buffer }));
  assert.deepEqual([...await reading], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(rangeRequests, 2);
  assert.equal(ds._cache.size, 0);
});
