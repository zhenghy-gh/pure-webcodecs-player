/**
 * ts Emitter 残余分支补测（第一百一十九波）：off()、监听器异常转发 error、
 * error 处理器自身抛错降级 console.error。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { Emitter } from '../src/emitter.js';

test('off()：精确移除指定监听，其余不受影响', () => {
  const e = new Emitter();
  const calls = [];
  const a = () => calls.push('a');
  const b = () => calls.push('b');
  e.on('evt', a);
  e.on('evt', b);
  e.off('evt', a);
  e.emit('evt');
  assert.deepEqual(calls, ['b']);
  e.off('不存在的事件', b); // 无集合时安全空操作
  e.emit('evt');
  assert.deepEqual(calls, ['b', 'b']);
});

test('监听器抛异常 → 转发到 error 事件，不打断其他监听器', () => {
  const e = new Emitter();
  const errs = [];
  const after = [];
  e.on('error', (err) => errs.push(err));
  e.on('evt', () => { throw new Error('listener boom'); });
  e.on('evt', () => after.push(1));
  e.emit('evt');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /listener boom/);
  assert.deepEqual(after, [1], '后续监听器照常执行');
});

test('error 处理器自身抛错 → 降级 console.error，不递归', () => {
  const e = new Emitter();
  const captured = [];
  const m = mock.method(console, 'error', (...args) => captured.push(args));
  try {
    e.on('error', () => { throw new Error('handler boom'); });
    e.emit('error', new Error('original'));
  } finally {
    m.mock.restore();
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0][0], /emitter: error 处理器自身抛出异常/);
  assert.match(captured[0][1].message, /handler boom/);
});
