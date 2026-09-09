import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, emulationPrevent } from '../src/media/bitwriter.js';

test('writeBits 定长位写入（高位在前）', () => {
  const w = new BitWriter();
  w.writeBits(0b1011_0001, 8);
  w.writeBits(0b111, 3);
  const out = w.toUint8Array();
  assert.equal(out.length, 2);
  assert.equal(out[0], 0xb1);
  assert.equal(out[1], 0b1110_0000); // 余位补 0
});

test('writeUE 指数哥伦布标准编码', () => {
  // 0→"1"、1→"010"、2→"011"、6→"00111"
  const cases = [
    [0, [0x80]],
    [1, [0x40]],
    [2, [0x60]],
    [6, [0x38]],
  ];
  for (const [value, expected] of cases) {
    const w = new BitWriter();
    w.writeUE(value);
    assert.deepEqual(Array.from(w.toUint8Array()), expected, `ue(${value})`);
  }
});

test('writeSE 映射规则 k=2n-1 / -2n', () => {
  // se(0)=ue(0)="1"；se(1)=ue(1)="010"；se(-1)=ue(2)="011"
  expectSe(0, [0x80]);
  expectSe(1, [0x40]);
  expectSe(-1, [0x60]);
  function expectSe(v, expected) {
    const w = new BitWriter();
    w.writeSE(v);
    assert.deepEqual(Array.from(w.toUint8Array()), expected);
  }
});

test('rbspTrailing 恰好补一个 1 再对齐', () => {
  const w = new BitWriter();
  w.writeBits(0b101, 3);
  w.rbspTrailing(); // → 101 1 00000 = 0xb0
  assert.deepEqual(Array.from(w.toUint8Array()), [0xb0]);
});

test('emulationPrevent：两连零后跟 ≤3 字节需插入 0x03', () => {
  assert.deepEqual(
    Array.from(emulationPrevent(Uint8Array.from([1, 0, 0, 0]))),
    [1, 0, 0, 3, 0],
  );
  assert.deepEqual(
    Array.from(emulationPrevent(Uint8Array.from([0, 0, 1]))),
    [0, 0, 3, 1],
  );
  assert.deepEqual(
    Array.from(emulationPrevent(Uint8Array.from([0, 0, 4, 5]))),
    [0, 0, 4, 5],
  );
  // 已有 EPB 字节也要再防：0,0,3 → 0,0,3,3
  assert.deepEqual(
    Array.from(emulationPrevent(Uint8Array.from([0, 0, 3]))),
    [0, 0, 3, 3],
  );
});
