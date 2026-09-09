/**
 * NALU 工具单测：起始码扫描、AnnexB 拆分、AVCC 转换、avcC/hvcC 构造、SPS 宽高
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findStartCode, splitAnnexB, classify, annexbToAvcc, nalusToAnnexB,
  buildAvcc, buildHvcc,
  parseH264SpsDimensions, parseHevcSpsDimensions,
} from '../src/nalu.js';

import {
  h264Sps, h264Pps,
  hevcVps, hevcSps, hevcPps,
  annexb,
} from './fixtures/build-ts.mjs';

test('findStartCode：识别 3/4 字节起始码', () => {
  const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0xaa, 0x00, 0x00, 0x01, 0x68]);
  const first = findStartCode(data, 0);
  assert.deepEqual({ start: first.start, length: first.length }, { start: 0, length: 4 });
  // 第二处为 3 字节起始码，位于下标 6
  const second = findStartCode(data, 4);
  assert.deepEqual({ start: second.start, length: second.length }, { start: 6, length: 3 });
  assert.equal(findStartCode(data, 10), null);
});

test('splitAnnexB：混合起始码 + 尾部零填充', () => {
  const sps = h264Sps(320, 240);
  const pps = h264Pps();
  const es = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, ...sps,
    0x00, 0x00, 0x01, ...pps,
    0x00, 0x00, 0x00,   // 尾部零填充应被剔除，不进入 NALU
  ]);
  const units = splitAnnexB(es);
  assert.equal(units.length, 2);
  assert.equal(units[0].h264Type, 7);
  assert.deepEqual([...units[0].data], [...sps]);
  assert.equal(units[1].h264Type, 8);
  assert.deepEqual([...units[1].data], [...pps]);
});

test('annexbToAvcc：长度前缀正确', () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([9]);
  const avcc = annexbToAvcc([a, b]);
  assert.equal(avcc.length, (4 + 3) + (4 + 1));
  assert.deepEqual([...avcc.subarray(0, 4)], [0, 0, 0, 3]);   // 第一个 NALU 长度
  assert.deepEqual([...avcc.subarray(7, 11)], [0, 0, 0, 1]);  // 第二个 NALU 长度
});

test('nalusToAnnexB ↔ splitAnnexB 往返', () => {
  const nalus = [h264Sps(320, 240), h264Pps(), new Uint8Array([0x65, 1, 2, 3])];
  const round = splitAnnexB(nalusToAnnexB(nalus));
  assert.equal(round.length, 3);
  assert.deepEqual([...round.map((u) => u.data)], [...nalus]);
});

test('buildAvcc：结构与 SPS/PPS 内容一致', () => {
  const sps = h264Sps(320, 240);
  const pps = h264Pps();
  const avcC = buildAvcc([sps], [pps]);
  assert.equal(avcC[0], 1);            // configurationVersion
  assert.equal(avcC[1], sps[1]);       // profile
  assert.equal(avcC[4] & 0x03, 3);     // lengthSizeMinusOne = 3
  assert.equal(avcC[5] & 0x1f, 1);     // numOfSPS
  const spsLen = (avcC[6] << 8) | avcC[7];
  assert.equal(spsLen, sps.length);
});

test('parseH264SpsDimensions：常见分辨率', () => {
  for (const [w, h] of [[320, 240], [1280, 720], [1920, 1080]]) {
    const dims = parseH264SpsDimensions(h264Sps(w, h));
    assert.ok(dims, `${w}x${h} 应可解析`);
    assert.equal(dims.width, w);
    assert.equal(dims.height, h);
  }
});

test('buildHvcc + parseHevcSpsDimensions：HEVC 三件套', () => {
  const vps = hevcVps();
  const sps = hevcSps(256, 144);
  const pps = hevcPps();
  const hvcc = buildHvcc([vps], [sps], [pps]);
  assert.equal(hvcc[0], 1);                    // configurationVersion
  assert.equal(hvcc[22], 3);                   // numOfArrays（VPS+SPS+PPS）
  // 第一个数组应为 VPS(32)
  assert.equal(hvcc[23] & 0x3f, 32);

  const dims = parseHevcSpsDimensions(sps);
  assert.ok(dims);
  assert.equal(dims.width, 256);
  assert.equal(dims.height, 144);
});

test('buildHvcc：chroma / 色深 / nesting 取自 SPS（评审 #4 残余项）', () => {
  const vps = hevcVps();
  const pps = hevcPps();
  // hvcC 布局：16=chroma、17=bitDepthLuma-8、18=bitDepthChroma-8、21 的 bit2=nesting
  const base = buildHvcc([vps], [hevcSps(256, 144)], [pps]);
  assert.equal(base[16] & 0x03, 1, '4:2:0');
  assert.equal(base[17] & 0x07, 0, '8bit luma');
  assert.equal(base[18] & 0x07, 0, '8bit chroma');
  assert.equal(base[21] & 0x04, 0x04, 'temporal_id_nesting=1 须写入');

  // main10（10bit）4:2:0
  const main10 = buildHvcc([vps], [hevcSps(3840, 2160, { bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2 })], [pps]);
  assert.equal(main10[17] & 0x07, 2, 'main10 luma 位深必须来自 SPS');
  assert.equal(main10[18] & 0x07, 2, 'main10 chroma 位深必须来自 SPS');

  // 4:2:2 + 关闭 nesting
  const yuv422 = buildHvcc([vps], [hevcSps(1920, 1080, { chromaFormatIdc: 2, temporalIdNesting: 0 })], [pps]);
  assert.equal(yuv422[16] & 0x03, 2, '4:2:2 不得硬编码为 4:2:0');
  assert.equal(yuv422[21] & 0x04, 0, 'nesting=0 须反映到 hvcC');
});

test('classify：按 codec 选择类型字段', () => {
  const units = splitAnnexB(annexb(new Uint8Array([0x26, 0x01, 0xaa])));
  const hevcUnits = classify(units, 'hevc');
  assert.equal(hevcUnits[0].type, 19);   // IDR_W_RADL
});
