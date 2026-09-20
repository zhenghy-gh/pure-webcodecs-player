/**
 * mov-probe-gaps.test.js —— MovDemuxer.probe 残余分支补测（wave 143）
 *
 * 覆盖：
 *   - 顶层出现 QT 特征 atom（wide/pnot/skip）→ hinted 提示路径（置信抬到 ≥0.9）；
 *   - 基础探测抛错（注入 Mp4Demuxer.probe 抛错）→ 外层 catch 返回 null。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MovDemuxer } from '../src/demuxer.js';
import { Mp4Demuxer } from '../../mp4/src/demuxer.js';

/** 顶层 atom：size(4) + type(4) + payload */
function atom(type, payload = new Uint8Array(0)) {
  const head = new Uint8Array(8);
  const size = 8 + payload.length;
  new DataView(head.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const out = new Uint8Array(size);
  out.set(head, 0);
  out.set(payload, 8);
  return out;
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
/** iso 品牌有效 mp4 ftyp（非 QT 品牌 → looksLikeQuickTime 不命中） */
function ftypIso() {
  const major = 'isom';
  const payload = concat(
    Uint8Array.from([...major].map((c) => c.charCodeAt(0))),
    Uint8Array.from([0, 0, 2, 0]),
    Uint8Array.from([...major].map((c) => c.charCodeAt(0))),
  );
  return atom('ftyp', payload);
}
const w8 = (v) => Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);

test('probe：顶层 wide atom（QT 特征）→ hinted 置信 0.9', () => {
  // ftyp(size=0x14 isom) + wide(size=8) —— 顶层扫描命中 QT_TOP_ATOMS
  const ftypBody = concat(
    Uint8Array.from([0x69, 0x73, 0x6f, 0x6d]), // major 'isom'
    w8(0x200),
    Uint8Array.from([0x69, 0x73, 0x6f, 0x6d]),
  );
  const bytes = concat(atom('ftyp', ftypBody), atom('wide'), atom('free'));
  const r = MovDemuxer.probe(bytes);
  assert.ok(r, 'wide 提示应命中 mov');
  assert.equal(r.container, 'mov');
  assert.equal(r.confidence, 0.95, 'hinted 分支取 max(base=0.95, 0.9)');
});

test('probe：基础探测抛错 → 外层 catch 返回 null', () => {
  const original = Mp4Demuxer.probe;
  Mp4Demuxer.probe = () => { throw new Error('inject: probe exploded'); };
  try {
    assert.equal(MovDemuxer.probe(ftypIso()), null);
  } finally {
    Mp4Demuxer.probe = original;
  }
});
