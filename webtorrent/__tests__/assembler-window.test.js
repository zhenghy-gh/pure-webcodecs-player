import test from 'node:test';
import assert from 'node:assert/strict';
import { TorrentAssembler } from '../src/assembler.js';

test('assembler rejects non-safe read windows without hanging', async () => {
  const a = new TorrentAssembler({ size: 4, pieceLength: 2 });
  for (const [offset, length] of [[NaN, 1], [0, NaN], [0.5, 1], [0, 0.5], [Number.MAX_SAFE_INTEGER, 2]]) {
    await assert.rejects(a.read(offset, length), e => e.code === 'SOURCE_ERROR');
    assert.equal(a.canReadNow(offset, length), false);
  }
});

test('assembler supports zero-length reads and preserves partial EOF reads', async () => {
  const a = new TorrentAssembler({ size: 3, pieceLength: 2 });
  assert.deepEqual([...await a.read(0, 0)], []);
  assert.equal(a.writePiece(0, new Uint8Array([7, 8])), true);
  assert.equal(a.writePiece(1, new Uint8Array([9])), true);
  assert.deepEqual([...await a.read(1, 5)], [8, 9]);
  await assert.rejects(a.read(3, 1), e => e.code === 'SOURCE_ERROR');
});
