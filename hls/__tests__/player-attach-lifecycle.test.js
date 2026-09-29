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

test('HlsPlayer：旧直播轮询成功响应不得覆盖新会话清单', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = new HlsPlayer();
  let resolveText;
  player.loader = {
    loadText: () => new Promise(resolve => { resolveText = resolve; }),
  };
  player.playlistUrl = 'http://x/old.m3u8';
  player.mediaPlaylist = { type: 'media', live: true, targetDuration: 4, segments: [{ sn: 1 }], serverControl: {} };
  player._abortCtrl = new AbortController();
  player._scheduleLivePoll();
  t.mock.timers.tick(2000);

  const oldPlaylist = player.mediaPlaylist;
  player._sessionId += 1;
  player._abortCtrl.abort();
  player._abortCtrl = new AbortController();
  const currentPlaylist = { type: 'media', live: false, segments: [] };
  player.mediaPlaylist = currentPlaylist;
  resolveText(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nold.m4s`);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(player.mediaPlaylist, currentPlaylist);
  assert.notEqual(player.mediaPlaylist, oldPlaylist);
});

test('HlsPlayer：旧直播轮询失败不得向新会话派发错误或续挂定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = new HlsPlayer();
  let rejectText;
  player.loader = {
    loadText: () => new Promise((resolve, reject) => { rejectText = reject; }),
  };
  player.playlistUrl = 'http://x/old.m3u8';
  player.mediaPlaylist = { type: 'media', live: true, targetDuration: 4, segments: [{ sn: 1 }], serverControl: {} };
  player._abortCtrl = new AbortController();
  const errors = [];
  player.on('error', error => errors.push(error));
  player._scheduleLivePoll();
  t.mock.timers.tick(2000);

  player._sessionId += 1;
  player._abortCtrl.abort();
  player._abortCtrl = new AbortController();
  const oldTimer = player._pollTimer;
  player.mediaPlaylist = { type: 'media', live: false, segments: [] };
  rejectText(new Error('old request failed'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(errors.length, 0);
  assert.equal(player._pollTimer, oldTimer);
});


test('HlsPlayer：旧分片响应不得追加到新会话 MSE', async () => {
  const player = new HlsPlayer();
  let resolveSegment;
  let appendCount = 0;
  player.loader = {
    load: () => new Promise(resolve => { resolveSegment = resolve; }),
  };
  player.mse = {
    sourceBuffers: { video: null, audio: null },
    currentBufferSeconds: () => 0,
    addSourceBuffer(type) { this.sourceBuffers[type] = {}; },
    append: async () => { appendCount += 1; },
    getBuffered: () => [],
    endOfStream: async () => {},
  };
  player.transmuxer = {
    process: async data => ({ kind: 'passthrough', mediaSegment: data }),
  };
  player.mediaPlaylist = {
    live: false,
    segments: [{ sn: 7, url: 'http://x/old.m4s', duration: 4 }],
  };
  player._abortCtrl = new AbortController();
  const pending = player._pump();
  await new Promise(resolve => setImmediate(resolve));

  player._sessionId += 1;
  player._abortCtrl.abort();
  player._abortCtrl = new AbortController();
  resolveSegment({ data: new Uint8Array([7]), byteLength: 1 });
  await pending;

  assert.equal(appendCount, 0);
  assert.equal(player._stats.segmentsLoaded, 0);
  assert.equal(player._lastAppendedSn, null);
  assert.equal(player.nextSegmentIdx, 0);
});


test('HlsPlayer：旧 append 失败不得清理新会话缓冲或重试旧数据', async () => {
  const player = new HlsPlayer();
  let rejectAppend;
  let bufferedReads = 0;
  player.mse = {
    append: () => new Promise((resolve, reject) => { rejectAppend = reject; }),
    getBuffered: () => { bufferedReads += 1; return [[0, 4]]; },
    remove: async () => {},
  };
  player._abortCtrl = new AbortController();
  const pending = player._append(new Uint8Array([1]), 'video');
  await new Promise(resolve => setImmediate(resolve));

  player._sessionId += 1;
  player._abortCtrl.abort();
  player._abortCtrl = new AbortController();
  rejectAppend(new Error('buffer overlap'));

  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(bufferedReads, 0);
});


test('HlsPlayer：旧 trim 完成不得清掉新会话的重入锁', async () => {
  const player = new HlsPlayer();
  const pending = [];
  player.mse = {
    trim: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  };
  player.mediaPlaylist = { live: true };
  player._abortCtrl = new AbortController();
  player._maybeTrim();
  assert.equal(pending.length, 1);

  player._sessionId += 1;
  player._abortCtrl.abort();
  player._abortCtrl = new AbortController();
  player._trimming = false;
  player._maybeTrim();
  assert.equal(pending.length, 2);

  pending[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player._trimming, true);
  pending[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player._trimming, false);
});


test('HlsPlayer：destroy 后拒绝 attach 与 loadSource，保持 DESTROYED 状态', async () => {
  const player = new HlsPlayer();
  player.destroy();

  await assert.rejects(player.attach('http://x/next.m3u8', makeVideo()), error => error.code === 'STATE_ERROR');
  await assert.rejects(player.loadSource('http://x/next.m3u8'), error => error.code === 'STATE_ERROR');
  assert.equal(player.state, 'destroyed');
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
