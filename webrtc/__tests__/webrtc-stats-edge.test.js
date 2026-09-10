/**
 * webrtc 补充单测：stats.js 边界覆盖
 *  - extractMetrics：无 inbound-rtp（全 null）、未 succeeded 的 candidate-pair（rttMs=null）
 *  - candidate-pair 选择：nominated/succeeded 取首个、selected 覆盖、selected 优先
 *  - jitter 缓冲除零：jitterBufferEmittedCount=0 跳过（bufferDelayMs 保持 null）
 *  - remote-outbound-rtp 精度：注入时钟精确估计、未来时间戳截断为 0、非法时间戳忽略
 *  - 未知 kind 的 inbound-rtp 不抛错
 * 全部纯函数 + 注入时钟，零浏览器依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetrics } from '../src/stats.js';

const fakeReport = (entries) => entries;

test('extractMetrics：无 inbound-rtp 时 video/audio 保持默认、rttMs 依赖候选', () => {
  const m = extractMetrics(fakeReport([
    { type: 'candidate-pair', nominated: true, state: 'in-progress', currentRoundTripTime: 0.09 },
  ]), {});
  assert.equal(m.video.kbps, null);
  assert.equal(m.video.packetsLost, 0);
  assert.equal(m.video.bufferDelayMs, null);
  assert.equal(m.audio.kbps, null);
  assert.equal(m.rttMs, null, '候选未 succeeded，不取 RTT');
  assert.equal(m.latencyEstimateMs, null);
});

test('extractMetrics：candidate-pair 选择 —— 同 nominated 取首个', () => {
  const m = extractMetrics(fakeReport([
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05 },
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.07 },
  ]), {});
  assert.equal(m.rttMs, 50, '首个 nominated+succeeded 生效，非 selected 不覆盖');
});

test('extractMetrics：candidate-pair 选择 —— selected 覆盖 nominated', () => {
  const m = extractMetrics(fakeReport([
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05 },
    { type: 'candidate-pair', selected: true, state: 'succeeded', currentRoundTripTime: 0.03 },
  ]), {});
  assert.equal(m.rttMs, 30, 'selected 配对覆盖前一个');
});

test('extractMetrics：jitter 缓冲除零 —— emittedCount=0 时不计算', () => {
  const m = extractMetrics(fakeReport([
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 100, jitterBufferDelay: 0.5, jitterBufferEmittedCount: 0 },
  ]), {});
  assert.equal(m.video.bufferDelayMs, null, 'emittedCount=0 触发除零保护，跳过');
});

test('extractMetrics：remote-outbound-rtp 精度（注入时钟）', () => {
  let now = 5_000_000;
  const clock = () => now;
  const sentAt = new Date(now - 250).toISOString();
  const m = extractMetrics(fakeReport([
    { type: 'remote-outbound-rtp', remoteTimestamp: sentAt },
  ]), {}, clock);
  assert.equal(m.latencyEstimateMs, 250, 'now - remoteTimestamp = 250ms');
});

test('extractMetrics：remote-outbound-rtp 未来时间戳截断为 0、非法时间戳忽略', () => {
  let now = 5_000_000;
  const clock = () => now;
  // 未来时间戳：now - sentAt < 0 → Math.max(0, …) = 0
  const future = extractMetrics(fakeReport([
    { type: 'remote-outbound-rtp', remoteTimestamp: new Date(now + 100).toISOString() },
  ]), {}, clock);
  assert.equal(future.latencyEstimateMs, 0);

  // 非法时间戳：Date.parse 失败 → 不更新估计
  const bad = extractMetrics(fakeReport([
    { type: 'remote-outbound-rtp', remoteTimestamp: 'not-a-timestamp' },
  ]), {}, clock);
  assert.equal(bad.latencyEstimateMs, null);
});

test('extractMetrics：未识别 kind 的 inbound-rtp 不抛错且不影响其他指标', () => {
  const m = extractMetrics(fakeReport([
    { type: 'inbound-rtp', kind: 'application', bytesReceived: 999, framesDecoded: 5 },
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02 },
  ]), {});
  assert.equal(m.video.kbps, null, 'application 不属于 video/audio，被忽略');
  assert.equal(m.rttMs, 20, 'candidate-pair 仍正常提取');
});
