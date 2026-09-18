/**
 * hls player 残余分支补测（第一百一十五波）
 * ------------------------------------------------------------
 * 承接 player-pipeline.test.js 的替身基建，覆盖此前零覆盖的分支：
 *  - 两级装载时 media playlist 拉取失败 → _fail + rethrow
 *  - 缓冲已满 → bufferfull 定时器暂缓，消耗后恢复装载
 *  - AES-128 解密路径（EXT-X-KEY → decrypter.assertSupported/decryptSegment）
 *  - 带宽样本回填触发 ABR 切档回调（reportLoad onSwitch → 切档重载）
 *  - passthrough + master 仅音频 CODECS → _audioOnlyHint 固化
 *  - 直播 trim 失败静默（fire-and-forget catch）
 *  - 自动播放被浏览器策略拦截（play() reject 不中断流水线）
 *  - 直播轮询失败 → non-fatal error 且轮询自愈继续
 *  - play/pause 在无 video 引用时的空操作安全
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { HlsPlayer, PlayerState } from '../src/player.js';
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

const AUDIO_MASTER_PL = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="mp4a.40.2"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="mp4a.40.2"
lo.m3u8`;

const TWO_SEG_PL = (prefix) => `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
${prefix}0.m4s
#EXTINF:6.0,
${prefix}1.m4s
#EXT-X-ENDLIST`;

const KEY_PL = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:6.0,
seg0.m4s
#EXTINF:6.0,
seg1.m4s
#EXT-X-ENDLIST`;

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

/* ------------------------------ 测试替身 ------------------------------ */

function makeLoader({ texts = {}, bytes = {}, gates = {} } = {}) {
  return {
    texts,
    bytes,
    gates,
    loadTextCalls: [],
    loadCalls: [],
    failWith: null,
    async loadText(url) {
      this.loadTextCalls.push(url);
      if (this.failWith) throw this.failWith;
      const t = texts[url];
      if (t == null) throw new Error(`unexpected loadText: ${url}`);
      return t;
    },
    async load(url) {
      this.loadCalls.push(url);
      if (gates[url]) await gates[url].promise;
      const d = bytes[url];
      if (d == null) throw new Error(`unexpected load: ${url}`);
      return { data: d, byteLength: d.byteLength };
    },
  };
}

function makeGate() {
  const g = {};
  g.promise = new Promise((resolve) => { g.release = resolve; });
  return g;
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
    bufferedRanges: [],
    async attach(v) { this.video = v; },
    addSourceBuffer(type, mime) { sourceBuffers[type] = { mime, type }; },
    async append(type, data) { this.appends.push([type, data]); },
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

function setup({ config, texts, bytes, gates, passthrough } = {}) {
  const p = new HlsPlayer(config);
  p._abortCtrl = new AbortController();
  const loader = makeLoader({ texts, bytes, gates });
  const mse = makeMse();
  const video = makeVideo();
  const tmux = makeTmux({ passthrough });
  p.loader = loader;
  p.mse = mse;
  p.mse.video = video;
  p.transmuxer = tmux;
  return { p, loader, mse, video, tmux };
}

async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: 条件超时');
    await new Promise((r) => setImmediate(r));
  }
}

/* ------------------------------ 两级装载失败 ------------------------------ */

test('master→media 两级装载：media playlist 拉取失败 → _fail + rethrow，state=ERROR', async () => {
  // 初始选择偏低档（lo）：lo.m3u8 缺失 → loadText 抛错 → _loadMediaPlaylist catch → _fail + throw
  const { p } = setup({ texts: { 'http://x/master.m3u8': MASTER_PL, 'http://x/hi.m3u8': TWO_SEG_PL('hi') } });
  const errors = [];
  p.on('error', (e) => errors.push(e));
  await assert.rejects(() => p.loadSource('http://x/master.m3u8'));
  assert.equal(p.state, PlayerState.ERROR);
  assert.ok(errors.length >= 1, 'error 事件已派发');
  p.destroy();
});

/* ------------------------------ 缓冲已满暂缓 ------------------------------ */

test('缓冲已满：pump 挂起等待消耗，bufferfull 定时器到点后恢复装载至结束', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, mse } = setup({
    config: { maxBufferSeconds: 1 },
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  mse.bufferSeconds = 5; // > maxBufferSeconds(1)：首个 pump 即缓冲已满
  await p.loadSource(BASE);
  await new Promise((r) => setImmediate(r));
  assert.equal(mse.appends.length, 0, '缓冲已满不装载');

  mse.bufferSeconds = 0; // 模拟消耗
  t.mock.timers.tick(1000);
  await until(() => mse.endedCount > 0);
  // transmuxed 产物每分片双轨各 init+media 共 4 次 append，2 分片 8 次
  assert.equal(mse.appends.length, 8, '恢复后两个分片装载完成');
  p.destroy();
});

/* ------------------------------ AES-128 解密路径 ------------------------------ */

test('AES-128：EXT-X-KEY 分片先 assertSupported 再 decryptSegment（携带 sn），产物照常 append', async () => {
  const { p, mse } = setup({
    texts: { [BASE]: KEY_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xc0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xc1]),
    },
  });
  const decryptCalls = [];
  const assertCalls = [];
  p.decrypter = {
    assertSupported(key) { assertCalls.push(key.method); },
    async decryptSegment(data, key, ctx) { decryptCalls.push(ctx.sn); return data; },
  };
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);
  assert.deepEqual(decryptCalls, [0, 1], '每个分片按媒体序号解密一次');
  assert.deepEqual(assertCalls, ['AES-128', 'AES-128'], '每个分片下载后先断言一次支持性');
  assert.equal(mse.appends.length, 8, '解密产物正常转封装 append');
  p.destroy();
});

/* ------------------------------ ABR 带宽回填切档 ------------------------------ */

test('带宽样本回填：reportLoad 触发切档回调 → 以 sn 锚点重载新档位清单', async () => {
  // startLevel=0 → 初始最高清 hi；首个分片 hi0 卡住，期间替换 reportLoad 为「升级即回调」
  const hiGate = makeGate();
  const { p, loader, mse } = setup({
    config: { startLevel: 0 },
    texts: {
      'http://x/master.m3u8': MASTER_PL,
      'http://x/hi.m3u8': TWO_SEG_PL('hi'),
      'http://x/lo.m3u8': TWO_SEG_PL('lo'),
    },
    bytes: {
      'http://x/hi0.m4s': new Uint8Array([0xd0]),
      'http://x/lo1.m4s': new Uint8Array([0xd3]),
    },
    gates: { 'http://x/hi0.m4s': hiGate },
  });
  await p.loadSource('http://x/master.m3u8');
  await until(() => loader.loadCalls.includes('http://x/hi0.m4s'));
  assert.equal(p.playlistUrl, 'http://x/hi.m3u8');

  // 真实 reportLoad 由带宽估计决定切档并回调；此处替换为一次性 wrapper（触发后自还原），
  // 只覆盖 player 侧「回调 → 切档重载」分支，避免后续分片的 reportLoad 重复触发切档
  const origReportLoad = p.levels.reportLoad;
  p.levels.reportLoad = (_bytes, _elapsed, _buffered, onSwitch) => {
    p.levels.reportLoad = origReportLoad; // 一次性：仅首个分片触发
    p.levels.switchTo(1); // levels.current → lo
    onSwitch({ from: 0, to: 1 });
  };
  hiGate.release();

  await until(() => mse.endedCount > 0);
  assert.equal(p.playlistUrl, 'http://x/lo.m3u8', '切档回调后重载新档位清单');
  assert.equal(p.stats.levelsSwitched, 1, '切档回调已生效');
  assert.ok(loader.loadCalls.includes('http://x/lo1.m4s'), '回调中断旧泵后按新清单推进');
  p.destroy();
});

/* ------------------------------ 音频-only 流固化为音频轨 ------------------------------ */

test('passthrough + master 仅音频 CODECS：_audioOnlyHint 置位并只建音频 SourceBuffer', async () => {
  const { p, mse } = setup({
    texts: {
      'http://x/master.m3u8': AUDIO_MASTER_PL,
      'http://x/hi.m3u8': VOD_PL,
      'http://x/lo.m3u8': VOD_PL,
    },
    // VOD_PL 分片相对 lo.m3u8 解析 → http://x/seg0.m4s（非 BASE 下的 live/ 前缀）
    bytes: {
      'http://x/seg0.m4s': new Uint8Array([0xe0]),
      'http://x/seg1.m4s': new Uint8Array([0xe1]),
    },
    passthrough: true,
  });
  await p.loadSource('http://x/master.m3u8');
  await until(() => mse.endedCount > 0);
  assert.equal(p._audioOnlyHint, true, '直通产物 + 仅音频 CODECS → 纯音频流提示');
  assert.ok(mse.sourceBuffers.audio, '应建音频轨');
  assert.equal(mse.sourceBuffers.video, null, '不应强建视频轨');
  p.destroy();
});

/* ------------------------------ 直播 trim 失败静默 ------------------------------ */

test('直播 trim 失败：fire-and-forget catch 吞掉，不进 error 也不中断装载', async () => {
  const { p, mse } = setup({
    texts: { [BASE]: livePl(0) },
    bytes: {
      'http://x/live/live0.m4s': new Uint8Array([0xe0]),
      'http://x/live/live1.m4s': new Uint8Array([0xe1]),
    },
  });
  mse.trim = async () => { throw new Error('trim boom'); };
  const errors = [];
  p.on('error', (e) => errors.push(e));
  await p.loadSource(BASE);
  await until(() => p._lastAppendedSn === 1);
  assert.deepEqual(errors, [], 'trim 失败不应派发 error');
  assert.equal(mse.trims.length, 0, '替换后的 trim 不入 trims 记录');
  p.destroy();
});

/* ------------------------------ 自动播放被策略拦截 ------------------------------ */

test('自动播放被浏览器策略拦截：play() reject 被捕获，流水线不受影响', async () => {
  const { p, video, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  video.readyState = 3;
  video.play = async () => { video.rejectedPlays = (video.rejectedPlays ?? 0) + 1; throw new Error('NotAllowedError'); };
  await p.loadSource(BASE);
  await until(() => mse.endedCount > 0);
  assert.equal(video.autoplayGuard, true, 'guard 置位防重复尝试');
  assert.equal(mse.endedCount, 1, '起播失败不影响装载流水线');
  p.destroy();
});

/* ------------------------------ 直播轮询失败自愈 ------------------------------ */

test('直播轮询失败：派发 non-fatal network error，下一轮自愈继续衔接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, loader, mse } = setup({
    texts: { [BASE]: livePl(0) },
    bytes: {
      'http://x/live/live0.m4s': new Uint8Array([0xe0]),
      'http://x/live/live1.m4s': new Uint8Array([0xe1]),
      'http://x/live/live2.m4s': new Uint8Array([0xe2]),
      'http://x/live/live3.m4s': new Uint8Array([0xe3]),
    },
  });
  const errors = [];
  p.on('error', (e) => errors.push(e));
  await p.loadSource(BASE);
  await until(() => p._lastAppendedSn === 1);

  loader.failWith = new Error('net down');
  t.mock.timers.tick(2000);
  await until(() => errors.length > 0);
  assert.equal(errors[0].type, 'network');
  assert.equal(errors[0].fatal, false, '轮询失败为 non-fatal');
  assert.match(errors[0].detail, /net down/);

  loader.failWith = null;
  loader.texts[BASE] = livePl(2);
  t.mock.timers.tick(2000);
  // 轮询自愈后按 sn 锚点衔接：live2(sn2) 起装载，pump 会把窗口内 live2/live3 都消费完
  await until(() => p._lastAppendedSn >= 2, 3000);
  assert.ok(loader.loadCalls.includes('http://x/live/live2.m4s'), '轮询自愈后窗口推进装载');
  p.destroy();
});

/* ------------------------------ 无 video 引用的控制接口 ------------------------------ */

test('play/pause：无 video 引用时为安全空操作', async () => {
  const { p, mse } = setup({
    texts: { [BASE]: VOD_PL },
    bytes: {
      'http://x/live/seg0.m4s': new Uint8Array([0xa0]),
      'http://x/live/seg1.m4s': new Uint8Array([0xa1]),
    },
  });
  await p.loadSource(BASE);
  mse.video = null; // 模拟未挂载/已卸载
  assert.doesNotThrow(() => p.play());
  assert.doesNotThrow(() => p.pause());
  p.destroy();
});
