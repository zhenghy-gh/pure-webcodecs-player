/**
 * Transmuxer 残余分支补测（第一百二十波）
 * ------------------------------------------------------------
 * 覆盖：isInit 直通、真实 TS 分片经 process 转封装、reset/destroy
 * 重建内部 impl。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleTs } from '../../ts/__tests__/fixtures/build-ts.mjs';
import { Transmuxer, sniffContainer } from '../src/transmuxer.js';

test('process：isInit=true 时无条件直通（即便字节形似 TS）', async () => {
  const ts = assembleTs({ video: { codec: 'h264', frames: 2 }, audio: { count: 2 } });
  const t = new Transmuxer();
  const out = await t.process(ts, { isInit: true });
  assert.deepEqual(out, { kind: 'passthrough', mediaSegment: ts });
});

test('process：TS 媒体分片 → transmuxed（双轨 codecs + init/media 段），reset/destroy 可重建', async () => {
  const ts = assembleTs({
    video: { codec: 'h264', width: 320, height: 240, frames: 3, gopSize: 3 },
    audio: { mode: 'adts', count: 2 },
  });
  assert.equal(sniffContainer(ts), 'ts');

  const t = new Transmuxer();
  const out = await t.process(ts);
  assert.equal(out.kind, 'transmuxed');
  assert.ok(out.codecs.video.startsWith('avc1.'), `video codec: ${out.codecs.video}`);
  assert.ok(out.codecs.audio.startsWith('mp4a.'), `audio codec: ${out.codecs.audio}`);
  assert.ok(out.video.initSegment instanceof Uint8Array, 'video init 段就绪');
  assert.ok(out.video.mediaSegment.byteLength > 0);
  assert.ok(out.audio && out.audio.mediaSegment.byteLength > 0, '音频段就绪');

  // reset() 销毁内部 impl；随后 process 应自动重建并可继续转封装
  t.reset();
  const out2 = await t.process(ts);
  assert.equal(out2.kind, 'transmuxed');

  // destroy() 等价 reset()
  t.destroy();
  const out3 = await t.process(ts);
  assert.equal(out3.kind, 'transmuxed');
});
