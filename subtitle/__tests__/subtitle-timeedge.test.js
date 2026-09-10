/**
 * subtitle/__tests__/subtitle-timeedge.test.js — 时间码解析/格式化边界与往返
 *
 * 聚焦 time.js 在 src 现有测试中尚未充分覆盖的分支：
 *   - 三位小时、厘秒两位小数、小数位右补零变体
 *   - 越界边界（59 为合法、60 抛错）
 *   - 三种格式序列化后再解析的往返一致性（含精度损失已知行为）
 *   - 大时长（>1h、>100h）格式化补零
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestamp, formatSrtTimestamp, formatVttTimestamp, formatAssTimestamp,
} from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('parseTimestamp：三位小时位（100:00:00,000）', () => {
  assert.equal(parseTimestamp('100:00:00,000'), 360_000_000_000);
});

test('parseTimestamp：厘秒两位小数（1:02:03.12 → 3723.12s）', () => {
  assert.equal(parseTimestamp('1:02:03.12'), 3_723_120_000);
});

test('parseTimestamp：小数位右补零变体 .25/.2', () => {
  assert.equal(parseTimestamp('00:00:00.25'), 250_000);
  assert.equal(parseTimestamp('00:00:00.2'), 200_000);
  assert.equal(parseTimestamp('00:00:00'), 0);
});

test('parseTimestamp：小数域超 3 位截断为毫秒（1234→123ms）', () => {
  // 1s + 123ms = 1_123_000µs（旧的 padEnd 不截断会算出 2_234_000µs）
  assert.equal(parseTimestamp('00:00:01,1234'), 1_123_000);
  assert.equal(parseTimestamp('00:00:00.123456'), 123_000);
});

test('parseTimestamp：尾点无小数视为非法（严格解析抛 PARSE_ERROR）', () => {
  assert.throws(() => parseTimestamp('00:00:00.'), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('parseTimestamp：单字符小数 .5 → 500ms', () => {
  assert.equal(parseTimestamp('00:00:00.5'), 500_000);
});

test('parseTimestamp：分钟/秒边界 59 合法、60 抛 PARSE_ERROR', () => {
  assert.equal(parseTimestamp('00:59:59,999'), 59 * 60_000_000 + 59 * 1_000_000 + 999_000);
  assert.throws(() => parseTimestamp('00:60:00'), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
  assert.throws(() => parseTimestamp('00:00:60'), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('parseTimestamp：非字符串输入抛 PARSE_ERROR', () => {
  assert.throws(() => /** @type {any} */ (parseTimestamp)(123), (e) => e.code === 'PARSE_ERROR');
  assert.throws(() => /** @type {any} */ (parseTimestamp)(undefined), (e) => e.code === 'PARSE_ERROR');
});

test('formatSrtTimestamp：>100h 仍以三位小时输出', () => {
  assert.equal(formatSrtTimestamp(360_000_000_000), '100:00:00,000');
});

test('formatSrtTimestamp：负值毫秒域钳制为 0', () => {
  assert.equal(formatSrtTimestamp(-1), '00:00:00,000');
  assert.equal(formatSrtTimestamp(-5), '00:00:00,000');
});

test('roundtrip SRT：毫秒粒度内 parse∘format 恒等', () => {
  for (const us of [0, 1_500_000, 9_999_000, 65_000_000, 3_661_500_000, 360_000_000_000]) {
    assert.equal(parseTimestamp(formatSrtTimestamp(us)), us, `us=${us}`);
  }
});

test('roundtrip VTT：毫秒粒度内 parse∘format 恒等', () => {
  for (const us of [0, 12_345_000, 65_000_000, 1_234_500_000]) {
    assert.equal(parseTimestamp(formatVttTimestamp(us)), us, `us=${us}`);
  }
});

test('roundtrip ASS：厘秒对齐（10000us 倍数）parse∘format 恒等', () => {
  for (const us of [0, 1_200_000, 3_600_000, 720_000_000]) {
    const back = parseTimestamp(formatAssTimestamp(us));
    assert.equal(back, us, `us=${us} -> ${formatAssTimestamp(us)} -> ${back}`);
  }
});

test('formatAssTimestamp：非厘秒对齐时四舍五入（已知精度损失）', () => {
  const s = formatAssTimestamp(1_234_000); // 123.4cs → 123cs
  assert.equal(s, '0:00:01.23');
  assert.notEqual(parseTimestamp(s), 1_234_000, '亚厘秒精度会丢失');
});

test('formatAssTimestamp：零值与缺省样式', () => {
  assert.equal(formatAssTimestamp(0), '0:00:00.00');
  assert.equal(formatAssTimestamp(1_200_000), '0:00:01.20');
});
