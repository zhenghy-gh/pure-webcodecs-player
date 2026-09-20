import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock, AvSyncController, DEFAULT_SYNC_OPTIONS } from '../src/clock.js';
import { Stats } from '../src/stats.js';

/** 手动步进的单调钟（秒） */
function manualClock(start = 0) {
  let t = start;
  return { now: () => t, step: (dt) => (t += dt), set: (v) => (t = v) };
}

test('PlaybackClock 播放/暂停/seek/倍速', () => {
  const mono = manualClock(1000);
  const clock = new PlaybackClock({ now: mono.now });
  assert.equal(clock.getTimeSec(), 0);

  clock.play(10);
  mono.step(1);
  assert.ok(Math.abs(clock.getTimeSec() - 11) < 1e-9);

  clock.setRate(2);
  mono.step(1);
  assert.ok(Math.abs(clock.getTimeSec() - 13) < 1e-9, `got ${clock.getTimeSec()}`);

  clock.pause();
  const frozen = clock.getTimeSec();
  mono.step(5);
  assert.equal(clock.getTimeSec(), frozen, '暂停后时间冻结');

  clock.seekTo(50);
  assert.equal(clock.getTimeSec(), 50);
});

test('PlaybackClock 非法倍速抛错', () => {
  const clock = new PlaybackClock({ now: manualClock().now });
  assert.throws(() => clock.setRate(0), RangeError);
  assert.throws(() => clock.setRate(-1), RangeError);
});

test('DEFAULT_SYNC_OPTIONS 对齐 CONTRACTS §7 ±20ms 窗口', () => {
  // 契约硬约束：视频 PTS 对齐 ±20ms 窗口（早到等待、迟到丢帧）。
  assert.equal(DEFAULT_SYNC_OPTIONS.maxLateSec, 0.02, 'maxLateSec 应为 20ms');
  assert.equal(DEFAULT_SYNC_OPTIONS.maxEarlySec, 0.02, 'maxEarlySec 应为 20ms');
  assert.ok(DEFAULT_SYNC_OPTIONS.hardResyncSec >= 0.02, 'hardResyncSec 须 > 同步窗口');
  assert.equal(
    DEFAULT_SYNC_OPTIONS.maxLateSec,
    DEFAULT_SYNC_OPTIONS.maxEarlySec,
    '早到/迟到窗口应对称对齐 ±20ms'
  );
});

test('AvSyncController 决策矩阵', () => {
  let masterTime = 1.0; // 模拟音频主钟（AudioWorklet 已播秒数）
  const sync = new AvSyncController({
    maxLateSec: 0.12,
    maxEarlySec: 0.048,
    hardResyncSec: 0.5,
  });
  sync.attachMaster(() => masterTime);
  assert.equal(sync.masterTimeSec(), 1);

  // 视频 pts=0.95 → 落后 50ms → 正常渲染
  assert.equal(sync.suggestVideoAction(0.95).action, 'render');
  // pts=0.80 → 落后 200ms → drop
  assert.equal(sync.suggestVideoAction(0.8).action, 'drop');
  // pts=1.02 → 超前 20ms → render
  assert.equal(sync.suggestVideoAction(1.02).action, 'render');
  // pts=1.06 → 超前 60ms → wait
  assert.equal(sync.suggestVideoAction(1.06).action, 'wait');

  // 硬重同步：偏差 ≥0.5s → resync 且内部时钟被拉到该 pts
  let resynced = null;
  sync.on('resync', (e) => (resynced = e));
  assert.equal(sync.suggestVideoAction(1.7).action, 'resync');
  assert.ok(resynced && Math.abs(resynced.drift - 0.7) < 1e-9);
});

test('Stats 计数与 fps EMA（注入时钟）', () => {
  const mono = manualClock(0);
  const stats = new Stats({ now: mono.now });
  stats.markAppended(1024);
  stats.markSampleDecoded(2);
  stats.markVideoRendered(); // t=0，首帧不产生 fps
  mono.step(0.05); // 20fps
  stats.markVideoRendered();
  mono.step(0.05);
  stats.markVideoRendered();

  stats.markVideoDropped(3);
  stats.markAudioUnderrun();
  stats.markSeek();

  const snap = stats.snapshot();
  assert.equal(snap.bytesAppended, 1024);
  assert.equal(snap.samplesDecoded, 1);
  assert.equal(snap.averageDecodeMs, 2);
  assert.equal(snap.videoFramesDropped, 3);
  assert.equal(snap.audioUnderruns, 1);
  assert.equal(snap.fps, 20, `fps=${snap.fps}`);
  stats.reset();
  assert.equal(stats.snapshot().bytesAppended, 0);
});

test('Stats：demux 计数、decodeError 事件与 Date.now 时钟回退', async () => {
  const detail = { code: 'DECODE_ERROR', track: 'video' };
  const seen = [];
  const realDateNow = Date.now;
  await withGlobal('performance', undefined, () => {
    Date.now = () => 1234;
    try {
      const stats = new Stats();
      assert.equal(stats._now(), 1.234, '无 performance 时应回退 Date.now');
      stats.on('decodeError', (value) => seen.push(value));
      stats.markDemuxed(4096);
      stats.markDecodeError(detail);
      assert.equal(stats.snapshot().bytesDemuxed, 4096);
      assert.deepEqual(seen, [detail]);
      assert.equal(stats.snapshot().decodeErrors, 1);
    } finally {
      Date.now = realDateNow;
    }
  });
  await withGlobal('performance', { now: () => 2000 }, () => {
    const stats = new Stats();
    assert.equal(stats._now(), 2, 'performance.now 应按秒换算');
  });
});

async function withGlobal(key, value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
