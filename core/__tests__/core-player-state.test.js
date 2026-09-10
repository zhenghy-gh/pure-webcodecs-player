/**
 * core-player-state.test.js
 *
 * 针对 core/src/player.js 的**状态机与正向编排路径**补测
 * （错误路径由既有测试覆盖，此处聚焦合法/非法状态转移与编排语义）：
 *  - TRANSITIONS 状态机矩阵：全部合法转移成功、典型非法转移拒绝且状态不变
 *  - 完整生命周期链 idle→ready→playing→paused→playing→destroyed 的 statechange 序列
 *  - play/pause 幂等重入、ended 后 play 自动 seek(0) 重播
 *  - seek：恢复来源状态、强制 timeupdate、非法时间戳拒绝、demuxer 失败状态还原
 *  - prebuffer：buffering 事件对、bufferTargetUs=0 跳过预缓冲
 *  - 背压：管线上报水位超阈值时触发 backpressure buffering 并等待回落
 *  - timeupdate 250ms 节流
 *  - volume/playbackRate setter 边界与透传
 *  - destroy：end(aborted)、移除监听器、幂等、中断样本泵
 *
 * 全部用注入 demuxerFactory / pipelineFactory 假实现，零浏览器依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, PLAYER_STATES } from '../src/player.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/* ------------------------------ 假 demuxer ------------------------------ */

/** 每轨产 perTrack 个样本（ts = i*100000，duration 100000） */
class ToyDemuxer extends Demuxer {
  constructor(source, perTrack = 8, seekError = null) {
    super(source);
    this.perTrack = perTrack;
    this.seekError = seekError;
  }
  async _doOpen() {
    return {
      container: 'mkv',
      tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }],
      durationUs: 800000,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    const perTrack = this.perTrack;
    return (async function* () {
      for (let i = 0; i < perTrack; i++) {
        yield createSample({
          trackId: id, codec: 'avc1.42E01E',
          timestamp: i * 100000, duration: 100000,
          keyframe: true, data: new Uint8Array([1]), size: 1,
        });
      }
    })();
  }
  async _doSeek(timestampUs) {
    if (this.seekError) throw this.seekError;
    return { actualTimestampUs: Math.min(timestampUs, 400000) };
  }
}

const caps = {
  webcodecs: { supported: true, video: { 'avc1.42E01E': true }, audio: {} },
  mse: { supported: false, mimeTypes: [] },
};

/* ------------------------------ 两种假管线 ------------------------------ */

/** 即时管线：pushSample 同步完成、无水位自报 → 泵在微任务内自然耗尽转 ended */
function instantPipelineFactory(calls = []) {
  return async () => ({
    pushSample: async () => { calls.push('pushSample'); },
    play: () => { calls.push('play'); },
    pause: () => { calls.push('pause'); },
    seek: async () => { calls.push('seek'); },
    destroy: async () => { calls.push('destroy'); },
    setVolume: (v) => { calls.push(['setVolume', v]); },
    setMuted: (m) => { calls.push(['setMuted', m]); },
    setPlaybackRate: (r) => { calls.push(['setPlaybackRate', r]); },
  });
}

/** 阻塞管线：pushSample 让出宏任务（泵无法在 play() 返回前耗尽），恒定水位达标使预缓冲即退 */
function blockingPipelineFactory(calls = [], aheadUs = 3_000_000) {
  return async () => ({
    pushSample: async () => {
      await new Promise((r) => setTimeout(r, 0));
      calls.push('pushSample');
    },
    play: () => { calls.push('play'); },
    pause: () => { calls.push('pause'); },
    seek: async () => { calls.push('seek'); },
    destroy: async () => { calls.push('destroy'); },
    get bufferedAheadUs() { return aheadUs; },
  });
}

function makePlayer({ pipelineFactory, playerOptions = {} } = {}, demuxerOpts = {}) {
  const player = new Player({
    demuxerFactory: () => new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])), demuxerOpts.perTrack ?? 8, demuxerOpts.seekError ?? null),
    capabilities: caps,
    pipelineFactory: pipelineFactory ?? instantPipelineFactory(),
    ...playerOptions,
  });
  return player;
}

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ------------------------------ 状态机矩阵 ------------------------------ */

const LEGAL = {
  idle: ['ready', 'error', 'destroyed'],
  ready: ['playing', 'paused', 'seeking', 'error', 'destroyed'],
  playing: ['paused', 'seeking', 'error', 'destroyed'],
  paused: ['playing', 'seeking', 'error', 'destroyed'],
  seeking: ['ready', 'playing', 'paused', 'error', 'destroyed'],
  error: ['destroyed'],
  destroyed: [],
};

test('状态机：全部合法转移成功并派发 statechange', () => {
  for (const [from, targets] of Object.entries(LEGAL)) {
    for (const to of targets) {
      const p = new Player();
      p.stateValue = from;
      const seen = [];
      p.on('statechange', (s) => seen.push(s));
      p._transition(to);
      assert.equal(p.state, to, `${from} → ${to} 应合法`);
      assert.deepEqual(seen, [to], `${from} → ${to} 应派发 statechange`);
    }
  }
});

test('状态机：非法转移抛 STATE_ERROR 且状态不变', () => {
  const illegal = [
    ['idle', 'playing'], ['idle', 'paused'], ['idle', 'seeking'],
    ['ready', 'idle'], ['playing', 'ready'], ['playing', 'idle'],
    ['paused', 'ready'], ['seeking', 'idle'], ['error', 'ready'],
    ['error', 'playing'], ['destroyed', 'ready'], ['destroyed', 'playing'],
    ['destroyed', 'error'],
  ];
  for (const [from, to] of illegal) {
    const p = new Player();
    p.stateValue = from;
    assert.throws(() => p._transition(to), (e) => e.code === 'STATE_ERROR', `${from} → ${to} 应拒绝`);
    assert.equal(p.state, from, `${from} → ${to} 拒绝后状态不变`);
  }
});

/* ------------------------------ 生命周期与重入 ------------------------------ */

test('生命周期：ready→playing→paused→playing→destroyed 的 statechange 链', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory(calls) });
  const seen = [];
  player.on('statechange', (s) => seen.push(s));
  await player.load(new Uint8Array([1]));
  assert.equal(player.state, PLAYER_STATES.READY);
  await player.play();
  assert.equal(player.state, PLAYER_STATES.PLAYING);
  player.pause();
  assert.equal(player.state, PLAYER_STATES.PAUSED);
  await player.play();
  assert.equal(player.state, PLAYER_STATES.PLAYING);
  await player.destroy();
  assert.equal(player.state, PLAYER_STATES.DESTROYED);
  assert.deepEqual(seen, ['ready', 'playing', 'paused', 'playing', 'destroyed']);
  void calls;
});

test('play/pause 重入：重复调用不重复转移、不重复透传管线', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory(calls) });
  await player.load(new Uint8Array([1]));
  await player.play();
  await player.play(); // 已 playing：早退
  assert.equal(player.state, PLAYER_STATES.PLAYING);
  assert.equal(calls.filter((c) => c === 'play').length, 1, '管线 play 只调用一次');
  player.pause();
  player.pause(); // 非 playing：no-op
  assert.equal(player.state, PLAYER_STATES.PAUSED);
  assert.equal(calls.filter((c) => c === 'pause').length, 1, '管线 pause 只调用一次');
  await player.destroy();
});

test('未加载时 play/pause/seek/selectTrack 一律拒绝（idle 态）', async () => {
  const player = makePlayer();
  await assert.rejects(() => player.play(), (e) => e.code === 'STATE_ERROR');
  assert.throws(() => player.pause(), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => player.seek(0), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => player.selectTrack('video', 1), (e) => e.code === 'STATE_ERROR');
  assert.equal(player.state, PLAYER_STATES.IDLE);
});

test('load 重入：非 idle 态二次 load 拒绝、destroy 后 load 拒绝', async () => {
  const player = makePlayer();
  await player.load(new Uint8Array([1]));
  await assert.rejects(() => player.load(new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
  await player.destroy();
  await assert.rejects(() => player.load(new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
});

/* ------------------------------ ended 与重播 ------------------------------ */

test('自然结束：ended 事件、state 转 paused、ended 后 play 自动 seek(0) 重播', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: instantPipelineFactory(calls) }, { perTrack: 2 });
  await player.load(new Uint8Array([1]));
  let ended = 0;
  player.on('ended', () => ended++);
  await player.play();
  await settle();
  assert.equal(player.ended, true);
  assert.equal(player.state, PLAYER_STATES.PAUSED);
  assert.equal(ended, 1);

  const seen = [];
  player.on('statechange', (s) => seen.push(s));
  await player.play(); // ended → seek(0) → playing
  assert.equal(player.state, PLAYER_STATES.PLAYING, '重播应回到 playing');
  assert.ok(seen.includes('playing'), '重播应派发 playing');
  assert.ok(calls.includes('seek'), '重播前应先 seek(0)');
  assert.equal(player.ended, false, '重播后 ended 必须复位（第八十九波修复：此前 seek 不清 endedValue，整个重播期间恒为 true）');
  await player.destroy();
});

/* ------------------------------ seek 语义 ------------------------------ */

test('seek：从 playing 进入并返回 playing，强制 timeupdate 携带实际落点', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory(calls) });
  await player.load(new Uint8Array([1]));
  await player.play();
  const updates = [];
  player.on('timeupdate', (e) => updates.push(e));
  await player.seek(300000);
  assert.equal(player.state, PLAYER_STATES.PLAYING, 'playing 中 seek 后恢复 playing');
  assert.ok(calls.includes('seek'), '管线 seek 已透传');
  assert.equal(updates.length, 1, 'seek 结束强制派发一次 timeupdate');
  assert.ok(updates[0].currentTimeUs >= 300000, `落点应 ≥ 300000（got ${updates[0].currentTimeUs}）`);
  assert.ok(player.currentTimeUs >= 300000);
  await player.destroy();
});

test('seek：paused 态进入后回到 paused；ready 态进入后回 ready', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory(calls) });
  await player.load(new Uint8Array([1]));
  await player.seek(100000);
  assert.equal(player.state, PLAYER_STATES.READY, 'ready 中 seek 后回 ready');
  await player.play();
  player.pause();
  assert.equal(player.state, PLAYER_STATES.PAUSED);
  await player.seek(200000);
  assert.equal(player.state, PLAYER_STATES.PAUSED, 'paused 中 seek 后回 paused');
  await player.destroy();
});

test('seek：非法时间戳（负数/NaN）拒绝且状态还原', async () => {
  const player = makePlayer();
  await player.load(new Uint8Array([1]));
  for (const bad of [-1, Number.NaN]) {
    await assert.rejects(() => player.seek(bad), (e) => e.code === 'STATE_ERROR');
    assert.equal(player.state, PLAYER_STATES.READY, `seek(${bad}) 失败后状态还原`);
  }
  await player.destroy();
});

test('seek：demuxer seek 失败 → PlayerError 且状态还原为进入前状态', async () => {
  const player = makePlayer({}, { seekError: new Error('io boom') });
  await player.load(new Uint8Array([1]));
  await assert.rejects(
    () => player.seek(100000),
    (e) => e.name === 'PlayerError' && e.code === 'SOURCE_ERROR',
  );
  assert.equal(player.state, PLAYER_STATES.READY, 'seek 失败状态还原');
  await player.destroy();
});

/* ------------------------------ prebuffer / 背压 / timeupdate ------------------------------ */

test('prebuffer：play 时派发 buffering(true)→buffering(false) 事件对', async () => {
  const player = makePlayer();
  const events = [];
  player.on('buffering', (e) => events.push(e));
  await player.load(new Uint8Array([1]));
  await player.play();
  await settle();
  assert.equal(events[0].active, true, '起播先进缓冲中');
  assert.equal(events[0].targetUs, 3000000, '默认水位 3s');
  assert.equal(events[events.length - 1].active, false, '结束时退出缓冲中');
  await player.destroy();
});

test('bufferTargetUs=0：跳过预缓冲，不派发 buffering 事件', async () => {
  const player = makePlayer({ playerOptions: { bufferTargetUs: 0 } });
  const events = [];
  player.on('buffering', (e) => events.push(e));
  await player.load(new Uint8Array([1]));
  await player.play();
  await settle();
  assert.deepEqual(events, [], 'target=0 不应触发预缓冲事件');
  await player.destroy();
});

test('背压：管线上报水位超阈值时进入 backpressure buffering 并等待回落', async () => {
  // 管线水位 10s > 限值(3s×2=6s)：注入 schedule 首次让出后水位回落到 1s，应恰好等待一次后恢复
  let aheadUs = 10_000_000;
  let polls = 0;
  const calls = [];
  const player = new Player({
    demuxerFactory: () => new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])), 4),
    capabilities: caps,
    pipelineFactory: async () => ({
      pushSample: async () => { calls.push('pushSample'); },
      get bufferedAheadUs() { return aheadUs; },
    }),
    schedule: (fn) => {
      polls += 1;
      aheadUs = 1_000_000; // 一次让出后水位回落
      fn();
      return () => {};
    },
  });
  const events = [];
  player.on('buffering', (e) => events.push(e));
  await player.load(new Uint8Array([1]));
  await player.play();
  await settle();
  const bp = events.filter((e) => e.reason === 'backpressure');
  assert.ok(bp.length >= 2, `应派发 backpressure 事件对（got ${bp.length}）`);
  assert.equal(bp[0].active, true, '进入背压');
  assert.equal(bp[bp.length - 1].active, false, '水位回落退出背压');
  assert.ok(polls >= 1, '应通过注入 schedule 让出等待');
  await player.destroy();
});

test('timeupdate 节流：间隔 <250ms 的样本不重复派发', async () => {
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory() });
  const updates = [];
  player.on('timeupdate', (e) => updates.push(e));
  await player.load(new Uint8Array([1]));
  await player.play();
  // 水位即达标的阻塞管线：预缓冲只投递首个样本（ts=0）即退出
  assert.equal(updates.length, 1, `仅首个样本应派发 timeupdate（got ${updates.length}）`);
  // 让出宏任务期间单调钟已推进（<250ms 节流窗内），故只断言落在节流窗起点附近
  assert.ok(updates[0].currentTimeUs >= 0 && updates[0].currentTimeUs < 250000,
    `timeupdate 应落在首个样本附近（got ${updates[0].currentTimeUs}）`);
  await player.destroy();
});

/* ------------------------------ setter 边界 ------------------------------ */

test('volume/playbackRate/muted：合法值透传管线，非法值拒绝且不生效', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: instantPipelineFactory(calls) });
  await player.load(new Uint8Array([1]));
  player.volume = 0.5;
  player.muted = true;
  player.playbackRate = 2;
  assert.equal(player.volume, 0.5);
  assert.equal(player.muted, true);
  assert.equal(player.playbackRate, 2);
  assert.deepEqual(calls, [
    ['setVolume', 0.5], ['setMuted', true], ['setPlaybackRate', 2],
  ]);
  for (const bad of [-0.1, 1.01, Number.NaN]) {
    assert.throws(() => { player.volume = bad; }, (e) => e.code === 'STATE_ERROR');
    assert.equal(player.volume, 0.5, `volume=${bad} 拒绝后不变`);
  }
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(() => { player.playbackRate = bad; }, (e) => e.code === 'STATE_ERROR');
    assert.equal(player.playbackRate, 2, `playbackRate=${bad} 拒绝后不变`);
  }
  await player.destroy();
});

/* ------------------------------ destroy ------------------------------ */

test('destroy：派发 end(aborted)、移除全部监听器、幂等、中断样本泵', async () => {
  const calls = [];
  const player = makePlayer({ pipelineFactory: blockingPipelineFactory(calls) });
  await player.load(new Uint8Array([1]));
  let ended = 0;
  player.on('ended', () => ended++);
  const playPromise = player.play();
  assert.equal(player.state, PLAYER_STATES.PLAYING, 'play 已进入 playing（预缓冲随水位达标即退）');
  await player.destroy(); // playing 中销毁
  await playPromise;
  assert.equal(player.state, PLAYER_STATES.DESTROYED);
  assert.equal(ended, 0, '销毁不应派发自然 ended');
  assert.equal(player.listenerCount('ended'), 0, 'destroy 应移除全部监听器');
  assert.ok(calls.includes('destroy'), '管线 destroy 已透传');
  await player.destroy(); // 幂等
  assert.equal(player.state, PLAYER_STATES.DESTROYED);
});
