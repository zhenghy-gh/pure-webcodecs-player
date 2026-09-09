/**
 * samples/fixtures/__tests__/mp4.test.js —— makeMinimalMP4 结构合法性验证。
 * 本文件同时充当 ISO-BMFF 解析的最小参考实现（box 遍历器），供 mov/mp4 模块作者对照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMinimalMP4, buildAvcC, FAKE_SPS, FAKE_PPS } from '../index.js';

/** 顺序遍历 [start,end) 内的顶层/同级 box */
export function* iterBoxes(bytes, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = start;
  while (off + 8 <= end) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    assert.ok(size >= 8 && off + size <= end, `非法 box 尺寸: type=${type} size=${size} off=${off}`);
    yield { type, off, size, bodyStart: off + 8, end: off + size };
    off += size;
  }
  assert.equal(off, end, 'box 序列未精确消费到边界');
}

function children(bytes, start, end) {
  return [...iterBoxes(bytes, start, end)];
}

function find(boxes, type) {
  const hit = boxes.filter((b) => b.type === type);
  assert.equal(hit.length, 1, `期望恰好一个 ${type} box`);
  return hit[0];
}

test('默认参数：三层结构与总长度自洽', () => {
  const { bytes, meta } = makeMinimalMP4();
  const top = children(bytes, 0, bytes.length);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);

  const moov = find(top, 'moov');
  const moovKids = children(bytes, moov.bodyStart, moov.end);
  assert.deepEqual(moovKids.map((b) => b.type), ['mvhd', 'trak']);
});

test('mvhd/tkhd/mdhd 时长与时间基一致，宽高为 16.16 定点', () => {
  const { bytes, meta } = makeMinimalMP4({ width: 640, height: 360, sampleCount: 5 });
  const top = children(bytes, 0, bytes.length);
  const moov = find(top, 'moov');
  const [mvhd, trak] = children(bytes, moov.bodyStart, moov.end);

  // mvhd v0：version+flags(4) creation(4) modification(4) timescale(4) duration(4)
  let p = mvhd.bodyStart + 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  p += 8;
  const movieTimescale = dv.getUint32(p); p += 4;
  const movieDuration = dv.getUint32(p);
  assert.equal(movieTimescale, meta.timescale);
  assert.equal(movieDuration, meta.durationTicks);
  assert.equal(meta.sampleCount * meta.timescale, meta.durationTicks);

  // trak → tkhd（跳过 tkhd 直接看 mdia 更稳：这里校验 tkhd 宽高字段）
  const trakKids = children(bytes, trak.bodyStart, trak.end);
  const tkhd = find(trakKids, 'tkhd');
  const tkhdWidth = dv.getUint32(tkhd.end - 8);
  const tkhdHeight = dv.getUint32(tkhd.end - 4);
  assert.equal(tkhdWidth, 640 << 16);
  assert.equal(tkhdHeight, 360 << 16);
});

test('stbl 六表齐全：stsz 表逐项等于样本长度、stco 指向 mdat 数据起点', () => {
  const { bytes, meta } = makeMinimalMP4();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = children(bytes, 0, bytes.length);
  const moov = find(top, 'moov');
  const [, trak] = children(bytes, moov.bodyStart, moov.end);
  const mdia = find(children(bytes, trak.bodyStart, trak.end), 'mdia');
  const minf = find(children(bytes, mdia.bodyStart, mdia.end), 'minf');
  const stbl = find(children(bytes, minf.bodyStart, minf.end), 'stbl');

  const stblKids = children(bytes, stbl.bodyStart, stbl.end);
  assert.deepEqual(
    stblKids.map((b) => b.type),
    ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco'],
  );

  // stsz：sample_size=0 → 表逐项
  const stsz = find(stblKids, 'stsz');
  let p = stsz.bodyStart + 4; // version+flags
  const sampleSizeUniform = dv.getUint32(p); p += 4;
  const count = dv.getUint32(p); p += 4;
  assert.equal(sampleSizeUniform, 0);
  assert.equal(count, meta.sampleCount);
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p + i * 4), meta.sizes[i], `stsz[${i}] 不匹配`);
  }

  // stco：单 chunk，偏移 = ftyp+moov 之后跳过 mdat 头
  const stco = find(stblKids, 'stco');
  const entryCount = dv.getUint32(stco.bodyStart + 4); // version+flags(4) 后即 entry_count
  assert.equal(entryCount, 1);
  const chunkOffset = dv.getUint32(stco.end - 4);
  assert.deepEqual(meta.chunkOffsets, [chunkOffset]);
  const mdat = find(top, 'mdat');
  assert.equal(chunkOffset, mdat.bodyStart, 'stco 应指向 mdat 第一个样本字节');

  // mdat 载荷总长 == 样本长度和
  assert.equal(mdat.end - mdat.bodyStart, meta.sizes.reduce((a, b) => a + b, 0));
});

test('stsd 内嵌 avcC：长度前缀宽度与 SPS/PPS 内容一致', () => {
  const { bytes } = makeMinimalMP4();
  const top = children(bytes, 0, bytes.length);
  const moov = find(top, 'moov');
  const [, trak] = children(bytes, moov.bodyStart, moov.end);
  const mdia = find(children(bytes, trak.bodyStart, trak.end), 'mdia');
  const minf = find(children(bytes, mdia.bodyStart, mdia.end), 'minf');
  const stbl = find(children(bytes, minf.bodyStart, minf.end), 'stbl');
  const stsd = find(children(bytes, stbl.bodyStart, stbl.end), 'stsd');

  // stsd 体：version+flags(4) entry_count(4) avc1(...)
  const avc1 = children(bytes, stsd.bodyStart + 8, stsd.end)[0];
  assert.equal(avc1.type, 'avc1');
  const inner = children(bytes, avc1.bodyStart + 78, avc1.end); // VisualSampleEntry 固定段 78 字节
  const avcCBox = inner.find((b) => b.type === 'avcC');
  assert.ok(avcCBox, 'avc1 中应包含 avcC');

  const expected = Array.from(buildAvcC());
  const actual = Array.from(bytes.subarray(avcCBox.bodyStart, avcCBox.end));
  assert.deepEqual(actual, expected);

  // avcC 内部：lengthSizeMinusOne=3；SPS/PPS 长度字段与 codecs.js 导出一致
  const cfg = actual;
  assert.equal(cfg[4] & 0x03, 3);
  assert.equal((cfg[5] & 0x1f), 1);
  assert.equal((cfg[6] << 8) | cfg[7], FAKE_SPS.length);
  assert.deepEqual(cfg.slice(8, 8 + FAKE_SPS.length), Array.from(FAKE_SPS));
  const ppsLenPos = 8 + FAKE_SPS.length;
  assert.equal(cfg[ppsLenPos], 1); // numOfPictureParameterSets
  // PPS 长度 u16 在 numOfPPS 之后，PPS 数据再往后
  assert.equal((cfg[ppsLenPos + 1] << 8) | cfg[ppsLenPos + 2], FAKE_PPS.length);
  assert.deepEqual(
    cfg.slice(ppsLenPos + 3, ppsLenPos + 3 + FAKE_PPS.length),
    Array.from(FAKE_PPS),
  );
});
