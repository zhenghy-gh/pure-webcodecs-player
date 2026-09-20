/**
 * index-gaps.test.js —— mov 模块 §10 工厂残余分支补测（wave 155）
 *
 * 覆盖：createDemuxer 数据源 read 直接 reject → head 读取 catch 置 null
 * → 无法识别抛 PROBE_FAILED（而非裸 read 错误冒泡）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDemuxer } from '../src/index.js';

test('createDemuxer：head 读取抛错 → catch 后 PROBE_FAILED', async () => {
  const brokenSource = {
    size: 128,
    read: async () => { throw new Error('介质不可读'); },
  };
  await assert.rejects(
    createDemuxer(brokenSource),
    (e) => e.name === 'PlayerError' && e.code === 'PROBE_FAILED',
  );
});
