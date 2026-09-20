/**
 * core/nal.js 残余分支补测（132 波）：
 * 空 NAL 单元拒绝、splitAnnexB 零拷贝切片、annexbToAvcc/splitAvcc 非法 lengthSize、
 * splitAvcc 尾部垃圾拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scanAnnexBNalUnits, splitAnnexB, annexbToAvcc, splitAvcc } from '../src/nal.js';

test('scanAnnexBNalUnits：空 NAL 单元（起始码紧邻）→ PARSE_ERROR', () => {
  assert.throws(
    () => scanAnnexBNalUnits(new Uint8Array([0, 0, 1, 0, 0, 1])),
    (e) => e.code === 'PARSE_ERROR' && /empty nal unit/.test(e.message),
  );
  // 尾部起始码后无负载同样视为空单元
  assert.throws(
    () => scanAnnexBNalUnits(new Uint8Array([0, 0, 1, 5, 0, 0, 1])),
    (e) => /empty nal unit/.test(e.message),
  );
});

test('splitAnnexB：零拷贝切片与 scan 结果一致', () => {
  const data = new Uint8Array([0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 4, 5]);
  const units = splitAnnexB(data);
  assert.equal(units.length, 2);
  assert.deepEqual([...units[0]], [0x67, 1, 2, 3]);
  assert.deepEqual([...units[1]], [0x68, 4, 5]);
  // 零拷贝：切片与源共享内存
  assert.equal(units[0].buffer, data.buffer);
});

test('annexbToAvcc：lengthSize 越界 → PARSE_ERROR', () => {
  for (const bad of [0, 5]) {
    assert.throws(
      () => annexbToAvcc(new Uint8Array([0, 0, 1, 1]), bad),
      (e) => e.code === 'PARSE_ERROR' && new RegExp(`invalid nal length size: ${bad}`).test(e.message),
    );
  }
});

test('splitAvcc：lengthSize 越界 → PARSE_ERROR', () => {
  for (const bad of [0, 5]) {
    assert.throws(
      () => splitAvcc(new Uint8Array(8), bad),
      (e) => e.code === 'PARSE_ERROR' && new RegExp(`invalid nal length size: ${bad}`).test(e.message),
    );
  }
});

test('splitAvcc：尾部垃圾（不足一个长度字段）→ PARSE_ERROR', () => {
  // lengthSize=4：一个完整单元（1B）+ 3 字节垃圾（不足 4 字节长度头）
  const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xde, 0xad, 0xbe]);
  assert.throws(
    () => splitAvcc(data, 4),
    (e) => e.code === 'PARSE_ERROR' && /trailing garbage in avcc stream: 3 bytes/.test(e.message),
  );
});
