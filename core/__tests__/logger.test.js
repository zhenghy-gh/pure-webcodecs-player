import test from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel, logBytes, createLogger } from '../src/logger.js';

test('createLogger：级别门控（默认 warn，debug/info 被抑制）', () => {
  const calls = [];
  const orig = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  console.debug = console.info = console.log = (...a) => calls.push(['low', a]);
  console.warn = console.error = (...a) => calls.push(['high', a]);
  try {
    setLogLevel('warn');
    const log = createLogger('mp4');
    log.debug('逐 box');      // 抑制
    log.info('生命周期');      // 抑制
    log.warn('可恢复异常', 1); // 输出
    log.error('终止故障', 2);  // 输出
    const levels = calls.map((c) => c[0]);
    assert.deepEqual(levels, ['high', 'high']);
    assert.ok(calls[0][1][0].includes('[mp4]'));
    assert.equal(calls[0][1][1], '可恢复异常');
  } finally {
    Object.assign(console, orig);
  }
});

test('setLogLevel：调到 debug 后全量输出；非法级别抛错', () => {
  const seen = [];
  const orig = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  console.debug = console.info = console.warn = console.error = console.log = (...a) => seen.push(a);
  try {
    setLogLevel('debug');
    const log = createLogger('core');
    log.debug('d');
    log.info('i');
    assert.equal(seen.length, 2);
    assert.throws(() => setLogLevel('verbose'), TypeError);
    setLogLevel(LogLevel.error);
    seen.length = 0;
    log.warn('被抑制');
    assert.equal(seen.length, 0);
  } finally {
    setLogLevel('warn');
    Object.assign(console, orig);
  }
});

test('logBytes：二进制安全预览，最多前 16 字节 hex', () => {
  const bytes = new Uint8Array(20).map((_, i) => i + 1);
  const s = logBytes(bytes);
  assert.ok(s.startsWith('hex[20B] ') && s.endsWith('…'), '超限必须带省略号');
  const hexPart = s.slice('hex[20B] '.length).replace(/…$/, '');
  assert.equal(hexPart.length, 32, '16 字节 = 32 hex 字符');

  const small = new Uint8Array([0xde, 0xad]);
  assert.equal(logBytes(small), 'hex[2B] dead');
});
