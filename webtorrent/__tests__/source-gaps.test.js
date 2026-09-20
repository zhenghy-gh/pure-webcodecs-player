/**
 * source-gaps.test.js —— webtorrent source 残余分支补测（wave 158）
 *
 * 覆盖：withSizeAlias（私有兼容别名 helper，导出后直测）——
 *   返回同一对象、byteLength 走 size getter、configurable 可重定义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withSizeAlias } from '../src/source.js';

test('withSizeAlias：byteLength 为 size 的 getter 别名且 configurable', () => {
  const source = { size: 4096 };
  const ret = withSizeAlias(source);
  assert.equal(ret, source, '返回同一对象引用');
  assert.equal(source.byteLength, 4096, 'byteLength 跟随 size');
  source.size = 8192;
  assert.equal(source.byteLength, 8192, 'getter 动态读取');

  Object.defineProperty(source, 'byteLength', { value: 7 });
  assert.equal(source.byteLength, 7, 'configurable 允许重定义');
});
