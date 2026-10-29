import test from 'node:test';
import assert from 'node:assert/strict';

import { TorrentAssembler } from '../src/assembler.js';

const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

test('TorrentAssembler rejects unsafe size and pieceLength', () => {
  assert.throws(
    () => new TorrentAssembler({ size: unsafeInteger, pieceLength: 16 }),
    (error) => error.code === 'PARSE_ERROR',
  );
  assert.throws(
    () => new TorrentAssembler({ size: 32, pieceLength: unsafeInteger }),
    (error) => error.code === 'PARSE_ERROR',
  );
});

test('TorrentAssembler read rejects unsafe offset and length', async () => {
  const assembler = new TorrentAssembler({ size: 32, pieceLength: 32 });
  assert.equal(assembler.writePiece(0, new Uint8Array(32)), true);

  await assert.rejects(
    assembler.read(unsafeInteger, 1),
    (error) => error.code === 'SOURCE_ERROR' && /read 参数非法/.test(error.message),
  );
  await assert.rejects(
    assembler.read(0, unsafeInteger),
    (error) => error.code === 'SOURCE_ERROR' && /read 参数非法/.test(error.message),
  );
});
