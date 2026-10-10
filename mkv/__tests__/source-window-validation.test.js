import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferSource, BlobSource, FetchSource } from '../src/source.js';

const bytes = new Uint8Array([1, 2, 3]);
for (const [name, make] of [
  ['buffer', () => new BufferSource(bytes)],
  ['blob', () => new BlobSource(new Blob([bytes]))],
  ['fetch', () => new FetchSource('https://example.invalid/media', { fetchImpl: async () => { throw new Error('unexpected network'); } })],
]) {
  test(`${name}: invalid windows reject before any I/O`, async () => {
    const src = make();
    for (const [offset, length] of [[NaN, 1], [0, NaN], [Infinity, 1], [-1, 1], [0, -1], [0.5, 1], [0, 0.5], [Number.MAX_SAFE_INTEGER, 1]]) {
      await assert.rejects(src.read(offset, length), e => e.code === 'SOURCE_ERROR' && e.detail.reason === 'BAD_RANGE');
    }
  });
  test(`${name}: zero-length windows are safe at EOF`, async () => {
    const src = make();
    assert.equal((await src.read(3, 0)).length, 0);
    src.close();
  });
}

for (const [name, src] of [['buffer', new BufferSource(bytes)], ['blob', new BlobSource(new Blob([bytes]))]]) {
  test(`${name}: exact and EOF short reads retain byte correctness`, async () => {
    assert.deepEqual([...await src.read(0, 2)], [1, 2]);
    assert.deepEqual([...await src.read(2, 4)], [3]);
    await assert.rejects(src.read(3, 1), e => e.code === 'SOURCE_ERROR');
  });
}
