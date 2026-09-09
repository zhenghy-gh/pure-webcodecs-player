/**
 * cmaf sidx 与 webrtc 本地 mock 信令的补充单测（派发单 T14/T15 缺口项）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSidx, readBoxHeader } from '../src/isobmff.js';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';

/* ---------------- sidx ---------------- */

/** 手工构造一个 version=0 的 sidx box */
function buildSidxBytes({ refId = 1, timescale = 90000, ept = 0, firstOffset = 0, refs }) {
  // vf(4)+refId(4)+timescale(4)+ept(4)+firstOffset(4)+reserved(2)+count(2)
  const body = new Uint8Array(24 + refs.length * 12);
  const dv = new DataView(body.buffer);
  let p = 0;
  // fullBox 头：version=0 flags=0
  p += 4;
  dv.setUint32(p, refId); p += 4;
  dv.setUint32(p, timescale); p += 4;
  dv.setUint32(p, ept); p += 4;
  dv.setUint32(p, firstOffset); p += 4;
  p += 2; // reserved
  dv.setUint16(p, refs.length); p += 2;
  for (const r of refs) {
    dv.setUint32(p, (r.referenceType << 31) | r.size); p += 4;
    dv.setUint32(p, r.duration); p += 4;
    dv.setUint32(p, ((r.startsWithSAP ? 1 : 0) << 31) | ((r.sapType & 7) << 28)); p += 4;
  }
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
  out.set(body, 8);
  return out;
}

test('sidx：version=0 引用表与 SAP 位解析', () => {
  const bytes = buildSidxBytes({
    refId: 256,
    timescale: 90000,
    ept: 90000,
    firstOffset: 128,
    refs: [
      { size: 50000, duration: 27027, startsWithSAP: true, sapType: 1 },
      { size: 48000, duration: 27027, startsWithSAP: false, sapType: 0 },
    ],
  });
  const head = readBoxHeader(bytes, 0);
  assert.equal(head.type, 'sidx');
  // readBoxHeader 只返回头尺寸；内容起点 = headerSize
  const idx = parseSidx(bytes, head.headerSize, head.size);
  assert.equal(idx.referenceId, 256);
  assert.equal(idx.timescale, 90000);
  assert.equal(idx.earliestPresentationTimeTicks, 90000);
  assert.equal(idx.firstOffset, 128);
  assert.equal(idx.references.length, 2);
  const [r0, r1] = idx.references;
  assert.equal(r0.size, 50000);
  assert.equal(r0.startsWithSAP, true);
  assert.equal(r0.sapType, 1);
  assert.equal(r1.startsWithSAP, false);
});

test('splitChunks：流内 sidx 被捕获为 segmentIndex', () => {
  // init + sidx + 一个 chunk
  const FAKE = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 8, 0x67, 0x64]);
  const init = fmp4Init();
  const sidx = buildSidxBytes({ refs: [{ size: 999, duration: 9009, startsWithSAP: true, sapType: 1 }] });
  const frag = fmp4Frag();
  const buf = concatAll([init, sidx, frag]);

  const { chunks, segmentIndex } = splitChunks(buf);
  assert.ok(segmentIndex, '应捕获 sidx');
  assert.equal(segmentIndex.timescale, 90000);
  assert.equal(chunks.length, 1);

  function fmp4Init() {
    return fmp4InitImpl();
  }
  function fmp4Frag() {
    return fmp4FragImpl();
  }
  function fmp4InitImpl() {
    return fmp4.buildInit([
      { id: 1, type: 'video', codec: 'avc1.64001f', description: { tag: 'avcC', bytes: FAKE }, width: 64, height: 64, timescale: 90000 },
    ]);
  }
  function fmp4FragImpl() {
    return fmp4.buildFragment({ trackId: 1, samples: [{ dts: 0, pts: 0, duration: 3003, keyframe: true, data: new Uint8Array(16).fill(3) }] });
  }
  function concatAll(parts) {
    const total = parts.reduce((n, x) => n + x.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const x of parts) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  }
});

test('prft：生产者时钟参考（v0/v1 双版本）', async () => {
  const { parsePrft } = await import('../src/isobmff.js');
  const build = (version, producer, media) => {
    const body = new Uint8Array(version === 1 ? 28 : 20); // vf+refId+tscale+(v1:8+8 / v0:4+4)
    const dv = new DataView(body.buffer);
    body[0] = version;
    dv.setUint32(4, 42);            // referenceTrackId
    dv.setUint32(8, 90000);         // referenceTimescale
    if (version === 1) {
      dv.setBigUint64(12, BigInt(producer));
      dv.setBigUint64(20, BigInt(media));
    } else {
      dv.setUint32(12, producer);
      dv.setUint32(16, media);
    }
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set([0x70, 0x72, 0x66, 0x74], 4); // 'prft'
    out.set(body, 8);
    return out;
  };
  for (const version of [0, 1]) {
    const head = readBoxHeader(build(version, 1690000000000, 90090), 0);
    const r = parsePrft(build(version, 1690000000000, 90090), head.headerSize, head.size);
    assert.equal(r.referenceTrackId, 42);
    assert.equal(r.referenceTimescale, 90000);
    assert.equal(r.mediaTimeTicks, 90090, `v${version} media_time 应解析`);
  }
});
