/**
 * Demuxer 基类过渡别名残余补测（第二百零四波）
 * ------------------------------------------------------------
 * §2.4 过渡别名（M2 清理前须保持行为）：getMediaInfo 访问器与
 * readSampleData 的三段——已有 data 短路 / 无 source 守卫 / lazy 从源读取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Demuxer, MemoryDataSource } from '../src/index.js';

class FakeDemuxer extends Demuxer {
  static containerName = 'fake';
  _createTrackIterator() { return (function* () {})(); }
}

test('getMediaInfo：返回 mediaInfoValue 引用（含 null 初值与赋值后透传）', () => {
  const d = new FakeDemuxer(null);
  assert.equal(d.getMediaInfo(), null);
  const info = { durationUs: 1000, tracks: [] };
  d.mediaInfoValue = info;
  assert.equal(d.getMediaInfo(), info);
});

test('readSampleData：sample.data 已就绪 → 直接短路不触碰 source', async () => {
  let touched = false;
  const d = new FakeDemuxer({ read: async () => { touched = true; return new Uint8Array(1); } });
  const data = new Uint8Array([7, 7, 7]);
  const got = await d.readSampleData({ data, offset: 0, size: 3 });
  assert.equal(got, data);
  assert.equal(touched, false);
});

test('readSampleData：无 source → STATE_ERROR no source attached', async () => {
  const d = new FakeDemuxer(null);
  await assert.rejects(
    () => d.readSampleData({ offset: 0, size: 4 }),
    (e) => e.code === 'STATE_ERROR' && /no source attached/.test(e.message),
  );
});

test('readSampleData：lazy 形态从源按 offset/size 读取并回填 sample.data', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const d = new FakeDemuxer(new MemoryDataSource(bytes));
  const sample = { offset: 2, size: 3 };
  const got = await d.readSampleData(sample);
  assert.deepEqual([...got], [3, 4, 5]);
  assert.equal(sample.data, got, '应回填缓存，二次调用短路');
  assert.deepEqual([...(await d.readSampleData(sample))], [3, 4, 5]);
});
