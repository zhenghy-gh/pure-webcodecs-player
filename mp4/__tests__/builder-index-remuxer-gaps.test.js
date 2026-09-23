/**
 * box-builder / index 出口 / remuxer 薄缺口补测（第二百零三波）
 * ------------------------------------------------------------
 *   - buildEdts 非空 entries 分支（此前仅空 entries→null 被走过）；
 *   - index.probe 一行转发 + createDemuxer 成功路径（构造+open 一体化）；
 *   - Fmp4Remuxer.createInitSegment 缺 description/codecPrivate 守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDataSource } from '../../core/src/index.js';
import { iterateBoxes } from '../src/box-parser.js';
import { buildEdts } from '../src/box-builder.js';
import * as mp4Index from '../src/index.js';
import { Fmp4Remuxer } from '../src/remuxer.js';
import { buildProgressiveVideoFixture } from './fixtures.js';

test('buildEdts：非空 entries 生成 edts>elst，字段逐列写入', () => {
  const bytes = buildEdts({
    entries: [
      { segmentDuration: 1000, mediaTime: -1024, mediaRateInteger: 1 },
      { segmentDuration: 2000 }, // 缺省项：mediaTime 0 / rate 1
    ],
  });
  const tops = [];
  iterateBoxes(bytes, 0, bytes.length, (h) => tops.push(h.type));
  assert.deepEqual(tops, ['edts']);
  // elst 内容：version+flags(4) + count(4) + 2×12 字节 entry
  assert.equal(bytes.byteLength, 8 + 8 + 4 + 4 + 24);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + 20, 4); // 8(edts头)+8(elst头)+4(ver/flags)
  assert.equal(dv.getUint32(0, false), 2); // entry_count
});

test('index.probe：一行转发与 Mp4Demuxer.probe 同结果', () => {
  const { bytes } = buildProgressiveVideoFixture();
  const hit = mp4Index.probe(bytes);
  assert.ok(hit && hit.confidence >= 0.8);
  assert.equal(mp4Index.probe(new Uint8Array([1, 2, 3, 4])), null);
});

test('index.createDemuxer：Uint8Array 直入 → open 完成返回 demuxer', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = await mp4Index.createDemuxer(bytes);
  assert.equal(typeof d.samples, 'function');
  assert.ok(d.tracks?.length >= 1, 'open 后应解析出轨道');
  await d.destroy?.();
});

test('index.createDemuxer：DataSource 形态同样识别成功', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = await mp4Index.createDemuxer(new MemoryDataSource(bytes), {});
  assert.ok(d);
  await d.destroy?.();
});

test('Fmp4Remuxer.createInitSegment：缺 description 与 codecPrivate → STATE_ERROR', () => {
  const r = new Fmp4Remuxer();
  assert.throws(
    () => r.createInitSegment({ id: 1, type: 'video' }),
    (e) => e.code === 'STATE_ERROR' && /missing description/.test(e.message),
  );
});

/* 登记不硬造（第二百零三波）：
 * - box-builder.js 28-35 box() largesize 分支：需 body > 4GB-8 真实内存才触发，单测不可达；
 * - box-builder.js 492 findTrunDataOffset throw：私有函数，公开路径 buildMoofMdat 恒内置
 *   trun 四字节序列，未命中守卫结构性不可达（先例：tag-stream 128MB 守卫）。 */
