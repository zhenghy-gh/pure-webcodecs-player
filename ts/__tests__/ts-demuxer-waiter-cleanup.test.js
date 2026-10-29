import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TsDemuxer } from '../src/ts-demuxer.js';

for (const event of ['tracks', 'complete']) {
  test(`_waitForTracks removes the alternate listener after ${event}`, async () => {
    const demuxer = new TsDemuxer();
    const eventCounts = () => ['tracks', 'complete'].map(
      (name) => demuxer.engine._handlers.get(name)?.size ?? 0,
    );
    const before = eventCounts();

    const waiting = demuxer._waitForTracks();
    demuxer.engine.emit(event);
    await waiting;

    assert.deepEqual(eventCounts(), before);
  });
}
