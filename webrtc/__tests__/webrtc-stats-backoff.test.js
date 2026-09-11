/**
 * webrtc 补充单测：stats.js + computeBackoffMs 边界
 *  - computeBackoffMs：负数 attempt（Math.max(0, attempt)→0）、baseMs=0 触发下限 50、
 *    自定义 rand 注入、jitterRatio=0 即无抖动、cap=0 永远封顶为 50
 *  - extractMetrics：dtSec < 0.05 不计 kbps、prev 有 video bytes 但当前 report 无 video、
 *    packetsLost 倒退仍取 Math.max(0, …)、mediaType（无 kind）回退路径、
 *    empty report → 全 null 但 timestamp 必填、nominated 未 succeeded 不入 rttMs
 *  - StatsCollector：start() 后多次采样、自定义 interval、stop() 未启动不抛、
 *    getStats 抛错时仍按 interval 续采而不中断、pc.connectionState=closed 停止下一轮
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetrics, StatsCollector } from '../src/stats.js';
import { computeBackoffMs } from '../src/player.js';

/* ---------------- computeBackoffMs 边界 ---------------- */

test('computeBackoffMs：负数 attempt 等同 attempt=0（Math.max(0, n)）', () => {
  assert.equal(computeBackoffMs(-1, { baseMs: 1000, capMs: 15000, jitterRatio: 0 }), 1000);
  assert.equal(computeBackoffMs(-100, { baseMs: 1000, capMs: 15000, jitterRatio: 0 }), 1000);
});

test('computeBackoffMs：baseMs=0 触发 Math.max(50, …) 下限保护', () => {
  assert.equal(computeBackoffMs(0, { baseMs: 0, capMs: 15000, jitterRatio: 0 }), 50);
  assert.equal(computeBackoffMs(5, { baseMs: 0, capMs: 15000, jitterRatio: 0 }), 50);
});

test('computeBackoffMs：capMs=0 时任何 attempt 都封顶到 50', () => {
  // raw = 0 * 2^n = 0；封顶 0 后再走 Math.max(50, 0) = 50
  for (let n = 0; n < 8; n++) {
    assert.equal(computeBackoffMs(n, { baseMs: 0, capMs: 0, jitterRatio: 0 }), 50);
  }
});

test('computeBackoffMs：注入 rand 可精确控制抖动量', () => {
  // rand=1 → jitter = raw * ratio * (2-1) = raw*ratio → +ratio 比例
  const up = computeBackoffMs(2, { baseMs: 1000, capMs: 15000, jitterRatio: 0.25, rand: () => 1 });
  // raw=4000, +25%=1000, total=5000, 在 cap 内
  assert.equal(up, 5000);
  // rand=0 → jitter = raw * ratio * (-1) → -ratio 比例
  const dn = computeBackoffMs(2, { baseMs: 1000, capMs: 15000, jitterRatio: 0.25, rand: () => 0 });
  assert.equal(dn, 3000);
});

test('computeBackoffMs：jitterRatio=0 时结果完全确定性（无抖动）', () => {
  const opts = { baseMs: 500, capMs: 8000, jitterRatio: 0 };
  for (let i = 0; i < 5; i++) {
    const v1 = computeBackoffMs(i, opts);
    const v2 = computeBackoffMs(i, opts);
    assert.equal(v1, v2);
  }
});

/* ---------------- extractMetrics 边界 ---------------- */

test('extractMetrics：dtSec < 0.05 时不计算 kbps（间隔过短）', () => {
  let t = 1000;
  const clock = () => (t += 30); // 30ms 一次
  const m1 = extractMetrics([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 100000 }], {}, clock);
  const m2 = extractMetrics([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 150000 }], m1.nextPrev, clock);
  // dt=30ms < 50ms → kbps 不计算
  assert.equal(m2.video.kbps, null);
});

test('extractMetrics：prev 有 video bytes，但当前 report 缺 video 不抛错', () => {
  let t = 0;
  const clock = () => (t += 1000);
  const m1 = extractMetrics(
    [{ type: 'inbound-rtp', kind: 'video', bytesReceived: 100000 }],
    {},
    clock
  );
  // 第二次：report 缺 video 媒体
  const m2 = extractMetrics(
    [{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.04 }],
    m1.nextPrev,
    clock
  );
  assert.equal(m2.video.kbps, null, '无 video 数据时 kbps 保持 null');
  assert.equal(m2.rttMs, 40);
});

test('extractMetrics：packetsLost 倒退仍取当前值（Math.max(0, …)）', () => {
  const m = extractMetrics(
    [
      { type: 'inbound-rtp', kind: 'video', packetsLost: 10 },
      { type: 'inbound-rtp', kind: 'audio', packetsLost: 5 },
    ],
    {}
  );
  assert.equal(m.video.packetsLost, 10);
  assert.equal(m.audio.packetsLost, 5);

  // packetsLost 倒退：从 10 回到 3（Math.max(0, 3) 但仍取当前帧的最新值）
  const m2 = extractMetrics(
    [{ type: 'inbound-rtp', kind: 'video', packetsLost: 3 }],
    {}
  );
  assert.equal(m2.video.packetsLost, 3);
});

test('extractMetrics：仅 mediaType 缺 kind 时仍能写入 video/audio 桶', () => {
  // 部分浏览器只给 mediaType 不给 kind（兼容旧版 Chrome 写法）
  const m = extractMetrics([
    { type: 'inbound-rtp', mediaType: 'video', bytesReceived: 1000, jitter: 0.01, packetsLost: 1 },
    { type: 'inbound-rtp', mediaType: 'audio', bytesReceived: 500, packetsLost: 0 },
  ], {});
  assert.equal(m.video.packetsLost, 1);
  assert.equal(m.video.jitterMs, 10);
  assert.equal(m.audio.packetsLost, 0);
});

test('extractMetrics：report 为空数组 → 输出结构完整且 timestamp 存在', () => {
  let now = 12345;
  const m = extractMetrics([], {}, () => now);
  assert.equal(m.timestamp, 12345);
  assert.equal(m.rttMs, null);
  assert.equal(m.video.kbps, null);
  assert.equal(m.video.packetsLost, 0);
  assert.equal(m.audio.kbps, null);
  assert.equal(m.latencyEstimateMs, null);
});

test('extractMetrics：report 为空 Map.entries() 形态', () => {
  // entries() 返回空迭代器
  const empty = { entries: () => new Map().entries() };
  const m = extractMetrics(empty);
  assert.equal(m.rttMs, null);
  assert.equal(m.video.kbps, null);
});

test('extractMetrics：remote-outbound-rtp 多次出现时取最后一个有效值', () => {
  let now = 10_000_000;
  const clock = () => now;
  const m = extractMetrics([
    { type: 'remote-outbound-rtp', remoteTimestamp: new Date(now - 100).toISOString() },
    { type: 'remote-outbound-rtp', remoteTimestamp: new Date(now - 250).toISOString() },
  ], {}, clock);
  assert.equal(m.latencyEstimateMs, 250, '取最后一次有效时间戳');
});

test('extractMetrics：candidate-pair nominated 但 state=in-progress 不计入 rttMs', () => {
  const m = extractMetrics([
    { type: 'candidate-pair', nominated: true, state: 'in-progress', currentRoundTripTime: 0.5 },
    { type: 'candidate-pair', nominated: true, state: 'failed', currentRoundTripTime: 0.9 },
  ], {});
  assert.equal(m.rttMs, null, '非 succeeded 不入 rttMs');
});

test('extractMetrics：candidate-pair selected 优先于 nominated', () => {
  // selected 但 currentRoundTripTime 缺失 → 不覆盖已存在的 nominated+succeeded 值
  const m = extractMetrics([
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.08 },
    { type: 'candidate-pair', selected: true, state: 'succeeded' }, // 无 currentRoundTripTime
  ], {});
  assert.equal(m.rttMs, 80, 'selected 缺 currentRoundTripTime 时不覆盖');
});

test('extractMetrics：framesDecoded 缺省时通过 prev 通道保留（WebRTC 规范：单调递增）', () => {
  let t = 0;
  const clock = () => (t += 1000);
  const m1 = extractMetrics(
    [{ type: 'inbound-rtp', kind: 'video', framesDecoded: 100 }],
    {},
    clock
  );
  assert.equal(m1.video.framesDecoded, 100);
  // 第二次 framesDecoded 缺省，但 prev 携带 → 应保留为 100（不再误归零）
  const m2 = extractMetrics(
    [{ type: 'inbound-rtp', kind: 'video' }],
    m1.nextPrev,
    clock
  );
  assert.equal(m2.video.framesDecoded, 100, 'framesDecoded 缺省时通过 prev 保留前值（修复后）');
});

test('extractMetrics：prev 完全不带 framesDecoded 字段 → 退回 bucket 默认 0', () => {
  // prev 来自老调用方（升级前/外部传入）没有 framesDecoded 字段时降级为 0
  const m = extractMetrics(
    [{ type: 'inbound-rtp', kind: 'video' }],
    { bytesVideo: 1, ts: 0 },
    () => 1000
  );
  assert.equal(m.video.framesDecoded, 0);
  assert.equal(m.video.framesDropped, 0);
});

/* ---------------- StatsCollector 行为 ---------------- */

test('StatsCollector：start() 后多次采样、stop() 后不再触发', async () => {
  let calls = 0;
  const pc = {
    connectionState: 'connected',
    async getStats() {
      calls += 1;
      return [{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }];
    },
  };
  const collector = new StatsCollector(pc, 10);
  const samples = [];
  collector.start((m) => samples.push(m));
  await new Promise((r) => setTimeout(r, 60));
  collector.stop();
  const beforeStopCount = calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, beforeStopCount, 'stop 后不再调用 getStats');
  assert.ok(samples.length >= 3, `应至少采到 3 轮样本，实际 ${samples.length}`);
  assert.equal(samples[0].rttMs, 10);
});

test('StatsCollector：stop() 在未 start() 时调用不抛', () => {
  const collector = new StatsCollector({ connectionState: 'connected', async getStats() { return []; } });
  assert.doesNotThrow(() => collector.stop());
});

test('StatsCollector：getStats 抛错时不中断，按 interval 继续下一轮', async () => {
  let n = 0;
  const pc = {
    connectionState: 'connected',
    async getStats() {
      n += 1;
      if (n === 2) throw new Error('transient');
      return [{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02 }];
    },
  };
  const collector = new StatsCollector(pc, 10);
  const samples = [];
  collector.start((m) => samples.push(m));
  await new Promise((r) => setTimeout(r, 60));
  collector.stop();
  // 第 1、3、4 轮成功；第 2 轮被吞 → 至少 2 个样本
  assert.ok(samples.length >= 2, `应至少采到 2 个样本（跳过抛错轮），实际 ${samples.length}`);
  assert.equal(samples[0].rttMs, 20);
});

test('StatsCollector：pc.connectionState=closed 时下一轮不再调用 getStats', async () => {
  let calls = 0;
  const pc = {
    connectionState: 'new',
    async getStats() {
      calls += 1;
      return [{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }];
    },
  };
  const collector = new StatsCollector(pc, 5);
  const samples = [];
  collector.start((m) => samples.push(m));
  await new Promise((r) => setTimeout(r, 10));
  // 把连接态置 closed
  pc.connectionState = 'closed';
  const before = calls;
  await new Promise((r) => setTimeout(r, 30));
  // 之后不应再调用 getStats
  assert.equal(calls, before, 'closed 后采集停摆');
  collector.stop();
});

test('StatsCollector：注入 interval 后实际周期近似配置值', async () => {
  const pc = {
    connectionState: 'connected',
    async getStats() { return []; },
  };
  const collector = new StatsCollector(pc, 25);
  let n = 0;
  collector.start(() => { n += 1; });
  await new Promise((r) => setTimeout(r, 100));
  collector.stop();
  // 100ms / 25ms ≈ 4，加首采样 + 误差：3~6 都算正常
  assert.ok(n >= 3 && n <= 6, `预期 3~6 轮，实际 ${n}`);
});
