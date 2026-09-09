/**
 * flac/__tests__/fixture.test.js — gen.mjs 生成文件的解码往返集成验证
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFix } from './helpers.mjs';
import { FlacDemuxer, FlacDecoder, parseMetadata } from '../src/index.js';

const mem = b => ({ size: b.length, async read(o, l) { return b.subarray(o, o + l); }, async close() {} });

describe('gen.mjs fixture 集成', () => {
  test('sample-basic.flac：元数据与两帧 CONSTANT 解码精确', async () => {
    const bytes = await readFix('sample-basic.flac');
    const meta = parseMetadata(bytes);
    assert.equal(meta.streamInfo.sampleRate, 8000);
    assert.equal(meta.streamInfo.totalSamples, 32);

    const dem = new FlacDemuxer(mem(bytes));
    await dem.parseInit();
    const got = [];
    for await (const s of dem.samples(1)) got.push(s);
    assert.equal(got.length, 2);

    const dec = new FlacDecoder(meta.streamInfo);
    const f1 = dec.decodeFrame(got[0].data, 0);
    assert.equal(f1.blockSize, 16);
    assert.ok([...f1.channels[0]].every(v => v === 100));
    const f2 = dec.decodeFrame(got[1].data, 0);
    assert.ok([...f2.channels[0]].every(v => v === -100));
    await dem.stop();
  });
});
