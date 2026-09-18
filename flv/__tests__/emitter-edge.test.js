/**
 * flv Emitter 残余分支补测（wave 123，与 ts/src/emitter.js 同构镜像）：
 *  - 普通事件监听器抛错 → 转发 'error' 事件
 *  - 'error' 处理器自身抛错 → 降级 console.error（不递归）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { Emitter } from '../src/emitter.js';

test('emit：监听器抛错转发 error 事件，后续监听器不受影响', () => {
  const e = new Emitter();
  const seen = [];
  e.on('error', (err) => seen.push(['forwarded', err]));
  e.on('data', () => {
    throw new Error('listener exploded');
  });
  e.on('data', () => seen.push(['second', 'ok']));
  e.emit('data', 1);
  assert.equal(seen[0][0], 'forwarded');
  assert.equal(seen[0][1].message, 'listener exploded');
  assert.deepEqual(seen[1], ['second', 'ok']);
});

test("emit：'error' 处理器自身抛错降级 console.error，不递归", () => {
  const e = new Emitter();
  const errLog = mock.method(console, 'error', () => {});
  try {
    e.on('error', () => {
      throw new Error('handler exploded');
    });
    assert.doesNotThrow(() => e.emit('error', new Error('original')));
    assert.equal(errLog.mock.calls.length, 1);
    assert.equal(errLog.mock.calls[0].arguments[1].message, 'handler exploded');
  } finally {
    errLog.mock.restore();
  }
});
