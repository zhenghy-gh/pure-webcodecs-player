/**
 * 第一轮评审 §15.3 回归：长直播 / EVENT 后退缓冲周期回收。
 * 验证 MseController.trim 仅移除播放点前后完全脱钩的整段历史缓冲，保留部分重叠区间。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MseController } from '../src/mse-controller.js';

/** 假的 TimeRanges */
function fakeRanges(ranges) {
  return {
    length: ranges.length,
    start: (i) => ranges[i][0],
    end: (i) => ranges[i][1],
  };
}

/** 假的 SourceBuffer：remove 同步触发 updateend 使队列 promise 落定 */
function makeFakeSb(ranges) {
  const listeners = {};
  return {
    updating: false,
    buffered: fakeRanges(ranges),
    _removed: [],
    remove(s, e) {
      this._removed.push([s, e]);
      (listeners.updateend || []).forEach((cb) => cb());
    },
    abort() {},
    addEventListener(type, cb) {
      (listeners[type] ||= []).push(cb);
    },
    removeEventListener() {},
  };
}

function makeController(rangesByType, currentTime) {
  const c = new MseController();
  c._queues = {};
  c.sourceBuffers = {};
  for (const [type, ranges] of Object.entries(rangesByType)) {
    c.sourceBuffers[type] = makeFakeSb(ranges);
    c._queues[type] = Promise.resolve();
  }
  if (currentTime !== undefined) c.video = { currentTime };
  return c;
}

test('trim 移除播放点之前完全脱钩的整段历史缓冲', async () => {
  const c = makeController({ video: [[0, 10], [10, 20], [40, 60]] }, 50);
  // 保留窗口 = [20, 80]；[0,10]、[10,20] 全在左侧 → 移除；[40,60] 在窗口内
  const removed = await c.trim({ behindSec: 30, aheadSec: 30, currentTime: 50 });
  assert.deepEqual(c.sourceBuffers.video._removed, [[0, 10], [10, 20]]);
  assert.equal(removed.length, 2);
});

test('trim 移除播放点之后过远的整段缓冲', async () => {
  const c = makeController({ video: [[0, 40], [120, 140]] }, 50);
  // 保留窗口 = [20, 80]；[0,40] 与 40>20 部分重叠 → 保留；[120,140] 全在右侧 → 移除
  const removed = await c.trim({ behindSec: 30, aheadSec: 30, currentTime: 50 });
  assert.deepEqual(c.sourceBuffers.video._removed, [[120, 140]]);
  assert.equal(removed.length, 1);
});

test('trim 与窗口部分重叠的区间保守保留，不误删', async () => {
  const c = makeController({ video: [[10, 60]] }, 50);
  const removed = await c.trim({ behindSec: 30, aheadSec: 30, currentTime: 50 });
  assert.equal(removed.length, 0);
  assert.equal(c.sourceBuffers.video._removed.length, 0);
});

test('trim 覆盖 video/audio 双轨', async () => {
  const c = makeController(
    { video: [[0, 10], [50, 70]], audio: [[0, 10], [50, 70]] },
    50
  );
  const removed = await c.trim({ behindSec: 30, aheadSec: 30, currentTime: 50 });
  // 每轨各移除左侧 [0,10]
  assert.deepEqual(c.sourceBuffers.video._removed, [[0, 10]]);
  assert.deepEqual(c.sourceBuffers.audio._removed, [[0, 10]]);
  assert.equal(removed.length, 2);
});

test('trim 无播放点时安全返回空（不抛）', async () => {
  const c = makeController({ video: [[0, 10]] });
  const removed = await c.trim({ currentTime: NaN });
  assert.deepEqual(removed, []);
});

test('trim 默认回退 this.video.currentTime', async () => {
  const c = makeController({ video: [[0, 10], [10, 20], [40, 60]] });
  c.video = { currentTime: 50 };
  const removed = await c.trim();
  assert.deepEqual(c.sourceBuffers.video._removed, [[0, 10], [10, 20]]);
});
