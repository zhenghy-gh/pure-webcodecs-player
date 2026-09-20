/**
 * remuxer-gaps.test.js —— Fmp4Remuxer 残余分支补测（wave 147）
 *
 * 覆盖：
 *   - sequenceNumber getter 与 resetSequence；
 *   - nmhd：非 video/audio（meta）轨的 init segment 占位 stsd；
 *   - remuxDemuxer：videoTrackId 过滤分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer, remuxDemuxer } from '../src/remuxer.js';
import { iterateBoxes } from '../src/box-parser.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { buildProgressiveVideoFixture } from './fixtures.js';

test('sequenceNumber getter 与 resetSequence', () => {
  const r = new Fmp4Remuxer();
  const track = {
    id: 1, type: 'video', codec: 'avc1.42E01E', timescale: 1000, sampleEntryType: 'avc1',
    width: 320, height: 240, description: new Uint8Array([1]),
  };
  r.createInitSegment(track);
  const samples = [{ index: 0, dts: 0, timestamp: 0, duration: 40_000, keyframe: true, data: new Uint8Array(4) }];
  r.createMediaSegment(track, samples);
  assert.equal(r.sequenceNumber, 1);
  r.resetSequence(5);
  assert.equal(r.sequenceNumber, 5);
});

test('nmhd：meta 轨 init segment 使用 nmhd 占位 stsd', () => {
  const r = new Fmp4Remuxer();
  const track = {
    id: 3, type: 'metadata', codec: 'meta', timescale: 1000, sampleEntryType: 'avc1',
    description: new Uint8Array([0xaa, 0xbb]),
  };
  const init = r.createInitSegment(track);
  const types = [];
  iterateBoxes(init, 0, init.byteLength, (h) => {
    types.push(h.type);
    return true;
  });
  assert.deepEqual(types, ['ftyp', 'moov']);
  // nmhd fullbox 字面量（12 字节）应出现在 init 字节流中
  const nmhd = [0x6e, 0x6d, 0x68, 0x64]; // 'nmhd'
  let found = false;
  for (let i = 0; i + 4 <= init.length; i++) {
    if (init[i] === nmhd[0] && init[i + 1] === nmhd[1] && init[i + 2] === nmhd[2] && init[i + 3] === nmhd[3]) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'init segment 应含 nmhd 盒');
});

test('remuxDemuxer：videoTrackId 过滤非目标轨', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  const outputs = await remuxDemuxer(d, { videoTrackId: 1 });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].track.id, 1);

  const d2 = new Mp4Demuxer();
  d2.attach(new MemoryDataSource(bytes));
  await d2.init();
  const outputs2 = await remuxDemuxer(d2, { videoTrackId: 999 }); // 过滤后无轨
  assert.equal(outputs2.length, 0);
});
