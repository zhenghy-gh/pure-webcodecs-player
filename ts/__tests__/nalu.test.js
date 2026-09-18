/**
 * NALU 工具单测：起始码扫描、AnnexB 拆分、AVCC 转换、avcC/hvcC 构造、SPS 宽高
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findStartCode, splitAnnexB, classify, annexbToAvcc, nalusToAnnexB,
  buildAvcc, buildHvcc,
  parseH264SpsDimensions, parseHevcSpsDimensions, parseHevcSpsConfig,
  h264NalType, isH264Keyframe, hevcNalType, isHevcKeyframe,
} from '../src/nalu.js';
import { BitWriter } from '../../core/src/bit-reader.js';

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

/* ------------------------------ 深分支补测（第一百一十七波） ------------------------------ */

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/** 按解析器读取序构造 H.264 SPS（与 flv/__tests__/codec-info-sps.test.js 同构） */
function buildH264Sps(opts = {}) {
  const {
    profileIdc = 66, width = 320, height = 240,
    chromaFormatIdc = 1, scalingMatrix = false, pocType = 2, frameMbsOnly = true,
  } = opts;
  const w = new BitWriter();
  w.writeBits(0x67, 8);
  w.writeBits(profileIdc, 8);
  w.writeBits(0xc0, 8);
  w.writeBits(30, 8);
  w.writeUE(0);
  if (HIGH_PROFILES.includes(profileIdc)) {
    w.writeUE(chromaFormatIdc);
    if (chromaFormatIdc === 3) w.writeBits(0, 1);
    w.writeUE(0); w.writeUE(0);
    w.writeBits(0, 1);
    w.writeBits(scalingMatrix ? 1 : 0, 1);
    if (scalingMatrix) {
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        w.writeBits(1, 1);
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) w.writeSE(0);
      }
    }
  }
  w.writeUE(4);
  w.writeUE(pocType);
  if (pocType === 0) w.writeUE(0);
  else if (pocType === 1) { w.writeBits(0, 1); w.writeSE(0); w.writeSE(0); w.writeSE(0); }
  w.writeUE(1);
  w.writeBits(0, 1);
  w.writeUE(width / 16 - 1);
  w.writeUE(height / 16 - 1);
  w.writeBits(frameMbsOnly ? 1 : 0, 1);
  if (!frameMbsOnly) w.writeBits(0, 1);
  w.writeBits(0, 1); w.writeBits(0, 1); w.writeBits(0, 1);
  w.writeBits(1, 1);
  return w.finish();
}

/**
 * 按解析器读取序构造 HEVC SPS。可选项覆盖 parseHevcSpsDimensions 与
 * parseHevcSpsConfig 两套读取路径（后者多读 bit_depth 两字段）。
 */
function buildHevcSps(opts = {}) {
  const {
    maxSubLayers = 0, width = 1920, height = 1080,
    chromaFormatIdc = 1, conformance = false,
    bitDepthLumaMinus8 = 0, bitDepthChromaMinus8 = 0, temporalIdNesting = 1,
  } = opts;
  const w = new BitWriter();
  w.writeBits(0x42, 8); w.writeBits(0x01, 8);
  w.writeBits(0, 4);
  w.writeBits(maxSubLayers, 3);
  w.writeBits(temporalIdNesting, 1);
  w.writeBits(1, 8);   // profile_space(2)+tier(1)+profile_idc(5)
  w.writeBits(0, 32);
  w.writeBits(0, 48);
  w.writeBits(93, 8);
  w.writeUE(0);
  w.writeUE(chromaFormatIdc);
  if (chromaFormatIdc === 3) w.writeBits(0, 1);
  w.writeUE(width);
  w.writeUE(height);
  if (conformance) {
    w.writeBits(1, 1);
    w.writeUE(0); w.writeUE(0); w.writeUE(0); w.writeUE(0);
  } else {
    w.writeBits(0, 1);
  }
  w.writeUE(bitDepthLumaMinus8);
  w.writeUE(bitDepthChromaMinus8);
  w.writeBits(1, 1);
  return w.finish();
}

test('NALU 类型判定：h264/hevc nal type 与关键帧判定', () => {
  assert.equal(h264NalType(new Uint8Array([0x65])), 5);   // IDR
  assert.equal(h264NalType(new Uint8Array([0x41])), 1);   // 非 IDR slice
  assert.equal(isH264Keyframe([1, 6, 7]), false);
  assert.equal(isH264Keyframe([1, 5]), true);
  assert.equal(hevcNalType(new Uint8Array([0x26])), 19);  // IDR_W_RADL
  assert.equal(hevcNalType(new Uint8Array([0x44])), 34);  // PPS
  assert.equal(isHevcKeyframe([1, 33, 34]), false);
  assert.equal(isHevcKeyframe([21]), true);   // CRA 上界
  assert.equal(isHevcKeyframe([16]), true);   // BLA_W_LP 下界
  assert.equal(isHevcKeyframe([15, 24]), false);
});

test('H264 SPS 高档位 profile=100：chroma=1 位序对齐', () => {
  const dims = parseH264SpsDimensions(buildH264Sps({ profileIdc: 100, width: 640, height: 352 }));
  assert.deepEqual(dims, { width: 640, height: 352 });
});

test('H264 SPS chroma=3 + scaling matrix：12 组列表（16/64）全消费', () => {
  const dims = parseH264SpsDimensions(
    buildH264Sps({ profileIdc: 100, chromaFormatIdc: 3, scalingMatrix: true, width: 1280, height: 720 })
  );
  assert.deepEqual(dims, { width: 1280, height: 720 });
});

test('H264 SPS pocType=0 / pocType=1 分支', () => {
  assert.deepEqual(parseH264SpsDimensions(buildH264Sps({ pocType: 0 })), { width: 320, height: 240 });
  assert.deepEqual(parseH264SpsDimensions(buildH264Sps({ pocType: 1 })), { width: 320, height: 240 });
});

test('H264 SPS 截断：catch 返回 null', () => {
  assert.equal(parseH264SpsDimensions(buildH264Sps({ profileIdc: 100, scalingMatrix: true }).slice(0, 6)), null);
});

test('HEVC SPS conformance window：四个 ue 偏移被消费', () => {
  assert.deepEqual(parseHevcSpsDimensions(buildHevcSps({ conformance: true })), { width: 1920, height: 1080 });
});

test('HEVC SPS 截断：parseHevcSpsDimensions catch 返回 null', () => {
  assert.equal(parseHevcSpsDimensions(buildHevcSps().slice(0, 4)), null);
});

test('parseHevcSpsConfig：色深/嵌套/conformance 全字段读取', () => {
  assert.deepEqual(
    parseHevcSpsConfig(buildHevcSps({ temporalIdNesting: 1 })),
    { chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0, temporalIdNesting: 1 }
  );
  assert.deepEqual(
    parseHevcSpsConfig(buildHevcSps({ chromaFormatIdc: 3, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2, conformance: true })),
    { chromaFormatIdc: 3, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2, temporalIdNesting: 1 }
  );
});

test('parseHevcSpsConfig：多层流抛错降级 null / 截断 null', () => {
  assert.equal(parseHevcSpsConfig(buildHevcSps({ maxSubLayers: 1 })), null);
  assert.equal(parseHevcSpsConfig(buildHevcSps().slice(0, 3)), null);
});
