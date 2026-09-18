/**
 * hls player 主流水线可测化（env/浏览器依赖层）
 * ------------------------------------------------------------
 * 手法：注入式替换 loader / mse / transmuxer 三依赖（构造后、loadSource 前），
 *      m3u8 解析与 LevelController 走真实实现；直播轮询用 node:test mock timers。
 * 覆盖点：VOD 全链路装载到 endOfStream、master→media 两级装载与手动切档、
 *        直播轮询 sn 锚点衔接、EXT-X-MAP init 复用、append 失败清缓冲重试、
 *        自动起播 guard、stall 降档、_buildReloadUrl 阻塞重载参数、错误分类与 destroy。
 * 不覆盖：真实 MSE SourceBuffer 时序与浏览器 fetch 网络语义（见豁免清单）。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { HlsPlayer, PlayerState } from '../src/player.js';
import { LoadError } from '../src/segment-loader.js';
import { ErrorCode } from '../../core/src/errors.js';

const BASE = 'http://x/live/media.m3u8';

const VOD_PL = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.m4s
#EXTINF:6.0,
seg1.m4s
#EXT-X-ENDLIST`;

const MASTER_PL = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1.64001f,mp4a.40.2"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="avc1.42E00A,mp4a.40.2"
lo.m3u8`;

const HI_PL = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:6.0,
hi0.m4s
#EXT-X-ENDLIST`;

const LO_PL = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
lo0.m4s
#EXT-X-ENDLIST`;

/** 直播滑动窗口：msn 为 MEDIA-SEQUENCE，两个分片 sn = msn / msn+1 */
function livePl(msn) {
  return `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:${msn}
#EXTINF:4.0,
live${msn}.m4s
#EXTINF:4.0,
live${msn + 1}.m4s`;
}

const MAP_PL = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
m0.m4s
#EXTINF:6.0,
m1.m4s
#EXT-X-ENDLIST`;

/* ------------------------------ 测试替身 ------------------------------ */

function makeLoader({ texts = {}, bytes = {} } = {}) {
  return {
    texts,
    bytes,
    loadTextCalls: [],
    loadCalls: [],
    failWith: null,
    async loadText(url) {
      this.loadTextCalls.push(url);
      if (this.failWith) throw this.failWith;
      const t = texts[url];
      if (t == null) throw new LoadError(ErrorCode.SOURCE_ERROR, `unexpected loadText: ${url}`, { url });
      return t;
    },
    async load(url) {
      this.loadCalls.push(url);
      const d = bytes[url];
      if (d == null) throw new LoadError(ErrorCode.SOURCE_ERROR, `unexpected load: ${url}`, { url });
      return { data: d, byteLength: d.byteLength };
    },
  };
}

function makeMse() {
  const sourceBuffers = { video: null, audio: null };
  return {
    sourceBuffers,
    video: null,
    appends: [],
    removed: [],
    endedCount: 0,
    trims: [],
    bufferSeconds: 0,
    destroyed: 0,
    appendFailNext: false,
    bufferedRanges: [],
    async attach(v) { this.video = v; },
    addSourceBuffer(type, mime) { sourceBuffers[type] = { mime, type }; },
    async append(type, data) {
      if (this.appendFailNext) {
        this.appendFailNext = false;
        throw new Error('buffer overlap');
      }
      this.appends.push([type, data]);
    },
    async remove(type, s, e) { this.removed.push([type, s, e]); },
    getBuffered() { return this.bufferedRanges; },
    async endOfStream() { this.endedCount += 1; },
    async trim(opts) { this.trims.push(opts); },
    currentBufferSeconds() { return this.bufferSeconds; },
    destroy() { this.destroyed += 1; },
  };
}

function makeVideo() {
  const listeners = new Map();
  return {
    paused: true,
    readyState: 0,
    autoplayGuard: false,
    plays: 0,
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener(t, fn) { listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)); },
    emit(t) { for (const fn of listeners.get(t) ?? []) fn(); },
    listenerCount(t) { return (listeners.get(t) ?? []).length; },
    async play() { this.plays += 1; this.paused = false; },
  };
}

function makeTmux({ passthrough = false } = {}) {
  return {
    calls: [],
    destroyed: 0,
    async process(data, ctx) {
      this.calls.push({ data, ctx });
      if (passthrough) return { kind: 'passthrough', mediaSegment: data };
      return {
        kind: 'transmuxed',
        codecs: { video: 'avc1.42E01E', audio: 'mp4a.40.2' },
        video: { initSegment: new Uint8Array([0x01]), mediaSegment: new Uint8Array([0x02]) },
        audio: { initSegment: new Uint8Array([0x03]), mediaSegment: new Uint8Array([0x04]) },
      };
    },
    destroy() { this.destroyed += 1; },
  };
}

/** 构造完成依赖注入的 player（未 attach；_abortCtrl 按 attach 首行语义就绪） */
function setup({ config, texts, bytes, passthrough } = {}) {
  const p = new HlsPlayer(config);
  p._abortCtrl = new AbortController();
  const loader = makeLoader({ texts, bytes });
  const mse = makeMse();
  const video = makeVideo();
  const tmux = makeTmux({ passthrough });
  p.loader = loader;
  p.mse = mse;
  p.mse.video = video; // _maybeAutoplay / stall 闸需要 video 引用（等价 attach 的挂载结果）
  p.transmuxer = tmux;
  return { p, loader, mse, video, tmux };
}

/** 等待异步 pump 链推进到条件成立（setImmediate 让出微/宏任务） */
async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: 条件超时');
    await new Promise((r) => setImmediate(r));
  }
}

/* ------------------------------ VOD 主链路 ------------------------------ */

test('VOD fMP4 直通：双轨 append、stats、endOfStream 与 ended 事件', async () => {
  const { p, loader, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  const events = [];
  p.on('manifest', (e) => events.push(['manifest', e]));
  p.on('playlist', (e) => events.push(['playlist', e]));
  p.on('bufferappended', (e) => events.push(['appended', e.sn]));
  p.on('ended', () => events.push(['ended']));

  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);

  // media playlist 直连：manifest 无 levels；playlist 事件仅 _loadMediaPlaylist 路径派发，
  // 直连 media 分支不走（首个事件即 bufferappended）
  assert.deepEqual(events[0], ['manifest', { levels: [] }]);

  // 每分片双轨各 init+media 共 4 次 append，2 分片 8 次
  assert.equal(mse.appends.length, 8);
  assert.deepEqual(mse.appends.slice(0, 4).map(([t, d]) => [t, d[0]]), [
    ['video', 0x01], ['video', 0x02], ['audio', 0x03], ['audio', 0x04],
  ]);
  assert.ok(mse.sourceBuffers.video && mse.sourceBuffers.audio, '按转封装 codecs 建双轨');

  assert.equal(p.stats.segmentsLoaded, 2);
  assert.equal(p.stats.bytesLoaded, 2);
  assert.equal(p._lastAppendedSn, 1);
  assert.deepEqual(events.filter(([k]) => k === 'appended').map(([, sn]) => sn), [0, 1]);
  assert.deepEqual(events.filter(([k]) => k === 'ended').length, 1);
  assert.equal(mse.endedCount, 1);
  p.destroy();
});

test('VOD passthrough：直通产物进视频轨，缺 CODECS 时兜底建 avc1', async () => {
  const { p, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xb0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xb1]),
    },
    passthrough: true,
  });
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);

  // 无 levels → codecs 全空 → 强建默认视频轨；每分片仅 1 次 append
  assert.equal(mse.sourceBuffers.video.mime, 'video/mp4; codecs="avc1.42E01E"');
  assert.equal(mse.sourceBuffers.audio, null);
  assert.deepEqual(mse.appends.map(([t, d]) => [t, d[0]]), [['video', 0xb0], ['video', 0xb1]]);
  p.destroy();
});

test('EXT-X-MAP：init 分片按 URL 去重装载一次并先于媒体分片 append', async () => {
  const { p, loader, mse } = setup({
    texts: { [BASE]: MAP_PL },
    bytes: {
      'http://x/live/init.mp4': new Uint8Array([0xEE]),
      'http://x/live/m0.m4s': new Uint8Array([0xc0]),
      'http://x/live/m1.m4s': new Uint8Array([0xc1]),
    },
    passthrough: true,
  });
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);

  assert.deepEqual(loader.loadCalls, ['http://x/live/init.mp4', 'http://x/live/m0.m4s', 'http://x/live/m1.m4s']);
  assert.deepEqual(mse.appends.map(([t, d]) => [t, d[0]]), [
    ['video', 0xEE], ['video', 0xc0], ['video', 0xc1],
  ], 'init 先行且只 append 一次');
  assert.ok(p._loadedInitUrls.has('http://x/live/init.mp4'));
  p.destroy();
});

/* ------------------------------ master / 切档 ------------------------------ */

test('master 两级装载：manifest 报 levels，手动 setLevel 触发切档重载', async () => {
  const { p, loader, mse } = setup({
    texts: { 'http://x/master.m3u8': MASTER_PL, 'http://x/hi.m3u8': HI_PL, 'http://x/lo.m3u8': LO_PL },
    bytes: { 'http://x/hi0.m4s': new Uint8Array([0xd0]), 'http://x/lo0.m4s': new Uint8Array([0xd1]) },
  });
  const switches = [];
  p.on('levelswitch', (sw) => switches.push(sw));

  await p.loadSource('http://x/master.m3u8');
  await until(() => mse.endedCount > 0);
  assert.equal(p.playlistUrl, 'http://x/lo.m3u8', '_pickInitial=1 → bandwidth 降序后 index 1 = 偏低档');

  const sw = p.setLevel(0); // 0 = 最高清（bandwidth 降序后 hi.m3u8）
  assert.deepEqual(sw, { from: 1, to: 0 });
  assert.equal(p.currentLevel, 0);
  await until(() => loader.loadCalls.includes('http://x/hi0.m4s'));
  assert.equal(p.playlistUrl, 'http://x/hi.m3u8');
  assert.equal(p.stats.levelsSwitched, 1);
  assert.equal(switches.length, 1);
  p.destroy();
});

test('setLevel：单码率源抛 STATE_ERROR；越界下标抛 STATE_ERROR', async () => {
  const { p } = setup({ texts: { [BASE]: VOD_PL } });
  await p.loadSource(BASE);
  assert.throws(() => p.setLevel(0), (e) => e.code === 'STATE_ERROR');

  const p2 = setup({
    texts: { 'http://x/master.m3u8': MASTER_PL, 'http://x/hi.m3u8': HI_PL, 'http://x/lo.m3u8': LO_PL },
  }).p;
  await p2.loadSource('http://x/master.m3u8');
  assert.throws(() => p2.setLevel(9), (e) => e.code === 'STATE_ERROR');
  p.destroy();
  p2.destroy();
});

test('stall 快速降档：waiting 且缓冲近零时切最低档并重载清单', async () => {
  const { p, loader, mse, video } = setup({
    texts: { 'http://x/master.m3u8': MASTER_PL, 'http://x/hi.m3u8': HI_PL, 'http://x/lo.m3u8': LO_PL },
    bytes: { 'http://x/hi0.m4s': new Uint8Array([0xd0]), 'http://x/lo0.m4s': new Uint8Array([0xd1]) },
  });
  await p.attach('http://x/master.m3u8', video);
  await until(() => mse.endedCount > 0);
  const before = p.stats.levelsSwitched;

  video.paused = false;
  mse.bufferSeconds = 0.1; // <1.5 触发闸
  p.levels.currentLevel = 0; // 模拟已爬升到最高档，stall 才有降档空间
  video.emit('waiting');
  await until(() => p.stats.levelsSwitched > before);

  assert.equal(p.playlistUrl, 'http://x/lo.m3u8', 'handleStall 直切最低档');
  p.destroy();
});

/* ------------------------------ 直播轮询 ------------------------------ */

test('直播轮询：窗口推进后以最后消费 sn 为锚点衔接，不重放', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, loader, mse } = setup({
    texts: {
      [BASE]: livePl(0),
      // 轮询按 playlistUrl 原样重载（无 CAN-BLOCK-RELOAD）
    },
    bytes: {
      'http://x/live/live0.m4s': new Uint8Array([0xe0]),
      'http://x/live/live1.m4s': new Uint8Array([0xe1]),
      'http://x/live/live2.m4s': new Uint8Array([0xe2]),
    },
  });

  await p.loadSource(BASE);
  await until(() => p._lastAppendedSn === 1);
  assert.deepEqual(loader.loadCalls, ['http://x/live/live0.m4s', 'http://x/live/live1.m4s']);

  // 轮询返回窗口推进后的清单（msn=2，分片 sn=2/3），锚点 sn=1 → 从头衔接
  loader.texts[BASE] = livePl(2);
  t.mock.timers.tick(2000); // targetDuration 4 → interval 2s
  await until(() => p._lastAppendedSn === 2);

  assert.equal(
    loader.loadCalls.filter((u) => u === 'http://x/live/live0.m4s').length, 1,
    '窗口外分片不重放（初始窗口装载的那一次不算）',
  );
  p.destroy();
});

test('_buildReloadUrl：CAN-BLOCK-RELOAD 时带 _HLS_msn/_HLS_part；否则原样', () => {
  const { p } = setup({});
  p.playlistUrl = 'http://x/live/media.m3u8';
  p.mediaPlaylist = {
    serverControl: null,
    mediaSequence: 4,
    segments: [{ sn: 4, parts: [] }, { sn: 5, parts: [{}] }],
  };
  assert.equal(p._buildReloadUrl(), 'http://x/live/media.m3u8');

  p.mediaPlaylist.serverControl = { canBlockReload: true };
  const u = new URL(p._buildReloadUrl());
  assert.equal(u.searchParams.get('_HLS_msn'), '6', '最后分片 sn+1');
  assert.equal(u.searchParams.get('_HLS_part'), '1', '最后含 part 分片的 part 数');
  p.destroy();
});

/* ------------------------------ 错误与防御 ------------------------------ */

test('loadText 失败 → state=ERROR、error 事件分类；m3u8 坏文本 → PARSE_ERROR fatal', async () => {
  const { p, loader } = setup({ texts: {} });
  const errors = [];
  p.on('error', (e) => errors.push(e));

  loader.failWith = new Error('connection refused');
  await assert.rejects(p.loadSource(BASE));
  assert.equal(p.state, PlayerState.ERROR);
  assert.deepEqual({ type: errors[0].type, fatal: errors[0].fatal }, { type: 'mse', fatal: true });

  // 坏 m3u8 文本 → 包一层 PARSE_ERROR
  const p2 = setup({ texts: { [BASE]: 'this is not an m3u8' } }).p;
  const errors2 = [];
  p2.on('error', (e) => errors2.push(e));
  await assert.rejects(p2.loadSource(BASE), (e) => e instanceof LoadError && e.code === ErrorCode.PARSE_ERROR);
  assert.equal(errors2[0].fatal, true);
  p.destroy();
  p2.destroy();
});

test('append 失败：有缓冲时清空重试成功；无缓冲时上抛进 _fail', async () => {
  const { p, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  mse.bufferedRanges = [[0, 6]];
  mse.appendFailNext = true;

  const errors = [];
  p.on('error', (e) => errors.push(e));
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);
  assert.deepEqual(mse.removed, [['video', 0, 6]], '重叠缓冲被清除后重试');
  assert.equal(mse.appends.length, 8, '重试成功，流水线未中断');

  // 无缓冲可清 → 直接失败
  const p2 = setup({
    texts: { [BASE]: VOD_PL },
    bytes: { 'http://x/live/seg0.m4s': new Uint8Array([0xa0]), 'http://x/live/seg1.m4s': new Uint8Array([0xa1]) },
  });
  p2.mse.appendFailNext = true;
  p2.mse.bufferedRanges = [];
  const errors2 = [];
  p2.p.on('error', (e) => errors2.push(e));
  await p2.p.loadSource(BASE);
  await until(() => errors2.length > 0);
  assert.match(errors2[0].detail, /buffer overlap/);
  p.destroy();
  p2.p.destroy();
});

test('自动起播：readyState≥3 首次 append 后 play 一次，guard 防重复', async () => {
  const { p, video, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  video.readyState = 3;
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);
  assert.equal(video.plays, 1, '两个分片只触发一次 play');
  assert.equal(video.autoplayGuard, true);
  p.destroy();
});

test('destroy：幂等、断开 abort/定时器/监听/依赖，destroy 后 pump 与 _fail 均为空操作', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, mse, video, tmux } = setup({
    texts: { [BASE]: livePl(0) },
    bytes: {
      'http://x/live/live0.m4s': new Uint8Array([0xe0]),
      'http://x/live/live1.m4s': new Uint8Array([0xe1]),
    },
  });
  await p.attach(BASE, video);
  await until(() => p._lastAppendedSn === 1);
  assert.equal(video.listenerCount('waiting'), 1);

  p.destroy();
  assert.equal(p.state, PlayerState.DESTROYED);
  assert.equal(video.listenerCount('waiting'), 0, 'waiting 监听已解绑');
  assert.equal(mse.destroyed, 1);
  assert.equal(tmux.destroyed, 1);

  p.destroy(); // 幂等
  assert.equal(mse.destroyed, 1);
  assert.equal(p.state, PlayerState.DESTROYED);

  // destroy 后：直播轮询定时器不再推进 pipeline；_fail 静默
  const errors = [];
  p.on('error', (e) => errors.push(e));
  t.mock.timers.tick(60000);
  p._fail(new Error('after destroy'));
  assert.equal(errors.length, 0);
  assert.equal(mse.endedCount, 0);
});
