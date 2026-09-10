/**
 * ape/__tests__/ape-validation.test.js — 容器字段校验分支（node --test）
 * 覆盖 mac-parser.js 内 validate() 的声道/采样率/总帧数合法边界与非法拒绝。
 * 现有测试仅覆盖 channels=99；此处补齐 sampleRate 上下界、channels 0/9、
 * totalFrames=0 以及各合法极值通过路径。离线内联 fixture。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMacHeader } from '../src/index.js';

function buildDescriptorFile(opt = {}) {
  const b = new Uint8Array(76);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, opt.version ?? 3990, true);
  dv.setUint32(8, 52, true);      // nDescriptorBytes
  dv.setUint32(12, 24, true);     // nHeaderBytes
  dv.setUint32(16, 0, true);      // nSeekTableBytes
  dv.setUint32(20, 0, true);      // nHeaderDataBytes
  dv.setUint32(24, 100000, true); // nAPEFrameDataBytes（低 32）
  dv.setUint32(28, 0, true);
  dv.setUint32(32, 0, true);      // nTerminatingDataBytes
  let p = 52;
  dv.setUint16(p, opt.compression ?? 4001, true); p += 2;
  dv.setUint16(p, opt.flags ?? 0x02, true); p += 2;
  dv.setUint32(p, opt.blocksPerFrame ?? 73728, true); p += 4;
  dv.setUint32(p, opt.finalBlocks ?? 12345, true); p += 4;
  dv.setUint32(p, opt.totalFrames ?? 10, true); p += 4;
  dv.setUint16(p, opt.bps ?? 16, true); p += 2;
  dv.setUint16(p, opt.channels ?? 2, true); p += 2;
  dv.setUint32(p, opt.sampleRate ?? 44100, true);
  return b;
}

function buildLegacyFile(opt = {}) {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, opt.version ?? 3950, true);
  dv.setUint16(6, opt.compression ?? 4000, true);
  dv.setUint16(8, opt.flags ?? 0x02, true);
  dv.setUint16(10, opt.channels ?? 2, true);
  dv.setUint32(12, opt.sampleRate ?? 44100, true);
  return b;
}

describe('合法边界：不应抛错', () => {
  test('descriptor：采样率上下界、声道 1/8、总帧数 1', () => {
    assert.doesNotThrow(() => parseMacHeader(buildDescriptorFile({ sampleRate: 1000 })));
    assert.doesNotThrow(() => parseMacHeader(buildDescriptorFile({ sampleRate: 384000 })));
    assert.doesNotThrow(() => parseMacHeader(buildDescriptorFile({ channels: 1, totalFrames: 1 })));
    assert.doesNotThrow(() => parseMacHeader(buildDescriptorFile({ channels: 8, totalFrames: 1 })));
  });
  test('legacy：采样率上下界、声道 1/8 通过', () => {
    assert.doesNotThrow(() => parseMacHeader(buildLegacyFile({ sampleRate: 1000 })));
    assert.doesNotThrow(() => parseMacHeader(buildLegacyFile({ sampleRate: 384000 })));
    assert.doesNotThrow(() => parseMacHeader(buildLegacyFile({ channels: 1 })));
    assert.doesNotThrow(() => parseMacHeader(buildLegacyFile({ channels: 8 })));
  });
});

describe('非法采样率：拒绝 PARSE_ERROR', () => {
  test('descriptor：采样率过低(999)', () => {
    assert.throws(() => parseMacHeader(buildDescriptorFile({ sampleRate: 999 })),
      (e) => e.code === 'PARSE_ERROR');
  });
  test('descriptor：采样率过高(384001)', () => {
    assert.throws(() => parseMacHeader(buildDescriptorFile({ sampleRate: 384001 })),
      (e) => e.code === 'PARSE_ERROR');
  });
  test('legacy：采样率过低/过高同样拒绝', () => {
    assert.throws(() => parseMacHeader(buildLegacyFile({ sampleRate: 999 })),
      (e) => e.code === 'PARSE_ERROR');
    assert.throws(() => parseMacHeader(buildLegacyFile({ sampleRate: 384001 })),
      (e) => e.code === 'PARSE_ERROR');
  });
});

describe('非法声道数：拒绝 PARSE_ERROR', () => {
  test('descriptor：channels=0 与 channels=9', () => {
    assert.throws(() => parseMacHeader(buildDescriptorFile({ channels: 0 })),
      (e) => e.code === 'PARSE_ERROR');
    assert.throws(() => parseMacHeader(buildDescriptorFile({ channels: 9 })),
      (e) => e.code === 'PARSE_ERROR');
  });
  test('legacy：channels=0 与 channels=9', () => {
    assert.throws(() => parseMacHeader(buildLegacyFile({ channels: 0 })),
      (e) => e.code === 'PARSE_ERROR');
    assert.throws(() => parseMacHeader(buildLegacyFile({ channels: 9 })),
      (e) => e.code === 'PARSE_ERROR');
  });
});

describe('非法总帧数：totalFrames=0 拒绝', () => {
  test('descriptor：totalFrames=0 触发 PARSE_ERROR', () => {
    assert.throws(() => parseMacHeader(buildDescriptorFile({ totalFrames: 0 })),
      (e) => e.code === 'PARSE_ERROR');
  });
  test('legacy：路径不校验 totalFrames（恒为 null，不抛）', () => {
    assert.doesNotThrow(() => parseMacHeader(buildLegacyFile({ version: 3950 })));
  });
});
