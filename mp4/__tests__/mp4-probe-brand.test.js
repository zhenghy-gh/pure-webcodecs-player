import test from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Demuxer } from '../src/demuxer.js';
import { MovDemuxer } from '../../mov/src/demuxer.js';

function ftyp(major, compatible = []) {
  const size = 16 + compatible.length * 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = 'ftyp'.charCodeAt(i);
  for (let i = 0; i < 4; i += 1) bytes[8 + i] = major.charCodeAt(i) ?? 0x20;
  for (let i = 0; i < compatible.length; i += 1) {
    const brand = compatible[i];
    for (let j = 0; j < 4; j += 1) bytes[16 + i * 4 + j] = brand.charCodeAt(j) ?? 0x20;
  }
  return bytes;
}

test('probe：qt6 等相似品牌不应误判为 MOV', () => {
  const bytes = ftyp('qt6 ', ['qt6 ']);
  assert.equal(Mp4Demuxer.probe(bytes)?.container, 'mp4');
  const mov = MovDemuxer.probe(bytes);
  assert.equal(mov?.container, 'mov');
  assert.ok(mov && mov.confidence < 0.8, '低置信 MOV 结果应让位给 MP4');
});

test('probe：精确 qt  品牌仍由 MOV 高置信命中', () => {
  const bytes = ftyp('qt  ', ['qt  ']);
  const hit = MovDemuxer.probe(bytes);
  assert.ok(hit);
  assert.equal(hit.container, 'mov');
  assert.equal(hit.confidence, 0.98);
});

test('probe：主品牌非 qt 但兼容品牌含 qt  时交由 MOV', () => {
  const bytes = ftyp('isom', ['isom', 'qt  ']);
  const hit = MovDemuxer.probe(bytes);
  assert.ok(hit);
  assert.equal(hit.container, 'mov');
  assert.equal(hit.confidence, 0.98);
});
