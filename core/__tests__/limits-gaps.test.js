/**
 * limits-gaps.test.js —— limits.js 残余分支补测（wave 145）
 *
 * 覆盖：
 *   - clampReadLength：合法值原样透传（契约面薄包装，委托 assertByteLength）；
 *   - BoundedMapCache.delete：命中删除与未命中返回 false。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clampReadLength, BoundedMapCache } from '../src/limits.js';

test('clampReadLength：合法值原样返回（数值化）', () => {
  assert.equal(clampReadLength(1024, 2048, '样本'), 1024);
  assert.equal(clampReadLength('4096', 8192, '样本'), 4096, '字符串数字经 Number 化返回');
  assert.throws(() => clampReadLength(4096, 2048, '样本'), /样本越界/);
});

test('BoundedMapCache.delete：命中 true / 未命中 false', () => {
  const cache = new BoundedMapCache(4);
  cache.set('a', 1);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.delete('missing'), false);
});
