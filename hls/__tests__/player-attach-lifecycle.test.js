import test from 'node:test';
import assert from 'node:assert/strict';
import { HlsPlayer } from '../src/player.js';

function makeVideo() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
  };
}

test('HlsPlayer：重复 attach 取消旧请求与定时器', async () => {
  const player = new HlsPlayer();
  player.mse = { attach: async () => {}, destroy() {} };
  player.loadSource = async () => {};
  await player.attach('http://x/first.m3u8', makeVideo());
  const firstAbort = player._abortCtrl;
  let pollCleared = false;
  let bufferCleared = false;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = timer => {
    if (timer === player._pollTimer) pollCleared = true;
    if (timer === player._t_bufferfull) bufferCleared = true;
    originalClearTimeout(timer);
  };
  try {
    await player.attach('http://x/second.m3u8', makeVideo());
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(firstAbort.signal.aborted, true);
  assert.equal(pollCleared, true);
  assert.equal(bufferCleared, true);
});

test('HlsPlayer：重复 attach 移除旧 video waiting 监听，destroy 清理最新 video', async () => {
  const player = new HlsPlayer();
  player.mse = { attach: async video => { player.mse.video = video; }, destroy() {} };
  const first = makeVideo();
  const second = makeVideo();

  player.loadSource = async () => {};
  await player.attach('http://x/first.m3u8', first);
  assert.equal(first.listenerCount('waiting'), 1);

  await player.attach('http://x/second.m3u8', second);
  assert.equal(first.listenerCount('waiting'), 0);
  assert.equal(second.listenerCount('waiting'), 1);

  player.destroy();
  assert.equal(first.listenerCount('waiting'), 0);
  assert.equal(second.listenerCount('waiting'), 0);
});
