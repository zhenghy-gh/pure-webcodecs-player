/**
 * mp4 出口 createDemuxer 残余分支补测（wave 123）：
 *  - 源 read 抛错 → head=null → PROBE_FAILED（而非原错误外泄）
 *  - 垃圾字节 → PROBE_FAILED
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDemuxer } from '../src/index.js';
import { MemoryDataSource } from '../../core/src/index.js';

test('createDemuxer：源 read 抛错 → head=null → PROBE_FAILED', async () => {
  const bad = {
    size: 1024,
    read: async () => {
      throw new Error('io exploded');
    },
  };
  await assert.rejects(
    () => createDemuxer(bad),
    (e) => e.code === 'PROBE_FAILED'
  );
});

test('createDemuxer：垃圾字节 → PROBE_FAILED', async () => {
  const junk = new Uint8Array(64).fill(0x33);
  await assert.rejects(
    () => createDemuxer(new MemoryDataSource(junk)),
    (e) => e.code === 'PROBE_FAILED'
  );
});
