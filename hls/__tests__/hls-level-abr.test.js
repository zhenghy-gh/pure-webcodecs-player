/**
 * LevelController ABR 决策单测（第二十五波）
 * 覆盖：初始档位、current getter、autoSelect 升降级与缓冲闸、switchTo(-1) 恢复 auto、
 * reportLoad 接线。stall 降档已由 level-stall.test.js 覆盖，此处不重复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelController } from '../src/level-controller.js';

/** 4 档（解析序任意，setLevels 会按带宽降序重排） */
const LEVELS = [
  { url: 'a.m3u8', bandwidth: 4000000 },
  { url: 'b.m3u8', bandwidth: 8000000 },
  { url: 'c.m3u8', bandwidth: 800000 },
  { url: 'd.m3u8', bandwidth: 2000000 },
];

/** 注入固定带宽估计的 mock 估计器 */
const estMock = (bw) => ({ bandwidth: bw, sample() {} });

test('setLevels 重排为带宽降序：index 0 恒为最高清', () => {
  const lc = new LevelController(LEVELS);
  assert.deepEqual(
    lc.levels.map((l) => l.bandwidth),
    [8000000, 4000000, 2000000, 800000]
  );
  assert.equal(lc.levelCount, 4);
});

test('初始档位取中间偏低档（floor(n*0.7)）；单档取 0；空表 -1', () => {
  assert.equal(new LevelController(LEVELS).currentLevel, 2, '4 档 → floor(2.8)=2');
  assert.equal(new LevelController(LEVELS.slice(0, 1)).currentLevel, 0, '1 档 → 0');
  const empty = new LevelController([]);
  assert.equal(empty.currentLevel, -1);
  assert.equal(empty.current, null, '空表 current 为 null');
});

test('current getter：startLevel=-1 时回落到最高清档', () => {
  const lc = new LevelController(LEVELS, { startLevel: -1 });
  assert.equal(lc.currentLevel, -1);
  assert.equal(lc.current.bandwidth, 8000000, '-1 语义为 auto 未定，回落 levels[0]');
});

test('autoSelect：带宽足够但缓冲 <10s 不升级；缓冲充足立即升级', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(12e6) });
  lc.currentLevel = 2;
  lc.bufferSeconds = 5;
  assert.equal(lc.autoSelect(), null, '升级被缓冲闸拦截');
  lc.bufferSeconds = 12;
  assert.deepEqual(lc.autoSelect(), { from: 2, to: 0 }, '缓冲 ≥10s 升到最高清');
});

test('autoSelect：降级不受缓冲闸限制（饥饿优先止损）', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(1e6) });
  lc.currentLevel = 2; // c 档需 2.8e6，估计 1e6 承载不了
  lc.bufferSeconds = 0;
  // 1e6 不足以任何档 *1.4；回落取 bandwidth ≤ 1e6 的最低档 800000（index 3）
  assert.deepEqual(lc.autoSelect(), { from: 2, to: 3 });
});

test('autoSelect：估计带宽恰在两档之间时取可承载的最高档', () => {
  // 降序后 levels = [8e6, 4e6, 2e6, 8e5]。bw=3e6：2e6*1.4=2.8e6 ✓、4e6*1.4=5.6e6 ✗
  // → 首个满足者即 index 2（2e6 档），从最低档应升到它
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(3e6) });
  lc.currentLevel = 3;
  lc.bufferSeconds = 15;
  assert.deepEqual(lc.autoSelect(), { from: 3, to: 2 });
  // 已在该档时重复复核返回 null（无动作）
  assert.equal(lc.autoSelect(), null);
});

test('autoSelect：手动模式非 force 返回 null，force 仍生效', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(12e6) });
  lc.switchTo(1);
  lc.bufferSeconds = 20;
  assert.equal(lc.autoSelect(), null, '手动锁定不自动切');
  const sw = lc.autoSelect(true);
  assert.deepEqual(sw, { from: 1, to: 0 }, 'force 绕过手动锁定');
});

test('switchTo(-1)：恢复 auto 并立即按当前估计复核一次', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(12e6) });
  lc.switchTo(0); // 手动最高清
  lc.bufferSeconds = 20;
  const sw = lc.switchTo(-1);
  assert.equal(lc.autoLevelEnabled, true);
  assert.equal(sw, null, '已在最高清档，复核无切换动作返回 null');
});

test('switchTo(-1) 后估计带宽不支持当前档 → 立即降档', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(1e6) });
  lc.switchTo(0);
  lc.lastSwitchTime = 0;
  const sw = lc.switchTo(-1);
  assert.deepEqual(sw, { from: 0, to: 3 }, '恢复 auto 即刻降到可承载最低档');
});

test('reportLoad：样本回填 + bufferSeconds 回写 + 触发 onMaybeSwitch', () => {
  const samples = [];
  const lc = new LevelController(LEVELS, {
    bandwidthEstimator: {
      bandwidth: 12e6,
      sample: (b, ms) => samples.push([b, ms]),
    },
  });
  lc.currentLevel = 2;
  lc.bufferSeconds = 0;
  const switches = [];
  lc.reportLoad(625000, 1000, 15, (sw) => switches.push(sw));
  assert.deepEqual(samples[0], [625000, 1000]);
  assert.equal(lc.bufferSeconds, 15);
  assert.deepEqual(switches, [{ from: 2, to: 0 }], '带宽缓冲俱备应触发升级回调');
});

test('reportLoad：手动模式下不触发 onMaybeSwitch', () => {
  const lc = new LevelController(LEVELS, { bandwidthEstimator: estMock(12e6) });
  lc.switchTo(1);
  const switches = [];
  lc.reportLoad(625000, 1000, 20, (sw) => switches.push(sw));
  assert.equal(switches.length, 0);
});
