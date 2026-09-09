/**
 * ISO-BMFF 侧的大输入防护（评审第二轮 I5 ⑤）。
 *
 * 背景：moov size 与 stsz 的 sample size 均来自文件本身，畸形文件可声明任意 32 位值。
 * 修复前 `source.read(offset, sample.size)` 会被直接执行，一个 2GB 的样本声明即触发
 * 2GB 的 Range 请求与内存分配。现由 readCapped 统一按上界拦截。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readCapped, Mp4Demuxer } from '../src/demuxer.js';
import { MovDemuxer } from '../../mov/src/demuxer.js';
import { ErrorCode } from '../../core/src/errors.js';

function fakeSource() {
  const calls = [];
  return {
    size: 1 << 30,
    calls,
    async read(offset, length) {
      calls.push([offset, length]);
      return new Uint8Array(length);
    },
  };
}

test('readCapped：上界内原样委派 source.read', async () => {
  const src = fakeSource();
  const out = await readCapped(src, 8, 1024, { max: 4096, what: '测试' });
  assert.equal(out.byteLength, 1024);
  assert.deepEqual(src.calls, [[8, 1024]]);
});

test('readCapped：越界抛 PARSE_ERROR 且根本不发起读取', async () => {
  const src = fakeSource();
  await assert.rejects(
    () => readCapped(src, 8, 2 ** 31, { max: 1 << 20, what: 'MP4 moov' }),
    (err) => {
      assert.equal(err.code, ErrorCode.PARSE_ERROR);
      assert.match(err.message, /MP4 moov\s*越界/);
      return true;
    },
  );
  assert.deepEqual(src.calls, [], '越界时不得触达数据源');
});

test('readCapped：负数/NaN/Infinity 长度同样被拒', async () => {
  const src = fakeSource();
  for (const bad of [-1, NaN, Infinity]) {
    await assert.rejects(() => readCapped(src, 0, bad, { max: 100, what: 'MP4 样本' }));
  }
  assert.deepEqual(src.calls, []);
});

test('Mp4Demuxer 透传字节上界选项（maxMoovBytes / maxSampleBytes）', () => {
  const d = new Mp4Demuxer(fakeSource(), { maxMoovBytes: 1234, maxSampleBytes: 567 });
  assert.equal(d.maxMoovBytes, 1234);
  assert.equal(d.maxSampleBytes, 567);
});

test('Mp4Demuxer 默认值落在 64MB / 32MB', () => {
  const d = new Mp4Demuxer(fakeSource(), {});
  assert.equal(d.maxMoovBytes, 64 << 20);
  assert.equal(d.maxSampleBytes, 32 << 20);
});

test('MovDemuxer 继承 mp4 的上界字段（mov 的 moov 读取同样受保护）', () => {
  const d = new MovDemuxer(fakeSource(), { maxMoovBytes: 999 });
  assert.equal(d.maxMoovBytes, 999);
  assert.equal(typeof d._doOpen, 'function');
});
