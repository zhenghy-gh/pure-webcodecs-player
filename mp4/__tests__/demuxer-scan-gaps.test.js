/**
 * Mp4Demuxer 顶层扫描与 expandSampleTable 守卫补测（第二百零一波）
 * ------------------------------------------------------------
 *   - _scanTopLevel 直调：空表时逐盒扫描（free×2 幂等，二次调用早退）；
 *   - 尾部零头（剩余 <8 字节）→ PARSE_ERROR truncated box header；
 *   - 声明尺寸越过文件末尾 → PARSE_ERROR invalid top-level box；
 *   - expandSampleTable 缺 stts → PARSE_ERROR incomplete stbl tables。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDataSource } from '../../core/src/index.js';
import { Mp4Demuxer, expandSampleTable } from '../src/demuxer.js';

/** 8 字节纯头 free 盒 */
const free8 = (n = 8) => {
  const b = new Uint8Array(n);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, n);
  b.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
  return b;
};

const concat = (list) => {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
};

test('_scanTopLevel：直调空表逐盒扫描并幂等早退', async () => {
  const d = new Mp4Demuxer(new MemoryDataSource(concat([free8(8), free8(12)])));
  await d._scanTopLevel();
  assert.deepEqual(d._topLevelBoxes.map((b) => [b.type, b.start, b.end]), [
    ['free', 0, 8], ['free', 8, 20],
  ]);
  const first = d._topLevelBoxes;
  await d._scanTopLevel(); // 幂等：非空即早退，不重建数组
  assert.equal(d._topLevelBoxes, first);
});

test('_scanTopLevel：尾部剩余 <8 字节 → truncated box header', async () => {
  const d = new Mp4Demuxer(new MemoryDataSource(concat([free8(8), new Uint8Array(4)])));
  await assert.rejects(() => d._scanTopLevel(), (e) => {
    assert.equal(e.code, 'PARSE_ERROR');
    assert.match(e.message, /truncated box header at 8/);
    return true;
  });
});

test('_scanTopLevel：声明尺寸越过文件末尾 → invalid top-level box', async () => {
  const over = free8(8); // 实际 8 字节文件
  new DataView(over.buffer).setUint32(0, 16); // 头却声明 16
  const d = new Mp4Demuxer(new MemoryDataSource(over));
  await assert.rejects(() => d._scanTopLevel(), (e) => {
    assert.equal(e.code, 'PARSE_ERROR');
    assert.match(e.message, /invalid top-level box 'free' size=16/);
    return true;
  });
});

test('expandSampleTable：缺 stts → incomplete stbl tables', () => {
  assert.throws(
    () => expandSampleTable({
      stsz: { sizes: [4] },
      stsc: { entries: [{ firstChunk: 1, samplesPerChunk: 1 }] },
      stco: { offsets: [0] },
    }),
    (e) => {
      assert.equal(e.code, 'PARSE_ERROR');
      assert.match(e.message, /incomplete stbl tables/);
      return true;
    },
  );
});
