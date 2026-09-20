/**
 * flv-index-probe-gaps.test.js —— flv/index.js probe 防御分支补测（wave 145）
 *
 * 覆盖：§10 probe 对内部探测抛错的防御（catch → null，禁止外泄异常）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probe, FlvDemuxer } from '../src/index.js';

test('probe：底层探测抛错 → 吞错返回 null（§10 禁止抛异常）', () => {
  const original = FlvDemuxer.probe;
  FlvDemuxer.probe = () => { throw new Error('inject: probe exploded'); };
  try {
    assert.equal(probe(new Uint8Array(16)), null);
  } finally {
    FlvDemuxer.probe = original;
  }
});
