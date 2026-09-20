/**
 * flv-parser-gaps.test.js —— FlvParser 残余分支补测（wave 154）
 *
 * 覆盖：
 *   - reset()：解析中途全量状态归零（流/标志/头事件/关键帧索引/统计），重置后可复用；
 *   - _parseVideo frameType=5（Video Info/Command Frame）→ 静默忽略，不产 video 事件也不报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FlvParser } from '../src/flv-parser.js';
import {
  flvHeader, tag, avcSequenceTag, avcVideoTag,
  buildAvcC, defaultH264Sps, defaultH264Pps, toAvcc,
} from './fixtures/build-flv.mjs';

function collect(parser) {
  const log = { header: [], video: [], errors: [] };
  parser.on('header', (h) => log.header.push(h));
  parser.on('video', (v) => log.video.push(v));
  parser.on('error', (e) => log.errors.push(e));
  return log;
}

test('reset：解析状态全量归零且重置后可重新喂流', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(flvHeader({ hasAudio: true, hasVideo: true }));
  const avcC = buildAvcC(defaultH264Sps(), defaultH264Pps());
  p.push(avcSequenceTag(avcC, 0));
  p.push(avcVideoTag(true, toAvcc([new Uint8Array([0x65, 1, 2, 3])]), 100));
  assert.ok(p.keyframeIndex.length > 0, '重置前应已有关键帧索引');
  assert.equal(p.stats.tags, 2, '重置前 stats 应计入 2 个 tag');
  assert.equal(p.hasVideo, true);
  assert.equal(p._headerEmitted, true);

  p.reset();
  assert.equal(p.hasAudio, false);
  assert.equal(p.hasVideo, false);
  assert.equal(p._headerEmitted, false);
  assert.equal(p.keyframeIndex.length, 0);
  assert.deepEqual(p.stats, { tags: 0, audioTags: 0, videoTags: 0, scriptTags: 0, bytesParsed: 0 });

  // 重置后应可重新解析新流（头事件重新派发）
  p.push(flvHeader({ hasAudio: false, hasVideo: true }));
  assert.equal(log.header.length, 2);
  assert.deepEqual(log.header[1], { hasAudio: false, hasVideo: true });
});

test('frameType=5（Video Info/Command）→ 静默忽略', () => {
  const p = new FlvParser();
  const log = collect(p);
  p.push(flvHeader({ hasAudio: false, hasVideo: true }));
  // 视频 tag：首字节高 4 位 = 5（Info/Command），低 4 位 codecID=7（AVC）
  const body = Uint8Array.from([0x57, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4]);
  p.push(tag(9, body, 0));
  assert.equal(log.video.length, 0, 'Info/Command 帧不应产出 video 事件');
  assert.equal(log.errors.length, 0, 'Info/Command 帧不应报错');
});
