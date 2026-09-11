/**
 * iso-bmff.js 边界单测补充（flv 第九十波之后的新增面）
 *
 * 既有 flv-iso-bmff-box / flv-iso-bmff-moof 已覆盖盒字节布局主体；本文件补少量
 * 此前未触达的微边界：
 *   - moofBox 首样本关键帧 + N>1 样本时，逐样本 cts 精确写入且 first_sample_flags 仅占偏移 12
 *   - fullBox 24 位 flags 取最大值（0xFFFFFF）的字节编码
 *   - box 嵌套（外层尺寸须覆盖内层整盒）
 *   - mvhdBox 任意 timescale（非 1000）正确落位
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { box, fullBox, mvhdBox, moofBox } from '../src/iso-bmff.js';

function drill(bytes, path) {
  let cur = bytes;
  for (const name of path) {
    const view = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
    let pos = 0;
    let hit = -1;
    while (pos + 8 <= cur.length) {
      const size = view.getUint32(pos);
      const type = String.fromCharCode(cur[pos + 4], cur[pos + 5], cur[pos + 6], cur[pos + 7]);
      if (type === name) { hit = pos; break; }
      pos += size;
    }
    if (hit < 0) return null;
    cur = cur.subarray(hit + 8, hit + view.getUint32(hit));
  }
  return cur;
}

test('moofBox：首样本关键帧 + 多样本逐样本 cts 精确写入，first_sample_flags 仅占偏移 12', () => {
  const moof = moofBox({
    seqNo: 5, trackId: 1, baseDts: 120,
    samples: [
      { duration: 33, size: 10, cts: 0, keyframe: true },
      { duration: 33, size: 20, cts: 5, keyframe: false },
      { duration: 33, size: 30, cts: 10, keyframe: false },
    ],
  });
  const trun = drill(moof, ['moof', 'traf', 'trun']);
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const flags = view.getUint32(0) & 0xffffff;
  assert.equal(flags, 0x705, '0x701 | 0x004（首帧同步样本）');
  assert.equal(view.getUint32(4), 3, 'sample_count=3');
  assert.equal(view.getUint32(8), 0, 'data_offset 占位');
  // first_sample_flags 在 version/flags(4)+count(4)+data_offset(4)=偏移 12
  assert.equal(view.getUint32(12), 0x02000000, 'first_sample_flags 在偏移 12');
  // 样本从偏移 16 起：duration,size,cts × 3
  assert.equal(view.getUint32(16), 33);
  assert.equal(view.getUint32(20), 10);
  assert.equal(view.getUint32(24), 0);
  assert.equal(view.getUint32(28), 33);
  assert.equal(view.getUint32(32), 20);
  assert.equal(view.getUint32(36), 5);
  assert.equal(view.getUint32(40), 33);
  assert.equal(view.getUint32(44), 30);
  assert.equal(view.getUint32(48), 10, '末样本 cts=10 精确');
});

test('fullBox：24 位 flags 取最大值 0xFFFFFF 的字节编码', () => {
  const b = fullBox('xbx', 0, 0xFFFFFF);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(b.length, 12);
  assert.deepEqual([view.getUint8(9), view.getUint8(10), view.getUint8(11)], [0xff, 0xff, 0xff]);
});

test('box：嵌套（外层尺寸须覆盖内层整盒，含其 8 字节盒头）', () => {
  const inner = box('inrc', Uint8Array.from([1, 2, 3]));
  const outer = box('outr', inner);
  assert.equal(outer.length, 8 + inner.length);
  const view = new DataView(outer.buffer, outer.byteOffset, outer.byteLength);
  assert.equal(view.getUint32(0), 8 + inner.length, '外层 size 含内层整盒');
  assert.equal(String.fromCharCode(outer[4], outer[5], outer[6], outer[7]), 'outr');
  // 内层应完好嵌套于偏移 8
  assert.equal(String.fromCharCode(outer[8 + 4], outer[8 + 5], outer[8 + 6], outer[8 + 7]), 'inrc');
  // 内层 payload 首字节紧随其 8 字节盒头
  assert.equal(outer[8 + 8], 1, '内层 payload[0]=1');
});

test('mvhdBox：任意 timescale（90000）正确落位且其余字段不漂移', () => {
  const m = mvhdBox(90000);
  const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
  assert.equal(view.getUint32(20), 90000, 'timescale 应等于入参');
  assert.equal(view.getUint32(28), 0x00010000, 'rate 仍为 1.0');
  assert.equal(view.getUint32(104), 2, 'next_track_id 仍为 2');
});
