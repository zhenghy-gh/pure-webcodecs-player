/**
 * ape/__tests__/ape-compression.test.js — 压缩级别映射与代码透传（node --test）
 * 覆盖 COMPRESSION_LEVEL 全量码表 + 未知码兜底 + compressionCode 透传。
 * 聚焦 mac-parser.js 的纯函数映射，离线内联 fixture，零依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMacHeader,
  COMPRESSION_LEVEL,
} from '../src/index.js';

/* ---- 内联 fixture：标准 64B descriptor 文件 ---- */
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

const EXPECTED = Object.freeze({
  3000: 'insane', 3001: 'braindead',
  4000: 'fast', 4001: 'normal', 4002: 'high', 4003: 'extra-high',
});

describe('COMPRESSION_LEVEL 码表', () => {
  test('导出冻结对象含全部 6 个码（快速校验契约）', () => {
    assert.ok(Object.isFrozen(COMPRESSION_LEVEL));
    assert.deepEqual(COMPRESSION_LEVEL, EXPECTED);
  });
});

describe('压缩级别映射（经 parseMacHeader 路径）', () => {
  for (const [code, name] of Object.entries(EXPECTED)) {
    test(`descriptor 路径：code ${code} → "${name}"`, () => {
      const info = parseMacHeader(buildDescriptorFile({ compression: Number(code) }));
      assert.equal(info.compressionCode, Number(code));
      assert.equal(info.compressionLevel, name);
    });
  }

  test('legacy 路径同样走同源映射（code 3001 → braindead）', () => {
    const b = new Uint8Array(16);
    const dv = new DataView(b.buffer);
    for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
    dv.setUint16(4, 3950, true);
    dv.setUint16(6, 3001, true);   // braindead
    dv.setUint16(8, 0x02, true);
    dv.setUint16(10, 2, true);
    dv.setUint32(12, 44100, true);
    const info = parseMacHeader(b);
    assert.equal(info.compressionLevel, 'braindead');
  });
});

describe('未知压缩码兜底', () => {
  for (const code of [4711, 3999, 5000, 9999]) {
    test(`code ${code} → "code-${code}"`, () => {
      const info = parseMacHeader(buildDescriptorFile({ compression: code }));
      assert.equal(info.compressionCode, code);
      assert.equal(info.compressionLevel, `code-${code}`);
    });
  }
});
