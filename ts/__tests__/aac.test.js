/**
 * AAC 单测：ADTS 解析/切帧、AudioSpecificConfig、LATM(AudioSyncStream)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAdtsHeader, splitAdtsFrames,
  buildAudioSpecificConfig, parseAudioSpecificConfig,
  parseLatmSyncStream, AAC_SAMPLE_RATES,
} from '../src/aac.js';

import { adtsFrame, latmStream } from './fixtures/build-ts.mjs';

test('parseAdtsHeader：基础字段', () => {
  const raw = new Uint8Array(64).fill(0x11);
  const frame = adtsFrame(raw, { sampleRateIndex: 4, channels: 2 });
  const header = parseAdtsHeader(frame);
  assert.ok(header);
  assert.equal(header.samplingRate, 44100);
  assert.equal(header.channels, 2);
  assert.equal(header.headerSize, 7);
  assert.equal(header.frameLength, 7 + raw.length);
  assert.equal(header.aot, 2);   // LC
});

test('splitAdtsFrames：连续多帧切分', () => {
  const frames = [
    adtsFrame(new Uint8Array(30).fill(1)),
    adtsFrame(new Uint8Array(50).fill(2), { sampleRateIndex: 3 }), // 48k
    adtsFrame(new Uint8Array(20).fill(3)),
  ];
  const data = new Uint8Array([...frames[0], ...frames[1], ...frames[2]]);
  const parsed = splitAdtsFrames(data);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].header.samplingRate, AAC_SAMPLE_RATES[4]);
  assert.equal(parsed[1].header.samplingRate, AAC_SAMPLE_RATES[3]);
  assert.deepEqual([...parsed[0].raw], [...new Uint8Array(30).fill(1)]);
});

test('splitAdtsFrames：前导垃圾与截断帧容错', () => {
  const frame = adtsFrame(new Uint8Array(24));
  const garbage = new Uint8Array([0x00, 0x01, 0x02]);
  const truncated = frame.slice(0, frame.length - 5);   // 尾部不完整
  const data = new Uint8Array([...garbage, ...truncated]);
  const parsed = splitAdtsFrames(data);
  assert.equal(parsed.length, 0, '半帧应等待更多数据而不是错误输出');
});

test('AudioSpecificConfig：构造与解析往返（含扩展采样率）', () => {
  const asc = buildAudioSpecificConfig(2, 4, 2);
  assert.equal(asc.length, 2);
  const info = parseAudioSpecificConfig(asc);
  assert.equal(info.aot, 2);
  assert.equal(info.sampleRateIndex, 4);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);

  const ascCustom = buildAudioSpecificConfig(2, 15, 1, 24000);
  assert.equal(ascCustom.length, 5);
  const info2 = parseAudioSpecificConfig(ascCustom);
  assert.equal(info2.sampleRate, 24000);
  assert.equal(info2.channels, 1);
});

test('parseLatmSyncStream：提取 ASC 与裸帧', () => {
  const raw = new Uint8Array(48).fill(0x77);
  const unit = latmStream({ aot: 2, sampleRateIndex: 4, channels: 2, raw });
  const { asc, payload } = parseLatmSyncStream(unit);
  assert.ok(asc, '应解析出 AudioSpecificConfig');
  const info = parseAudioSpecificConfig(asc);
  assert.equal(info.aot, 2);
  assert.equal(info.sampleRate, 44100);
  assert.deepEqual([...(payload ?? [])], [...raw]);
});

test('parseLatmSyncStream：非法同步字返回 null', () => {
  const bad = new Uint8Array(32).fill(0);
  const { payload } = parseLatmSyncStream(bad);
  assert.equal(payload, null);
});

test('parseLatmSyncStream：AOT=7(SBR) 在精确位被正确提取（修复 aot∈[1,6] 误锁）', () => {
  // 旧 tryReadAscBounded 用宽松字段范围判断（aot∈[1,6]）会在 delta=0 拒绝 AOT=7，
  // 转而扫描 ±24 位里的巧合模式导致错位；新实现用 parseAudioSpecificConfig 真校验，
  // AOT=7 属合法 Audio Object Type，应在 delta=0 精确命中。
  const unit = latmStream({ aot: 7, sampleRateIndex: 4, channels: 2, raw: new Uint8Array(48).fill(0x77) });
  const { asc } = parseLatmSyncStream(unit);
  assert.ok(asc, 'AOT=7 应被识别为合法 ASC');
  const info = parseAudioSpecificConfig(asc);
  assert.equal(info.aot, 7);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
});

test('parseLatmSyncStream：sampling_frequency_index=15(escape) 不被误锁为残缺 2 字节 ASC', () => {
  // 旧逻辑对 idx=15 仍通过宽松范围判断，返回 [0x17,0x90] 这类仅含 2 字节的 ASC，
  // 下游 parseAudioSpecificConfig 还要再读 24 位自定义频率 → 越界/产出错误采样率。
  // 新逻辑在 delta=0 显式拒绝 idx=13/14/15，绝不把 idx=15 当合法 ASC 透传。
  const unit = latmStream({ aot: 2, sampleRateIndex: 15, channels: 2, raw: new Uint8Array(48).fill(0xab) });
  const { asc } = parseLatmSyncStream(unit);
  if (asc) {
    // 若存在候选，其采样率索引绝不能是 15（旧逻辑的残缺误锁特征）
    assert.notEqual(parseAudioSpecificConfig(asc).sampleRateIndex, 15, 'idx=15 不得作为合法 ASC 透传');
    // 且绝不等于旧逻辑在 delta=0 产出的 [0x17,0x90]
    assert.notDeepEqual([...asc], [0x17, 0x90]);
  }
});
