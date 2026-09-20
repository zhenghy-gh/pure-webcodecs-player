/**
 * FlvTagStream 残余分支补测（133 波）：
 * reset() 状态归零、可重新从头解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FlvTagStream } from '../src/tag-stream.js';

/** 最小 FLV 头（hasVideo）+ PreviousTagSize0 */
function prologue() {
  return new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]);
}

test('reset()：全部状态归零，可重新从头解析', () => {
  const ts = new FlvTagStream();
  // 一个完整 script tag（type=18, dataSize=1）：11 头 + 1 数据 + 4 PreviousTagSize
  const tag = new Uint8Array([18, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0xaa, 0, 0, 0, 0]);
  const out = ts.push(new Uint8Array([...prologue(), ...tag]));
  assert.equal(out.length, 1);
  assert.ok(ts.headerDone);
  ts.reset();
  assert.equal(ts.buffer.length, 0);
  assert.equal(ts.header, null);
  assert.equal(ts.headerDone, false);
  assert.equal(ts.finished, false);
  assert.equal(ts._absPos, 0);
  // reset 后同一段字节可重新解析
  const out2 = ts.push(new Uint8Array([...prologue(), ...tag]));
  assert.equal(out2.length, 1);
  assert.equal(out2[0].type, 18);
  assert.deepEqual([...out2[0].data], [0xaa]);
});

/* 登记不硬造：tag-stream.js:106-107「dataSize > 128MB」守卫结构性不可达——
 * dataSize 由 3 字节拼出（24 位上限 0xFFFFFF≈16MB），永远小于阈值；
 * 收紧阈值会改变现有行为（16MB 内 Tag 均合法放行），维持现状登记。 */
