/**
 * core 基础设施补充：ChunkBuffer（契约 §2.1）与 HttpRangeDataSource（注入 fetch 离线可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChunkBuffer,
  MemoryDataSource,
  BlobDataSource,
  asDataSource,
} from '../src/data-source.js';
import { HttpRangeDataSource } from '../src/http-range-source.js';

function makeWhole(len = 1024) {
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = i & 0xff;
  return u8;
}

test('ChunkBuffer：跨块读取与整段一致性', async () => {
  const whole = makeWhole(1000);
  const buf = new ChunkBuffer();
  for (let off = 0; off < whole.length; off += 256) {
    buf.append(whole.subarray(off, Math.min(off + 256, whole.length)));
  }
  buf.end();
  assert.equal(buf.size, 1000);

  const a = await buf.read(0, 300);
  assert.deepEqual([...a], [...whole.subarray(0, 300)]);
  const b = await buf.read(999, 1);
  assert.deepEqual([...b], [whole[999]]);
});

test('ChunkBuffer：未 end 时数据不足给出"尚不足"语义错误', async () => {
  const buf = new ChunkBuffer();
  buf.append(new Uint8Array(10));
  await assert.rejects(
    () => buf.read(0, 20),
    (e) => e.code === 'SOURCE_ERROR' && /not enough data yet/.test(e.message),
  );
});

test('ChunkBuffer：end 后越界与重复 end 保护', async () => {
  const buf = new ChunkBuffer();
  buf.append(new Uint8Array(4)).end();
  await assert.rejects(() => buf.read(2, 8), (e) => /beyond end/.test(e.message));
  assert.throws(() => buf.append(new Uint8Array(1)), /ended/);
  assert.equal(buf.size, 4);
});

// ── MemoryDataSource ────────────────────────────────────

test('MemoryDataSource：Uint8Array 与 ArrayBuffer 两种入参', async () => {
  const u8 = Uint8Array.from([1, 2, 3, 4]);
  const fromU8 = new MemoryDataSource(u8);
  assert.equal(fromU8.size, 4);
  assert.equal(fromU8.uri, 'memory');
  assert.deepEqual([...(await fromU8.read(1, 2))], [2, 3]);

  const fromAb = new MemoryDataSource(u8.buffer);
  assert.equal(fromAb.size, 4, 'ArrayBuffer 入参应被包装为 Uint8Array');
  assert.deepEqual([...(await fromAb.read(0))], [1, 2, 3, 4], '省略 length 读至末尾');
});

test('MemoryDataSource：越界三类一律 SOURCE_ERROR', async () => {
  const ds = new MemoryDataSource(Uint8Array.from([1, 2, 3, 4]));
  await assert.rejects(() => ds.read(-1, 2), (e) => e.code === 'SOURCE_ERROR');
  await assert.rejects(() => ds.read(2, 10), (e) => e.code === 'SOURCE_ERROR');
  await assert.rejects(() => ds.read(3, -1), (e) => e.code === 'SOURCE_ERROR');
  await assert.equal(await ds.open(), undefined, 'open/close 为 noop');
  await assert.equal(await ds.close(), undefined);
  assert.equal((await ds.read(4, 0)).byteLength, 0, '末尾零长读取合法');
});

// ── BlobDataSource ──────────────────────────────────────

test('BlobDataSource：File 取文件名，Blob 回退 blob', async () => {
  const bytes = Uint8Array.from([9, 8, 7, 6, 5]);
  const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
  const ds = new BlobDataSource(file);
  assert.equal(ds.size, 5);
  assert.equal(ds.name, 'clip.mp4');
  assert.equal(ds.uri, 'file:clip.mp4');
  assert.deepEqual([...(await ds.read(1, 3))], [8, 7, 6]);

  const plain = new Blob([bytes]);
  const ds2 = new BlobDataSource(plain);
  assert.equal(ds2.name, 'blob', '无 name 时回退 blob');
  assert.equal(ds2.uri, 'file:blob');

  const named = new BlobDataSource(plain, 'custom.bin');
  assert.equal(named.name, 'custom.bin', '显式 name 优先');
  assert.deepEqual([...(await named.read(0))], [9, 8, 7, 6, 5], '省略 length 读至末尾');
});

test('BlobDataSource：尾部越界截断到 size，负偏移/超界报 SOURCE_ERROR', async () => {
  const ds = new BlobDataSource(new File([Uint8Array.from([1, 2, 3])], 'a.bin'));
  // read 对 end 取 Math.min(blob.size, offset+length)，尾部不报错而是截断
  assert.equal((await ds.read(1, 100)).byteLength, 2);
  await assert.rejects(() => ds.read(-1, 1), (e) => e.code === 'SOURCE_ERROR' && /offset=-1/.test(e.message));
  await assert.rejects(() => ds.read(99, 1), (e) => e.code === 'SOURCE_ERROR');
  assert.equal((await ds.read(3, 1)).byteLength, 0, 'offset == size 允许，返回空');
});

test('BlobDataSource：环境无 Blob 时构造即 SOURCE_ERROR', () => {
  const saved = globalThis.Blob;
  // 先构造好对象（Blob 的第二参是 options，文件名只有 File 支持）
  const file = new File([Uint8Array.from([1])], 'x.bin');
  try {
    // eslint-disable-next-line no-global-assign
    delete globalThis.Blob;
    assert.throws(
      () => new BlobDataSource(file),
      (e) => e.code === 'SOURCE_ERROR' && /Blob is not available/.test(e.message),
    );
  } finally {
    globalThis.Blob = saved;
  }
});

// ── asDataSource ────────────────────────────────────────

test('asDataSource：鸭子类型直通，缺 read 抛 TypeError', () => {
  const src = { read: async () => new Uint8Array(0), size: 1 };
  assert.equal(asDataSource(src), src, '具备 read 即原样返回');
  assert.throws(() => asDataSource({ size: 1 }), TypeError);
  assert.throws(() => asDataSource(null), TypeError, 'null 走可选链不崩');
  assert.throws(() => asDataSource(undefined), TypeError);
});

// ── ChunkBuffer 补充分支 ────────────────────────────────

test('ChunkBuffer：append 支持 ArrayBuffer，空块被忽略', async () => {
  const buf = new ChunkBuffer();
  assert.equal(buf.append(new Uint8Array(0)), buf, '空块直接返回 this');
  buf.append(Uint8Array.from([1, 2]).buffer); // ArrayBuffer 入参转换
  buf.append(Uint8Array.from([3]));
  assert.equal(buf.size, 3);
  assert.equal(buf.ended, false);
  assert.deepEqual([...(await buf.read(0))], [1, 2, 3], '省略 length → 读到当前末尾');
  buf.end();
  assert.equal(buf.ended, true);
  assert.deepEqual([...(await buf.read(2))], [3], 'end 后省略 length 仍可读尾部');
});

test('ChunkBuffer：负偏移与超界偏移报 out of range', async () => {
  const buf = new ChunkBuffer();
  buf.append(Uint8Array.from([1, 2, 3])).end();
  await assert.rejects(
    () => buf.read(-1, 1),
    (e) => e.code === 'SOURCE_ERROR' && /out of range/.test(e.message),
  );
  await assert.rejects(
    () => buf.read(4, 1),
    (e) => e.code === 'SOURCE_ERROR' && /out of range/.test(e.message),
  );
});

/** 构造注入式 fetch：HEAD 报长度；Range 给 206；ignoreRange 模式无视 Range 返 200 */
function stubFetch(whole, { ignoreRange = false } = {}) {
  return async (_url, init = {}) => {
    const range = init.headers?.Range ?? init.headers?.range;
    if (init.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' },
      });
    }
    if (!range || ignoreRange) {
      if (!ignoreRange && !range && init.headers?.Range === undefined) {
        // open() 探测路径不会走到这（HEAD 已给 size）
      }
      return new Response(whole.slice(), {
        status: 200,
        headers: { 'content-length': String(whole.length) },
      });
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(m[1]);
    const endInclusive = Number(m[2]);
    return new Response(whole.slice(start, endInclusive + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${endInclusive}/${whole.length}`,
        'content-length': String(endInclusive - start + 1),
      },
    });
  };
}

test('HttpRangeDataSource（core 版）：HEAD 探长 + 跨块读 + 缓存淘汰后重读', async () => {
  const whole = makeWhole(1024);
  let requests = 0;
  const ds = new HttpRangeDataSource('http://fixture.invalid/core.mp4', {
    chunkSize: 256,
    maxCachedBlocks: 2,
    fetchImpl: async (_u, init = {}) => {
      requests++;
      return stubFetch(whole)(_u, init);
    },
  });
  await ds.open();
  assert.equal(ds.size, 1024);

  const a = await ds.read(250, 20); // 跨块
  assert.deepEqual([...a], [...whole.subarray(250, 270)]);

  // 冲刷缓存超过容量后，旧区间重读仍正确（重新发 Range）
  for (let off = 0; off < 1024; off += 256) await ds.read(off, 8);
  const again = await ds.read(250, 20);
  assert.deepEqual([...again], [...whole.subarray(250, 270)]);
  assert.ok(requests > 3, `应发生多次 Range 请求，实际 ${requests}`);
});

test('HttpRangeDataSource：无 HEAD 允许时退回 Content-Range 探测', async () => {
  const whole = makeWhole(512);
  const ds = new HttpRangeDataSource('http://fixture.invalid/b.mp4', {
    chunkSize: 128,
    fetchImpl: async (_u, init = {}) => {
      if (init.method === 'HEAD') return new Response(null, { status: 405 });
      const range = init.headers?.Range ?? init.headers?.range;
      if (!range) throw new Error('unexpected plain GET');
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Number(m[2]);
      return new Response(whole.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${whole.length}` },
      });
    },
  });
  await ds.open();
  assert.equal(ds.size, 512);
  const part = await ds.read(500, 12); // 尾部跨界截断到 size
  assert.equal(part.byteLength, 12);
  assert.deepEqual([...part], [...whole.subarray(500, 512)]);
});
