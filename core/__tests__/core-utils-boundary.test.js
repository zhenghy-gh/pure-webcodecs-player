/**
 * core-utils-boundary.test.js
 *
 * 针对 core 基础件的**时间、时钟与边界语义**补测
 * （PlaybackClock 基础行为见 clock-stats.test.js，此处补分支与事件面）：
 *  - PlaybackClock：运行中 play 不重锚（幂等）、未运行 pause no-op、seekTo 保持运行态、
 *    setRate 连续性（重锚不跳变）、play/pause/seek/rateChange 事件载荷
 *  - AvSyncController：无 attachMaster 时用内部钟（start 即播内部钟）、resync 会拉内部钟
 *  - Emitter：on 非函数拒绝、emit 无监听返回 false、listenerCount、定向 removeAllListeners、
 *    off 未注册监听器 no-op、once 可提前取消
 *  - Player._bufferTargetUs：直播用 liveLatencyUs / 点播用 bufferTargetUs / 非法水位归 0
 *  - WebCodecsPipeline._catchUpThresholdUs：显式配置 / liveLatency 一半下限 500ms / 默认 1.5s
 *
 * 全部用注入时钟/纯函数断言，零浏览器依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock, AvSyncController } from '../src/clock.js';
import { Emitter } from '../src/emitter.js';
import { Player } from '../src/player.js';
import { WebCodecsPipeline } from '../src/pipeline-webcodecs.js';

/** 手动步进的单调钟（秒） */
function manualClock(start = 0) {
  let t = start;
  return { now: () => t, step: (dt) => (t += dt), set: (v) => (t = v) };
}

/* ------------------------------ PlaybackClock 分支 ------------------------------ */

test('PlaybackClock：运行中 play() 幂等不重锚，未运行 pause() no-op 不派发事件', () => {
  const mono = manualClock(100);
  const clock = new PlaybackClock({ now: mono.now });
  const events = [];
  for (const e of ['play', 'pause', 'seek', 'rateChange']) {
    clock.on(e, (p) => events.push([e, p]));
  }

  clock.play(10);
  mono.step(1);
  clock.play(); // 已 running：不得重锚/重派 play
  assert.ok(Math.abs(clock.getTimeSec() - 11) < 1e-9, `运行中 play 应幂等（got ${clock.getTimeSec()}）`);

  clock.pause();
  clock.pause(); // 未 running：no-op
  mono.step(5);
  assert.equal(clock.getTimeSec(), 11, '重复 pause 不改变锚点');

  assert.deepEqual(events, [['seek', 10], ['play', undefined], ['pause', 11]],
    'play(sec) 先 seekTo 再派发 play；重复 pause no-op 不派发');
});

test('PlaybackClock：暂停态 seekTo 更新锚点且保持暂停；setRate 在任意时刻连续不跳变', () => {
  const mono = manualClock(0);
  const clock = new PlaybackClock({ now: mono.now });

  clock.play(0);
  mono.step(2);
  clock.pause(); // 冻结在 2
  clock.seekTo(50);
  assert.equal(clock.running, false, 'seekTo 不改变运行态');
  assert.equal(clock.getTimeSec(), 50);

  // 播放中 setRate：锚定当前值，时间连续
  clock.play(50);
  mono.step(1); // t=51, rate=1
  const before = clock.getTimeSec();
  clock.setRate(2);
  const after = clock.getTimeSec();
  assert.ok(Math.abs(before - after) < 1e-9, `setRate 不应跳变（${before} → ${after}）`);
  mono.step(1);
  assert.ok(Math.abs(clock.getTimeSec() - (after + 2)) < 1e-9, '新倍速从锚点起算');
  assert.equal(clock.rate, 2);
});

test('PlaybackClock：事件载荷完整（play 无参 / pause 携带冻结时刻 / seek / rateChange）', () => {
  const mono = manualClock(0);
  const clock = new PlaybackClock({ now: mono.now });
  const seen = [];
  for (const e of ['play', 'pause', 'seek', 'rateChange']) {
    clock.on(e, (p) => seen.push([e, p]));
  }
  clock.play(1);
  mono.step(1);
  clock.pause();       // 冻结在 2
  clock.seekTo(9);
  clock.setRate(0.5);
  assert.deepEqual(seen, [
    ['seek', 1],
    ['play', undefined],
    ['pause', 2],
    ['seek', 9],
    ['rateChange', 0.5],
  ]);
});

/* ------------------------------ AvSyncController 内部钟路径 ------------------------------ */

test('AvSyncController：无 attachMaster 时 start 即播内部钟，决策基于内部钟', () => {
  const sync = new AvSyncController();
  assert.equal(sync.masterClockFn, null);
  sync.start(10); // 内部钟 play(10)
  // 内部钟刚起播：drift ≈ 0 → render；超前远超 hardResyncSec → resync
  assert.equal(sync.suggestVideoAction(10.0).action, 'render');
  assert.equal(sync.suggestVideoAction(10.6).action, 'resync');
  // resync 把内部钟锚到 pts：锚点 + 极小流逝时间
  assert.ok(Math.abs(sync.clock.getTimeSec() - 10.6) < 0.01, 'resync 应重锚内部钟');
  assert.equal(sync.suggestVideoAction(10.6).action, 'render');
  sync.pause();
  assert.equal(sync.clock.running, false, 'pause 停内部钟');
});

/* ------------------------------ Emitter 边界 ------------------------------ */

test('Emitter：on 非函数拒绝、emit 无监听返回 false、off 未注册 no-op', () => {
  const bus = new Emitter();
  assert.throws(() => bus.on('x', 'not-a-fn'), TypeError);
  assert.throws(() => bus.on('x', null), TypeError);
  assert.equal(bus.emit('nobody', 1), false, '无监听器 emit 返回 false');
  assert.doesNotThrow(() => bus.off('nobody', () => {}), 'off 未注册事件 no-op');
  const fn = () => {};
  bus.on('x', fn);
  bus.off('x', fn);
  bus.off('x', fn); // 重复 off no-op
  assert.equal(bus.listenerCount('x'), 0);
});

test('Emitter：listenerCount 计数与定向 removeAllListeners 只清目标事件', () => {
  const bus = new Emitter();
  let a = 0, b = 0;
  bus.on('a', () => a++);
  bus.on('a', () => a++);
  bus.on('b', () => b++);
  assert.equal(bus.listenerCount('a'), 2);
  assert.equal(bus.listenerCount('b'), 1);
  bus.emit('a');
  bus.emit('b');
  assert.equal(a, 2);
  assert.equal(b, 1);
  bus.removeAllListeners('a');
  assert.equal(bus.listenerCount('a'), 0);
  bus.emit('a');
  bus.emit('b');
  assert.equal(a, 2, 'a 监听已清');
  assert.equal(b, 2, 'b 监听保留');
});

test('Emitter：once 可在触发前经返回的 off 取消', () => {
  const bus = new Emitter();
  let n = 0;
  const off = bus.once('go', () => n++);
  off();
  bus.emit('go');
  bus.emit('go');
  assert.equal(n, 0, '提前取消后 once 不触发');
});

/* ------------------------------ 水位/追赶阈值纯函数 ------------------------------ */

test('Player._bufferTargetUs：直播用 liveLatencyUs、点播用 bufferTargetUs、非法值归 0', () => {
  const p = new Player();
  p.mediaInfoValue = { live: false };
  assert.equal(p._bufferTargetUs(), 3000000, '点播默认 3s');

  p.mediaInfoValue = { live: true };
  assert.equal(p._bufferTargetUs(), 3000000, '直播未配 liveLatencyUs 回退 bufferTargetUs');
  p.options.liveLatencyUs = 8000000;
  assert.equal(p._bufferTargetUs(), 8000000, '直播优先 liveLatencyUs');

  p.options.bufferTargetUs = -5;
  p.mediaInfoValue = { live: false };
  assert.equal(p._bufferTargetUs(), 0, '非法水位归 0（跳过预缓冲）');
});

test('WebCodecsPipeline._catchUpThresholdUs：显式配置优先，否则 liveLatency 一半下限 500ms，默认 1.5s', () => {
  const make = (options) => new WebCodecsPipeline({
    route: 'webcodecs',
    mediaInfo: { container: 'mkv', tracks: [], durationUs: 0, seekable: true, live: false },
    player: null,
    options,
  });
  assert.equal(make({ catchUpThresholdUs: 123456 })._catchUpThresholdUs(), 123456, '显式配置优先');
  assert.equal(make({ liveLatencyUs: 1000000 })._catchUpThresholdUs(), 500000, 'liveLatency 一半');
  assert.equal(make({ liveLatencyUs: 400000 })._catchUpThresholdUs(), 500000, '下限 500ms');
  assert.equal(make({})._catchUpThresholdUs(), 1500000, '默认 base 3s 一半');
});
