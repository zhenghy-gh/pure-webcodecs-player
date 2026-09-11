/**
 * subtitle/__tests__/subtitle-timeedge2.test.js — 时间码解析补充边界（time.js）
 *
 * 补充 time.test.js / subtitle-timeedge.test.js 未覆盖的输入：
 *   - 恰好 24h（不钳制，合法）
 *   - 逗号 2 位（厘秒语义）→ 120ms
 *   - 纯空白输入 → 抛 PARSE_ERROR
 *   - 负小时 '-1:00:00' → 抛 PARSE_ERROR
 *   - 边界 999ms
 *   - 3 位小时但缺分钟冒号 '123:45' → 抛 PARSE_ERROR
 *   - 毫秒前带空格 '00:00:01 ,000' → 抛 PARSE_ERROR
 *   - >24h 往返一致性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestamp, formatSrtTimestamp } from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('parseTimestamp：恰好 24h 合法（不钳制）', () => {
  assert.equal(parseTimestamp('24:00:00'), 24 * 3600 * 1_000_000);
});

test('parseTimestamp：逗号 2 位按厘秒 → 120ms', () => {
  assert.equal(parseTimestamp('1:02:03,12'), 3_723_120_000);
});

test('parseTimestamp：纯空白输入 → 抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp('   '), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
  assert.throws(() => parseTimestamp('\t\n  '), (e) => e.code === 'PARSE_ERROR');
});

test("parseTimestamp：负小时 '-1:00:00' → 抛 PARSE_ERROR", () => {
  assert.throws(() => parseTimestamp('-1:00:00'), (e) => e.code === 'PARSE_ERROR');
});

test('parseTimestamp：边界 999ms', () => {
  assert.equal(parseTimestamp('00:00:00,999'), 999_000);
});

test("parseTimestamp：3 位小时但缺分钟冒号 '123:45' → 抛 PARSE_ERROR", () => {
  assert.throws(() => parseTimestamp('123:45'), (e) => e.code === 'PARSE_ERROR');
});

test("parseTimestamp：毫秒前带空格 '00:00:01 ,000' → 抛 PARSE_ERROR", () => {
  assert.throws(() => parseTimestamp('00:00:01 ,000'), (e) => e.code === 'PARSE_ERROR');
});

test('parseTimestamp：>24h（36:00:00）合法', () => {
  assert.equal(parseTimestamp('36:00:00'), 36 * 3600 * 1_000_000);
});

test('roundtrip SRT：>24h（86_400_000_000）parse∘format 恒等', () => {
  const us = 86_400_000_000;
  assert.equal(parseTimestamp(formatSrtTimestamp(us)), us);
});

test('formatSrtTimestamp：36h 仍以三位小时输出', () => {
  assert.equal(formatSrtTimestamp(36 * 3600 * 1_000_000), '36:00:00,000');
});
