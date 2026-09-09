/**
 * 第一轮评审 §18.3 回归：stall（播放饥饿）快速降档。
 * 旧实现 level-controller 头部注释承诺「缓冲<2s 立即降档」但 autoSelect 降级完全
 * 依赖带宽 EWMA 回落，bufferSeconds 仅作升级闸——注释与实现不符。验证 handleStall
 * 绕过带宽估计直切最低档，且手动档 / 节流 / 无档位等边界不误降。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelController } from '../src/level-controller.js';
import { HlsPlayer } from '../src/player.js';

/** 4 档（降序）→ _pickInitial = min(3, floor(4*0.7)=2) = 2 */
function makeLevels() {
  return [
    { url: 'l0.m3u8', bandwidth: 8000000 },
    { url: 'l1.m3u8', bandwidth: 4000000 },
    { url: 'l2.m3u8', bandwidth: 2000000 },
    { url: 'l3.m3u8', bandwidth: 800000 },
  ];
}

test('handleStall 从中间档直切最低档（绕过带宽估计）', () => {
  const lc = new LevelController(makeLevels());
  assert.equal(lc.currentLevel, 2);
  // 带宽估计为 0 也不影响：stall 降档不依赖 EWMA
  const sw = lc.handleStall();
  assert.deepEqual(sw, { from: 2, to: 3 });
  assert.equal(lc.currentLevel, 3);
  assert.equal(lc.autoLevelEnabled, true);
});

test('已在最低档时 handleStall 返回 null（无动作）', () => {
  const lc = new LevelController(makeLevels());
  lc.currentLevel = 3;
  lc.lastSwitchTime = 0;
  assert.equal(lc.handleStall(), null);
});

test('手动锁定档位不被 stall 覆盖', () => {
  const lc = new LevelController(makeLevels());
  lc.switchTo(0); // 手动锁最高清，autoLevelEnabled=false
  assert.equal(lc.autoLevelEnabled, false);
  assert.equal(lc.handleStall(), null);
  assert.equal(lc.currentLevel, 0);
});

test('节流：距上次切换 <2s 不连环降档；超时后恢复', () => {
  const lc = new LevelController(makeLevels());
  assert.deepEqual(lc.handleStall(), { from: 2, to: 3 }); // 成功，写入 lastSwitchTime
  assert.equal(lc.handleStall(), null); // 节流拦截
  lc.currentLevel = 1; // 人为模拟爬到 l1
  lc.lastSwitchTime = Date.now() - 5000; // 超过 minGap
  assert.deepEqual(lc.handleStall(), { from: 1, to: 3 }); // 重新允许直切最低档
});

test('无 levels 时 handleStall 返回 null', () => {
  const lc = new LevelController([]);
  assert.equal(lc.handleStall(), null);
});

test('handleStall 不改变 auto 模式开关（带宽恢复后仍可爬回高档）', () => {
  const lc = new LevelController(makeLevels(), {
    bandwidthEstimator: { bandwidth: 12e6, sample() {} }, // 足够承载最高档
  });
  lc.handleStall();
  assert.equal(lc.autoLevelEnabled, true);
  // 后续 reportLoad ABR 复核（force 以跳过缓冲闸）应能从最低档爬回最高清
  const sw = lc.autoSelect(true);
  assert.deepEqual(sw, { from: 3, to: 0 });
});

test('HlsPlayer 接线守卫：_onVideoWaiting 已绑定，无 video 时静默返回', () => {
  const p = new HlsPlayer();
  assert.equal(typeof p._onVideoWaiting, 'function');
  // mse.video 为 null → 前置闸直接返回，不抛
  assert.doesNotThrow(() => p._maybeStallDowngrade());
  p.destroy();
});
