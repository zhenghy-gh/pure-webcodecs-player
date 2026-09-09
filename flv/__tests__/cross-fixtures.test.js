/**
 * 与共享 fixtures 库（samples/fixtures，sdet 维护）的交叉验证。
 * 契约 API 口径（CONTRACTS v0.2）：createDemuxer/open/samples/µs。
 * 源级导入、完全确定性；库不可用时跳过而不是失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFlvDemuxer } from '../src/flv-demuxer.js';

let makeFLV;
try {
  ({ makeFLV } = await import('../../samples/fixtures/index.js'));
} catch {
  makeFLV = null;
}

if (makeFLV) {
  test('交叉验证：共享库 tiny/basic 形态均可解析（契约字段）', async () => {
    const cases = [
      ['tiny', makeFLV({ frameCount: 1 })],
      ['basic', makeFLV({ frameCount: 6 })],
    ];
    for (const [name, made] of cases) {
      const bytes = made.bytes instanceof Uint8Array ? made.bytes : new Uint8Array(made.bytes);
      const d = await createFlvDemuxer(bytes);
      assert.equal(d.mediaInfo.container, 'flv');
      const v = d.tracks.find((t) => t.type === 'video');
      assert.ok(v && v.codec.startsWith('avc1.'), `${name}: 应有 H.264 轨道`);
      assert.equal(v.bitstreamFormat, 'avc');
      await d.destroy();
    }
  });

  test('交叉验证：av 样本轨道为 H.264+AAC 且样本计数吻合', async () => {
    const made = makeFLV({ hasAudio: true, frameCount: 8 });
    const u8 = made.bytes instanceof Uint8Array ? made.bytes : new Uint8Array(made.bytes);
    const d = await createFlvDemuxer(u8);
    const codecs = d.tracks.map((t) => t.codec.split('.')[0]).sort();
    assert.deepEqual(codecs, ['avc1', 'mp4a']);
    let vn = 0;
    for await (const s of d.samples(1)) vn++;
    assert.equal(vn, 8);
    let an = 0;
    for await (const s of d.samples(2)) an++;
    assert.ok(an > 0);
    await d.destroy();
  });
} else {
  test('跳过：samples/fixtures 库不可用', () => { assert.ok(true); });
}
