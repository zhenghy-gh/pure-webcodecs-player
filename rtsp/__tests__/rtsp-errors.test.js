/**
 * errors.js 专项测试 —— 该模块此前零覆盖（全部来自间接调用）。
 * 覆盖：错误码封闭枚举登记、PlayerError 字段形状、未登记错误码抛错、
 * 各工厂函数产出的 code/message/detail。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlayerError, errors } from '../src/errors.js';

test('PlayerError：登记过的 code 正常构造，字段形状正确', () => {
  const e = new PlayerError('PARSE_ERROR', '无法解析', { hint: 1 });
  assert.equal(e.name, 'PlayerError');
  assert.equal(e.code, 'PARSE_ERROR');
  assert.equal(e.message, '无法解析');
  assert.deepEqual(e.detail, { hint: 1 });
  assert.ok(e instanceof Error);
});

test('PlayerError：未登记的错误码构造时抛错', () => {
  assert.throws(() => new PlayerError('NOT_A_REAL_CODE', 'x'), /未登记的错误码: NOT_A_REAL_CODE/);
});

test('errors.network / timeout / source 工厂产出对应 code', () => {
  assert.equal(errors.network('网络挂了', { a: 1 }).code, 'NETWORK_ERROR');
  assert.equal(errors.timeout('超时').code, 'TIMEOUT');
  assert.equal(errors.source('源错误').code, 'SOURCE_ERROR');
});

test('errors.state / parse / notSupported 工厂产出对应 code', () => {
  assert.equal(errors.state('状态非法').code, 'STATE_ERROR');
  assert.equal(errors.parse('解析失败').code, 'PARSE_ERROR');
  assert.equal(errors.notSupported('不支持').code, 'NOT_SUPPORTED');
});

test('errors.aborted：默认文案，且 code 为 ABORTED', () => {
  const e = errors.aborted();
  assert.equal(e.code, 'ABORTED');
  assert.equal(e.message, '用户主动中断');
  // 允许传入自定义文案
  assert.equal(errors.aborted('手动取消').message, '手动取消');
});

test('errors 工厂透传 detail（禁止二进制本体）', () => {
  const detail = { status: 503, url: 'ws://x' };
  const e = errors.network('msg', detail);
  assert.strictEqual(e.detail, detail);
});

test('所有声明的错误码均可在封闭枚举中找到', () => {
  const declared = [
    'PROBE_FAILED', 'PARSE_ERROR', 'NOT_SUPPORTED', 'SOURCE_ERROR',
    'NETWORK_ERROR', 'DECODE_ERROR', 'SEEK_UNSUPPORTED', 'TIMEOUT',
    'ABORTED', 'STATE_ERROR',
  ];
  for (const code of declared) {
    assert.doesNotThrow(() => new PlayerError(code, 'ok'), `code=${code} 应可构造`);
  }
});
