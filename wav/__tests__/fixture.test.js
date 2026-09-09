/**
 * wav/__tests__/fixture.test.js — gen.mjs 生成文件的最小合法性与解析集成验证
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFix } from './helpers.mjs';
import { parseWavHeader, WavDemuxer } from '../src/index.js';

describe('gen.mjs fixture 集成', () => {
  test('sample-basic.wav：头字段与时长正确', async () => {
    const bytes = await readFix('sample-basic.wav');
    const h = parseWavHeader(bytes);
    assert.equal(h.format.channels, 1);
    assert.equal(h.format.sampleRate, 8000);
    assert.equal(h.codec, 'pcm-s16');
    assert.equal(h.format.bitsPerSample, 16);
    assert.ok(h.durationUs > 0);
  });

  test('sample-f32-stereo.wav：float 立体声识别', async () => {
    const h = parseWavHeader(await readFix('sample-f32-stereo.wav'));
    assert.equal(h.codec, 'pcm-f32');
    assert.equal(h.format.channels, 2);
    assert.equal(h.format.sampleRate, 48000);
  });

  test('fixture 可经 WavDemuxer 完整迭代', async () => {
    const bytes = await readFix('sample-basic.wav');
    const dem = new WavDemuxer({
      size: bytes.length,
      async read(o, l) { return bytes.subarray(o, o + l); },
      async close() {},
    });
    const mi = await dem.parseInit();
    let n = 0;
    for await (const s of dem.samples(1)) { assert.equal(s.codec, 'pcm-s16'); n++; }
    assert.ok(n >= 1 && mi.durationUs > 0);
    await dem.stop();
  });
});
