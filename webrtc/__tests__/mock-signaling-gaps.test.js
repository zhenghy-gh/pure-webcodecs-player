/**
 * mock-signaling-gaps.test.js —— mock 信令残余方法补测（wave 159）
 *
 * 覆盖：单通道与回环对的 drainRemoteCandidates（恒返 []）、
 *      回环对 sendCandidate 推送到出线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockSignalChannel, createLoopbackSignalPair } from '../src/mock-signaling.js';

test('createMockSignalChannel：drainRemoteCandidates 恒返空数组', () => {
  const ch = createMockSignalChannel(() => 'v=0\r\nanswer');
  assert.deepEqual(ch.drainRemoteCandidates(), []);
});

test('createLoopbackSignalPair：sendCandidate 入出线；drainRemoteCandidates 恒空', async () => {
  const pair = createLoopbackSignalPair({
    aToB: () => 'v=0\r\nanswer-from-a',
    bToA: () => 'v=0\r\nanswer-from-b',
  });
  await pair.sideA.sendCandidate({ candidate: 'cand:A' });
  await pair.sideB.sendCandidate({ candidate: 'cand:B' });
  // wireA 为 A→B 出线：含 A 发的 candidate
  assert.deepEqual(pair.wireA, [{ candidate: 'cand:A' }]);
  assert.deepEqual(pair.wireB, [{ candidate: 'cand:B' }]);
  assert.deepEqual(pair.sideA.drainRemoteCandidates(), []);
  assert.deepEqual(pair.sideB.drainRemoteCandidates(), []);
});
