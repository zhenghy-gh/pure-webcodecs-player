/**
 * index-gaps.test.js —— ts 模块出口 probe 防御性 catch 补测（wave 160）
 *
 * 覆盖：index.js probe 包装的 catch（30-31）——底层 TsDemuxer.probe 全包裹
 * 理论上不抛，但出口契约「禁止抛异常」需独立保证：注入静态方法抛错验证
 * 出口仍返 null，finally 还原。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probe, TsDemuxer } from '../src/index.js';

test('probe：底层 probe 抛错时出口吞掉返回 null（契约：禁止抛异常）', () => {
  const original = TsDemuxer.probe;
  TsDemuxer.probe = () => { throw new Error('注入：底层探针故障'); };
  try {
    assert.equal(probe(new Uint8Array([0x47, 0x47, 0x47, 0x47, 0x47, 0x47, 0x47, 0x47])), null);
  } finally {
    TsDemuxer.probe = original;
  }
  // 还原后行为正常：同步字节命中
  const hit = probe(new Uint8Array(8 * 188).fill(0x47));
  assert.equal(hit.container, 'ts');
});
