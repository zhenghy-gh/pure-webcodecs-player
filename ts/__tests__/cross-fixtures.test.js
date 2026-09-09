/**
 * 与共享 fixtures 库（samples/fixtures，sdet 维护）的交叉验证。
 * 契约 API 口径（CONTRACTS v0.2）：createDemuxer/open/samples/µs。
 * 源级导入、完全确定性；库不可用时跳过而不是失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTsDemuxer } from '../src/ts-demuxer.js';

let makeTS;
try {
  ({ makeTS } = await import('../../samples/fixtures/index.js'));
} catch {
  makeTS = null;
}

if (makeTS) {
  test('交叉验证：共享库 makeTS 基础流（probe/open/samples/µs）', async () => {
    const bytes = makeTS({ auCount: 4 }).bytes;
    const d = await createTsDemuxer(bytes);
    assert.equal(d.mediaInfo.container, 'ts');
    // 共享库样例不含带内 SPS/PPS：按契约 §3 降级为基础串 avc1（禁止编造 profile）
    assert.match(d.tracks[0].codec, /^avc1/);
    const v = [];
    for await (const s of d.samples(d.tracks[0].id)) v.push(s);
    assert.equal(v.length, 4);
    // 共享库默认 ptsStep=3000 ticks @90kHz → 步进恰为 round(3000×1e6/90000)=33333µs
    assert.deepEqual(v.slice(0, 3).map((s) => s.timestamp - v[0].timestamp), [0, 33333, 66667]);   // 绝对值就近取整：6000 ticks→66667µs
    await d.destroy();
  });

  test('交叉验证：含 AAC 音频的混合流（numberOfChannels/description 契约字段）', async () => {
    const bytes = makeTS({ auCount: 6, withAudio: true }).bytes;
    const d = await createTsDemuxer(bytes);
    const codecs = d.tracks.map((t) => t.codec.split('.')[0]).sort();
    assert.deepEqual(codecs, ['avc1', 'mp4a']);
    const audio = d.tracks.find((t) => t.type === 'audio');
    assert.ok(audio.sampleRate > 0);
    assert.ok(audio.numberOfChannels >= 1);
    assert.ok(audio.description instanceof Uint8Array);   // AudioSpecificConfig
    let aCount = 0;
    for await (const s of d.samples(audio.id)) { aCount++; assert.equal(s.duration > 0, true); }
    assert.ok(aCount >= 3);
    await d.destroy();
  });

  test('交叉验证：PES 带 AF 填充（auPadBytes）不破坏解析', async () => {
    const bytes = makeTS({ auCount: 5, auPadBytes: 64 }).bytes;
    const d = await createTsDemuxer(bytes);
    let n = 0;
    for await (const s of d.samples(d.tracks[0].id)) n++;
    assert.equal(n, 5);
    await d.destroy();
  });
} else {
  test('跳过：samples/fixtures 库不可用', () => { assert.ok(true); });
}
