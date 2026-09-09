/**
 * core 基础设施补充：ChunkBuffer（契约 §2.1）与 HttpRangeDataSource（注入 fetch 离线可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkBuffer } from '../src/data-source.js';
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
