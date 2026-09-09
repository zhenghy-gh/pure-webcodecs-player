/**
 * cmaf/llhls 边界补充：时间线推进 / part 状态流转 / probe 契约形状
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartTimeline, PartState, nextPollTarget } from '../src/index.js';
import { splitChunks, parseInitSegment, probe } from '../src/chunk-parser.js';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';

test('PartTimeline：markReady 后 pickNext 不再返回已就绪 part', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist([
    { sn: 1, parts: [{ uri: 'a.mp4', duration: 0.5, independent: true }, { uri: 'b.mp4', duration: 0.5, independent: false }] },
  ]);
  tl.markReady('a.mp4');
  const next = tl.pickNext({ maxAhead: 5 });
  assert.deepEqual(next.map((p) => p.uri), ['b.mp4'], 'READY 的 a 不应再被选中');
});

test('PartTimeline：lastPart 只在最新 sn 上推进', () => {
  const tl = new PartTimeline();
  tl.updateFromPlaylist([
    { sn: 10, parts: [{ uri: 'x.mp4', duration: 0.5, independent: true }] },
    { sn: 11, parts: [{ uri: 'y.mp4', duration: 0.5, independent: true }, { uri: 'z.mp4', duration: 0.5, independent: false }] },
  ]);
  assert.equal(tl.lastMsn, 11);
  assert.equal(tl.lastPart, 1, 'lastPart 取最新分片的最后一个下标');
  // 轮询目标应请求 sn=12 且 part 挂起在 1
  assert.deepEqual(nextPollTarget({ ...tl, serverControl: { canBlockReload: true } }), { msn: 12, part: 1 });
});

test('splitChunks：initRange 字节切片可直接过 parseInitSegment', () => {
  const FAKE = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 8, 0x67, 0x64, 0x00, 0x1f, 0xac]);
  const init = fmp4.buildInit([{ id: 1, type: 'video', codec: 'avc1.64001f', description: { tag: 'avcC', bytes: FAKE }, width: 64, height: 64, timescale: 90000 }]);
  const frag = fmp4.buildFragment({ trackId: 1, samples: [{ dts: 0, pts: 0, duration: 3003, keyframe: true, data: new Uint8Array(16) }] });
  const buf = new Uint8Array(init.length + frag.length);
  buf.set(init, 0);
  buf.set(frag, init.length);

  const { initRange } = splitChunks(buf);
  assert.ok(initRange && initRange.byteLength === init.length);
  const info = parseInitSegment(buf.slice(initRange.startOffset, initRange.startOffset + initRange.byteLength));
  assert.equal(info.video.entryType, 'avc1');
});


test('probe：styp 流置信度高于 ftyp（契约 §10 confidence 语义）', () => {
  const fragOnly = fmp4.buildFragment({ trackId: 1, samples: [{ dts: 0, pts: 0, duration: 3003, keyframe: true, data: new Uint8Array(8) }] });
  const stypProbe = probe(fragOnly);
  assert.equal(stypProbe.confidence, 0.95);

  const ftypBuf = new Uint8Array(16);
  ftypBuf.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.ok(probe(ftypBuf).confidence < stypProbe.confidence);
});
