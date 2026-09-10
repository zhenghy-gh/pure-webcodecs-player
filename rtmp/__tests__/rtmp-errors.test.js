/**
 * PlayerError / errors 工厂直接单元测试（此前仅被间接断言 e.code）。
 * 纯函数、零依赖、零网络。重点：封闭错误码枚举、各工厂产出的 code 与 message、detail 透传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlayerError, errors } from '../src/errors.js';

test('合法错误码：构造后 code/name/message/detail 正确', () => {
  const detail = { ts: 123 };
  const e = new PlayerError('PARSE_ERROR', '坏标签', detail);
  assert.equal(e.code, 'PARSE_ERROR');
  assert.equal(e.name, 'PlayerError');
  assert.equal(e.message, '坏标签');
  assert.equal(e.detail, detail);
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PlayerError);
});

test('未登记错误码：构造即抛（防止调用方乱用 code）', () => {
  assert.throws(
    () => new PlayerError('NOT_A_REAL_CODE', 'x'),
    (e) => /未登记的错误码/.test(e.message) && e instanceof Error,
  );
});

test('errors.network：code=NETWORK_ERROR 且透传 detail', () => {
  const d = { url: 'ws://x' };
  const e = errors.network('连不上', d);
  assert.equal(e.code, 'NETWORK_ERROR');
  assert.equal(e.message, '连不上');
  assert.equal(e.detail, d);
  assert.ok(e instanceof PlayerError);
});

test('errors.timeout / state：各自 code 正确', () => {
  assert.equal(errors.timeout('t').code, 'TIMEOUT');
  assert.equal(errors.state('s').code, 'STATE_ERROR');
});

test('errors.aborted：默认文案可覆盖', () => {
  assert.equal(errors.aborted().code, 'ABORTED');
  assert.equal(errors.aborted().message, '用户主动中断');
  assert.equal(errors.aborted('手动取消').message, '手动取消');
});

test('errors.parse / notSupported：code 与 message 透传', () => {
  assert.equal(errors.parse('p').code, 'PARSE_ERROR');
  assert.equal(errors.parse('p', { x: 1 }).detail.x, 1);
  assert.equal(errors.notSupported('n').code, 'NOT_SUPPORTED');
});

test('所有工厂均产出 PlayerError 实例（封闭类型）', () => {
  for (const fn of [errors.network, errors.timeout, errors.state, errors.aborted, errors.parse, errors.notSupported]) {
    const e = fn('m');
    assert.ok(e instanceof PlayerError, `${fn.name} 应产出 PlayerError`);
    assert.equal(typeof e.code, 'string');
  }
});
