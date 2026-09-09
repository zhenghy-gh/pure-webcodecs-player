/**
 * ape/__tests__/fixture.test.js — gen.mjs 生成文件的容器/标签集成验证
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFix } from './helpers.mjs';
import { probeApe, summarizeApe } from '../src/index.js';

describe('gen.mjs fixture 集成', () => {
  test('sample-basic.ape：probe 命中、容器字段与标签/封面齐全', async () => {
    const bytes = await readFix('sample-basic.ape');
    assert.ok(probeApe(bytes));

    const { info, tag, cover } = summarizeApe(bytes);
    assert.equal(info.version, 3990);
    assert.equal(info.kind, 'descriptor');
    assert.equal(info.compressionLevel, 'normal');
    assert.equal(info.totalFrames, 10);
    assert.ok(info.durationUs > 0);

    assert.equal(tag?.version, 2000);
    assert.equal(tag.items.length, 3);
    assert.equal(tag.items.find(i => i.key === 'Title')?.value, 'fixture 曲目');
    assert.equal(cover?.mime, 'image/png');
    assert.deepEqual([...cover.data], [0x89, 0x50]);
  });
});
