/**
 * AMF0 编解码单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeAmf0, decodeAmf0All, encodeAmf0, encodeScriptPair } from '../src/amf0.js';

test('标量编解码往返', () => {
  for (const v of [3.14, -7, 0, true, false, 'hello', '中文✓']) {
    const { value, offset } = decodeAmf0(encodeAmf0(v));
    assert.equal(value, v, `${String(v)} 往返`);
    assert.ok(offset > 0);
  }
  const { value } = decodeAmf0(encodeAmf0(null));
  assert.equal(value, null);
});

test('嵌套对象与 ECMA 数组', () => {
  const meta = {
    width: 1920,
    height: 1080,
    duration: 12.5,
    videocodecid: 7,
    audiocodecid: 10,
    tags: ['a', 'b'],
    nested: { fps: 30, deep: { ok: true } },
  };
  const { value } = decodeAmf0(encodeAmf0(meta));
  assert.deepEqual(value.width, meta.width);
  assert.deepEqual(value.tags, ['a', 'b']);
  assert.deepEqual(value.nested.deep.ok, true);
});

test('decodeAmf0All：脚本二元组（方法名+参数）', () => {
  const body = encodeScriptPair('onMetaData', { duration: 42 });
  const values = decodeAmf0All(body);
  assert.equal(values.length, 2);
  assert.equal(values[0], 'onMetaData');
  assert.deepEqual(values[1].duration, 42);
});

test('非法数据返回 null / 空数组', () => {
  assert.equal(decodeAmf0(new Uint8Array([0xff])), null);
  assert.deepEqual(decodeAmf0All(new Uint8Array([0x02, 0x00, 0x05])), []);   // 截断的字符串
});
