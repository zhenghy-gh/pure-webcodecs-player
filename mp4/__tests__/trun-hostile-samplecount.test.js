/**
 * mp4 parseTrun 敌意 sample_count 回归（fuzz 波次发现，第二百零八波收口）。
 *
 * 缺陷：flags 未设任何 per-sample 位（0x100/0x200/0x400/0x800 全 0）时，样本行 循环
 * 每次零消费却仍跑 sampleCount（可达 0xFFFFFFFF）次 → 无界循环挂起/OOM。
 * 修复：stride===0 以 DEFAULT_MAX_TRUN_SAMPLES 钳制——注意不能清零：规范语义下
 * 全 undefined 行交由下游 tfhd/trex 默认回退（丢行 = 丢样本）；stride>0 时
 * 逐字段 readU32 越界抛受控 sourceError（有界）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream } from '../../core/src/index.js';
import { DEFAULT_MAX_TRUN_SAMPLES } from '../../core/src/limits.js';
import { parseTrun } from '../src/box-parser.js';

function trunContent(version, flags, sampleCount, perSample = []) {
  const out = new Uint8Array(8 + perSample.length);
  const dv = new DataView(out.buffer);
  out[0] = version;
  dv.setUint8(1, (flags >> 16) & 0xff);
  dv.setUint8(2, (flags >> 8) & 0xff);
  dv.setUint8(3, flags & 0xff);
  dv.setUint32(4, sampleCount >>> 0);
  out.set(perSample, 8);
  return out;
}

test('parseTrun：sample_count 巨大且无 per-sample 标志不得挂起，钳到行数上界', () => {
  const s = new ByteStream(trunContent(0, 0x000000, 0xffffffff));
  const t0 = Date.now();
  const r = parseTrun(s);
  assert.ok(Date.now() - t0 < 2000, '不得进入无界循环');
  assert.equal(r.samples.length, DEFAULT_MAX_TRUN_SAMPLES, '钳到上界而非清零（清零=丢样本）');
  assert.equal(r.sampleCount, 0xffffffff, 'sample_count 原样回显');
});

test('parseTrun：仅 dataOffset/firstSampleFlags（stride 仍为 0）同样钳到上界', () => {
  const s = new ByteStream(trunContent(0, 0x000001 | 0x000004, 0xffffffff, [0, 0, 0, 8, 0, 0, 0, 0]));
  const t0 = Date.now();
  const r = parseTrun(s);
  assert.ok(Date.now() - t0 < 2000, '不得进入无界循环');
  assert.equal(r.samples.length, DEFAULT_MAX_TRUN_SAMPLES);
});

test('parseTrun：stride=0 但 sampleCount 合法 → 逐行 undefined 字段（tfhd 默认回退语义）', () => {
  const s = new ByteStream(trunContent(0, 0x000001, 3, [0, 0, 0, 8]));
  const r = parseTrun(s);
  assert.equal(r.samples.length, 3, '小 sampleCount 不得被清零');
  for (const rec of r.samples) {
    assert.equal(rec.duration, undefined);
    assert.equal(rec.size, undefined);
    assert.equal(rec.flags, undefined);
  }
});

test('parseTrun：有效全字段 trun 解析不受影响', () => {
  const flags = 0x000100 | 0x000200; // duration + size
  const body = new Uint8Array(16);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 1003); dv.setUint32(4, 50);
  dv.setUint32(8, 1004); dv.setUint32(12, 60);
  const s = new ByteStream(trunContent(0, flags, 2, body));
  const r = parseTrun(s);
  assert.equal(r.samples.length, 2);
  assert.equal(r.samples[0].duration, 1003);
  assert.equal(r.samples[0].size, 50);
  assert.equal(r.samples[1].duration, 1004);
  assert.equal(r.samples[1].size, 60);
});

test('parseTrun：sample_count 超框体（stride>0）在越界读时抛受控 sourceError', async () => {
  const flags = 0x000100; // 仅 duration，stride=4
  const s = new ByteStream(trunContent(0, flags, 1000, new Uint8Array([0, 0, 1, 0])));
  await assert.rejects(async () => {
    // 同步抛出会以异常冒泡；用 try/catch 归一为 rejection 便于统一断言
    parseTrun(s);
    throw new Error('should-not-reach');
  }, /read overflow|ByteStream|not enough|overflow/i);
});
