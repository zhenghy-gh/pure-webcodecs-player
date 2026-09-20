/**
 * aac.js 残余分支补测（130 波）：
 * splitAdtsFrames 假同步码跳过、splitLatmUnits 非同步/零长度跳过、
 * parseLatmSyncStream ASC 定位失败抛错 → 外层 catch 降级、
 * 合法 ASC 但 slotBytes=0 → {asc, payload:null}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitAdtsFrames, splitLatmUnits, parseLatmSyncStream } from '../src/aac.js';
import { adtsFrame } from './fixtures/build-ts.mjs';

test('splitAdtsFrames：假同步码（channelConfig=0）→ pos++ 继续找真帧', () => {
  const fake = new Uint8Array([0xff, 0xf1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const real = adtsFrame(new Uint8Array(20).fill(7));
  const data = new Uint8Array(fake.length + real.length);
  data.set(fake, 0);
  data.set(real, fake.length);
  const frames = splitAdtsFrames(data);
  assert.equal(frames.length, 1, `应只切出真帧，实际 ${frames.length}`);
  assert.equal(frames[0].header.samplingRate, 44100);
  assert.deepEqual([...frames[0].raw], [...real.subarray(7)]);
});

/** 构造 LATM AudioSyncStream 单元（audioMuxVersion=0 / frameLengthType=0） */
function latmChunk({ ascBytes, tail }) {
  // bits: sync(11)=0x2b7 | muxLen(13)=0 | useSame(1)=0 | amv(1)=0 | allSame(1)=0
  //       | numSub(6)=0 | numProg(4)=0 | numLayer(3)=0 | [ASC 区] | flt(3)=0
  //       | slot(6)=0 | PLI(8)=0
  return new Uint8Array([0x56, 0xe0, 0x00, 0x00, 0x00, ...ascBytes, ...tail]);
}

test('parseLatmSyncStream：ASC 定位失败 → 抛错被外层 catch → {asc:null,payload:null}', () => {
  // ASC 窗口内全 1 → 每个 delta 的采样率索引恒为 15（保留），扫描耗尽 → null
  const chunk = new Uint8Array([0x56, 0xe0, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(parseLatmSyncStream(chunk), { asc: null, payload: null });
});

test('parseLatmSyncStream：合法 ASC 但 PayloadLengthInfo=0 → {asc, payload:null}', () => {
  // ASC = aot=2(LC), idx=4(44100), ch=2 → 字节 0x12 0x20
  const chunk = latmChunk({ ascBytes: [0x12, 0x20], tail: [0x00, 0x00, 0x00] });
  const out = parseLatmSyncStream(chunk);
  assert.ok(out.asc instanceof Uint8Array);
  assert.deepEqual([...out.asc], [0x12, 0x20]);
  assert.equal(out.payload, null);
});

test('splitLatmUnits：非同步字节 pos++、零长度单元跳过、合法单元正常解出', () => {
  const unit = new Uint8Array([0x56, 0xe0, 0x07, 0x00, 0x00, 0x12, 0x20, 0x00, 0x00, 0x00]);
  const data = new Uint8Array([0xaa, ...unit, 0x56, 0xe0, 0x00]);
  const units = splitLatmUnits(data);
  assert.equal(units.length, 1, `应只解出 1 个合法单元，实际 ${units.length}`);
  assert.ok(units[0].asc instanceof Uint8Array);
  assert.equal(units[0].payload, null); // PLI=0 → 无负载
});
