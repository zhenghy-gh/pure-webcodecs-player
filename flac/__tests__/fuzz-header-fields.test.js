/**
 * flac 头部字段定向 mutation 回归（第二百一十三波）
 * ------------------------------------------------------------
 * STREAMINFO 位域与帧头保留码的定向边界（非随机覆写），三块面：
 *   1. totalSamples 36-bit 语义回归——本波修复 `>>>0` 优先级截断缺陷
 *      （旧式 (A+B)>>>0 把 >2^32-1 的样本数截到 uint32，高 4 位丢失）；
 *   2. STREAMINFO 敌意位域（sr=0/2^20-1、块长 33/35/巨大、last 标志清除、
 *      首块类型替换、魔数破坏）：禁裸抛，成功面数值有限、audioOffset 合法；
 *   3. parseFrameHeader 保留/非法码全枚举（blockSize×sampleRate×channel×
 *      bitsPerSample 组合 + 截断 + 非法 startOffset）：禁裸抛。
 * 探测 .tmp/probe-wavflac.mjs 8219 调用零裸抛后固化。
 * 观察登记（非缺陷）：sampleRate=0 按 FLAC 规范为「由外部提供」合法占位，
 * 解析层不校验、由消费侧兜底——与 wav 头解析「不校验只索引」同一哲学。
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMetadata, parseFrameHeader } from '../src/index.js';

const FLAC = new Uint8Array(readFileSync(new URL('../__tests__/fixtures/sample-basic.flac', import.meta.url)));

/** 对 STREAMINFO（body 起于 fixture 偏移 8）打补丁 */
function patched(patch) {
  const b = FLAC.slice();
  patch(b);
  return b;
}

test('totalSamples 36-bit 语义：高 4 位不得被 >>>0 截断（本波修复回归）', () => {
  // 低 32 位内行为与旧式一致（无高位的既有文件不回归）
  const base = parseMetadata(FLAC).streamInfo;
  assert.ok(base.totalSamples >= 0 && Number.isInteger(base.totalSamples));

  const max = patched((b) => {
    b[8 + 13] = (b[8 + 13] & 0xf0) | 0x0f;             // 高 4 位全 1
    b[8 + 14] = 0xff; b[8 + 15] = 0xff; b[8 + 16] = 0xff; b[8 + 17] = 0xff; // 低 32 全 1
  });
  assert.equal(parseMetadata(max).streamInfo.totalSamples, 2 ** 36 - 1);

  // 混合值：高 4 位=0xF、低位含补码临界 0xFF000000
  const hi = patched((b) => {
    b[8 + 13] = (b[8 + 13] & 0xf0) | 0x0f;
    b[8 + 14] = 0xff; b[8 + 15] = 0x00; b[8 + 16] = 0x00; b[8 + 17] = 0x20;
  });
  assert.equal(parseMetadata(hi).streamInfo.totalSamples, 0xf * 2 ** 32 + 0xff000020);

  // 恰好 2^32：旧式截为 0，修复后保真
  const edge = patched((b) => {
    b[8 + 13] = (b[8 + 13] & 0xf0) | 0x01;
    b[8 + 14] = 0; b[8 + 15] = 0; b[8 + 16] = 0; b[8 + 17] = 0;
  });
  assert.equal(parseMetadata(edge).streamInfo.totalSamples, 2 ** 32);
});

test('STREAMINFO 敌意位域：禁裸抛，成功面数值有限且 audioOffset 合法', () => {
  const patches = [
    ['siLen33', (b) => { b[7] = 33; }],
    ['siLen35', (b) => { b[7] = 35; }],
    ['siLenHuge', (b) => { b[5] = 0x7f; b[6] = 0xff; b[7] = 0xff; }],
    ['sr0', (b) => { b[8 + 10] = 0; b[8 + 11] = 0; b[8 + 12] = b[8 + 12] & 0x0f; }],
    ['srAll1', (b) => { b[8 + 10] = 0xff; b[8 + 11] = 0xff; b[8 + 12] = (b[8 + 12] & 0x0f) | 0xf0; }],
    ['chFull', (b) => { b[8 + 12] = (b[8 + 12] & 0xc1) | 0x7e; }],
    ['bpsMax', (b) => { b[8 + 12] |= 0x01; b[8 + 13] = (b[8 + 13] & 0x0f) | 0xf0; }],
    ['blk0', (b) => { b[8] = 0; b[8 + 1] = 0; b[8 + 2] = 0; b[8 + 3] = 0; }],
    ['noLast', (b) => { b[4] = b[4] & 0x7f; b[5] = 0; b[6] = 0; b[7] = 0; }],
    ['typeSwap', (b) => { b[4] = (b[4] & 0x7f) | 0x40; }],
    ['magicBad', (b) => { b[3] = 0x44; }],
  ];
  let ok = 0;
  for (const [name, patch] of patches) {
    try {
      const r = parseMetadata(patched(patch));
      ok++;
      const si = r.streamInfo;
      if (si) {
        for (const k of ['sampleRate', 'channels', 'bitsPerSample', 'totalSamples', 'minBlockSize', 'maxBlockSize']) {
          assert.ok(Number.isFinite(si[k]) && si[k] >= 0, `${name}: ${k}=${si[k]}`);
        }
      }
      assert.ok(Number.isInteger(r.audioOffset) && r.audioOffset >= 0, `${name}: audioOffset=${r.audioOffset}`);
    } catch (e) {
      assert.ok(e.code, `${name} 裸抛 ${e.constructor.name}: ${e.message}`);
    }
  }
  assert.ok(ok > 0, '全部补丁均被拒绝说明探测面失效');
});

test('parseFrameHeader 保留/非法码全枚举 + 截断 + 非法 offset：禁裸抛', () => {
  const mk = (b1, b2, b3) => new Uint8Array(
    [0xff, 0xf8, b1, b2, b3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  let accepted = 0;
  for (let bs = 0; bs < 16; bs++) {
    for (let sr = 0; sr < 16; sr++) {
      for (const ch of [0, 3, 5, 7, 8, 11, 14, 15]) {
        for (const bits of [0, 5, 6, 7]) {
          try {
            parseFrameHeader(mk((bs << 4) | sr, ch << 1, bits << 5), 0);
            accepted++;
          } catch (e) {
            assert.ok(e.code, `b1=0x${((bs << 4) | sr).toString(16)} 裸抛 ${e.constructor.name}`);
          }
        }
      }
    }
  }
  assert.ok(accepted > 0, '全部码组合均被拒绝说明探测面失效');

  const full = new Uint8Array([0xff, 0xf8, 0x0e, 0x40, 0x0a, 0x42, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
  for (let n = 0; n <= 11; n++) {
    try { parseFrameHeader(full.subarray(0, n), 0); }
    catch (e) { assert.ok(e.code, `截断${n} 裸抛 ${e.constructor.name}`); }
  }
  for (const off of [-1, 1, 5, 13, 999]) {
    try { parseFrameHeader(mk(0x0e, 0x40, 0x00), off); }
    catch (e) { assert.ok(e.code, `offset=${off} 裸抛 ${e.constructor.name}`); }
  }
});

test('正例锚点：完好 fixture 元数据与首帧头解析成功', () => {
  const r = parseMetadata(FLAC);
  assert.equal(r.streamInfo.channels, 1);
  assert.ok(r.streamInfo.sampleRate > 0);
  const { audioOffset } = r;
  parseFrameHeader(FLAC, audioOffset); // 不抛即过
});
