/**
 * index-gaps.test.js —— ape 模块入口残余分支补测（wave 150）
 *
 * 覆盖：probeApe 的 catch 兜底——输入无 length（null/undefined）导致
 * 属性访问抛 TypeError 时，契约「probe 永不抛」要求吞错返回 null。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeApe } from '../src/index.js';

test('probeApe：null/undefined 输入触发 catch 也不抛，返回 null', () => {
  assert.equal(probeApe(null), null);
  assert.equal(probeApe(undefined), null);
});
