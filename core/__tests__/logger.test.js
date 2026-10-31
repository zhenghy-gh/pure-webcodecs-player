import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
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

test('logBytes：ArrayBufferView按原始byte窗口输出并正确截断', () => {
  const backing = Uint8Array.from([0xaa, 0x01, 0x02, 0x03, 0x04, 0xbb, 0xcc, 0xdd]);
  const dataView = new DataView(backing.buffer, 1, 4);
  assert.equal(logBytes(dataView), 'hex[4B] 01020304');
  assert.equal(logBytes(dataView, 2), 'hex[4B] 0102…');
  assert.equal(logBytes(backing.buffer), 'hex[8B] aa01020304bbccdd');

  const wideView = new Uint16Array(backing.buffer, 2, 2);
  const rawWide = new Uint8Array(wideView.buffer, wideView.byteOffset, wideView.byteLength);
  const wideHex = Array.from(rawWide, (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(logBytes(wideView), `hex[${wideView.byteLength}B] ${wideHex}`);

  const longBacking = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
  const longDataView = new DataView(longBacking.buffer, 2, 20);
  const dataWindow = new Uint8Array(longDataView.buffer, longDataView.byteOffset, longDataView.byteLength);
  const dataHex = Array.from(dataWindow.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(logBytes(longDataView), `hex[20B] ${dataHex}…`);

  const longTypedView = new Uint32Array(longBacking.buffer, 4, 5);
  const typedWindow = new Uint8Array(longTypedView.buffer, longTypedView.byteOffset, longTypedView.byteLength);
  const typedHex = Array.from(typedWindow.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(logBytes(longTypedView), `hex[20B] ${typedHex}…`);
});

test('logBytes：Buffer子视图和跨realm DataView保留字节窗口', () => {
  const buffer = Buffer.from([0xaa, 0xde, 0xad, 0xbb]);
  assert.equal(logBytes(buffer.subarray(1, 3)), 'hex[2B] dead');

  const foreignView = runInNewContext('(() => { const bytes = new Uint8Array([0xaa, 0x10, 0x20, 0xbb]); return new DataView(bytes.buffer, 1, 2); })()');
  assert.equal(logBytes(foreignView), 'hex[2B] 1020');
});

test('logBytes：默认16字节边界精确保留省略号语义', () => {
  const bytes = Uint8Array.from({ length: 17 }, (_, index) => index + 1);
  const first16 = '0102030405060708090a0b0c0d0e0f10';
  assert.equal(logBytes(bytes.subarray(0, 16)), `hex[16B] ${first16}`);
  assert.equal(logBytes(bytes), `hex[17B] ${first16}…`);
});

test('logBytes：调用方不能突破16字节硬上限', () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
  const first16 = '0102030405060708090a0b0c0d0e0f10';
  assert.equal(logBytes(bytes, 17), `hex[20B] ${first16}…`);
  assert.equal(logBytes(bytes, Infinity), `hex[20B] ${first16}…`);
  assert.equal(logBytes(bytes, 2), 'hex[20B] 0102…');
  assert.equal(logBytes(bytes, 0), 'hex[20B] …');
  const view = new DataView(bytes.buffer, 2, 18);
  assert.equal(logBytes(view, 20), 'hex[18B] 030405060708090a0b0c0d0e0f101112…');
});
