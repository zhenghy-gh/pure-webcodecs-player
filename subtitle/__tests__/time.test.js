/**
 * subtitle/__tests__/time.test.js — 时间码解析与格式化（µs 整数域）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestamp, formatSrtTimestamp, formatVttTimestamp, formatAssTimestamp,
} from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('parseTimestamp：标准 SRT 逗号毫秒', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1_500_000);
});

test('parseTimestamp：句点毫秒与逗号等价', () => {
  assert.equal(parseTimestamp('00:00:01.500'), 1_500_000);
});

test('parseTimestamp：缺小时位 mm:ss.mmm', () => {
  // 05:06.250 → 5*60+6 秒 + 250ms
  assert.equal(parseTimestamp('05:06.250'), 306_250_000);
});

test('parseTimestamp：ASS 厘秒两位小数', () => {
  assert.equal(parseTimestamp('0:00:01.20'), 1_200_000);
});

test('parseTimestamp：单数字小数按十进制补齐（.5 = 500ms）', () => {
  assert.equal(parseTimestamp('00:00:00.5'), 500_000);
});

test('parseTimestamp：容忍首尾空白', () => {
  assert.equal(parseTimestamp('  00:00:02,000  '), 2_000_000);
});

test('parseTimestamp：非法文本抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp('abc'), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('parseTimestamp：分钟越界(60)抛错', () => {
  assert.throws(() => parseTimestamp('00:60:00'), SubtitleError);
});

test('parseTimestamp：秒越界(60)抛错', () => {
  assert.throws(() => parseTimestamp('00:00:60'), SubtitleError);
});

test('parseTimestamp：非字符串输入抛错', () => {
  assert.throws(() => /** @type {any} */ (parseTimestamp)(42), SubtitleError);
});

test('formatSrtTimestamp：进位与补零正确', () => {
  assert.equal(formatSrtTimestamp(3_661_500_000), '01:01:01,500');
});

test('formatSrtTimestamp：负值钳制为 0', () => {
  assert.equal(formatSrtTimestamp(-5), '00:00:00,000');
});

test('formatVttTimestamp：≥1h 显示小时位', () => {
  assert.equal(formatVttTimestamp(3_661_500_000), '01:01:01.500');
});

test('formatVttTimestamp：<1h 省略小时位', () => {
  assert.equal(formatVttTimestamp(65_000_000), '01:05.000');
});

test('formatAssTimestamp：厘秒域（0:00:01.20）', () => {
  assert.equal(formatAssTimestamp(1_200_000), '0:00:01.20');
});

test('roundtrip：VTT 格式化后再解析应相等（毫秒精度）', () => {
  const us = 12_345_000;
  assert.equal(parseTimestamp(formatVttTimestamp(us)), us);
});
