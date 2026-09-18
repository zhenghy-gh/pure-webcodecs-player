/**
 * ts index.js §10 委托出口补测（第一百二十一波）：probe / createDemuxer 委托。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Mod from '../src/index.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { assembleTs } from './fixtures/build-ts.mjs';

test('index.probe：委托主类同步嗅探（命中 / 垃圾 null 且不抛）', () => {
  const ts = assembleTs({ video: { codec: 'h264', frames: 2 } });
  const pr = Mod.probe(ts.subarray(0, 4096));
  assert.equal(pr.container, 'ts');
  assert.ok(pr.confidence >= 0.8);
  assert.equal(Mod.probe(new Uint8Array(64).fill(1)), null);
  assert.equal(Mod.probe(null), null);
});

test('index.createDemuxer：工厂委托全链路（DataSource → ready）', async () => {
  const ts = assembleTs({
    video: { codec: 'h264', width: 320, height: 240, frames: 4, gopSize: 2 },
    audio: { mode: 'adts', count: 2 },
  });
  const d = await Mod.createDemuxer(new MemoryDataSource(ts));
  assert.equal(d.state, 'ready');
  assert.equal(d.mediaInfo.container, 'ts');
  await d.destroy();
});
