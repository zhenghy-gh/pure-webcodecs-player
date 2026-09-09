/**
 * player.test.js —— WebTorrentPlayer 状态机 / 优雅降级 / 依赖加载器单测
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WebTorrentPlayer, selectMediaFile, loadWebTorrent, Emitter,
} from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';
import { makeMinimalWebm } from '../../mkv/__tests__/fixtures/make-fixture.mjs';

// ── 测试桩：最小 webtorrent 表面 ─────────────────────────

class FakeTorrent extends Emitter {
  constructor(name, files) {
    super();
    this.name = name;
    this.infoHash = 'fakehash00000000000000000000000000000000';
    this.files = files;
    this.progress = 0;
    this.downloadSpeed = 0;
    this.uploadSpeed = 0;
    this.downloaded = 0;
    this.timeRemaining = Infinity;
    this.peers = {};
    this.destroyed = false;
  }
  async destroy() { this.destroyed = true; }
}

class FakeClient extends Emitter {
  constructor(delayMs = 0, { noMedia = false } = {}) {
    super();
    this.delayMs = delayMs;
    this.noMedia = noMedia;
    this.torrents = [];
    this.destroyed = false;
  }
  add(torrentId, _opts, cb) {
    const files = this.noMedia
      ? [] // 零文件种子：命中「无可播文件」分支（ext 兜底不会误选）
      : [
          { name: 'readme.txt', length: 100 },
          { name: 'movie.mkv', length: 700 },
          { name: 'trailer.mp4', length: 500 },
        ];
    // 让第一个文件对象可流式读取（attach 后 source.read 可用）
    for (const f of files) f.stream = () => streamOf(new Uint8Array(f.length));
    setTimeout(() => {
      const t = new FakeTorrent('fake-torrent', files);
      this.torrents.push(t);
      cb?.(null, t);
      t.emit('ready');
    }, this.delayMs);
    return this.torrents.at(-1) ?? null;
  }
  async remove() {}
  async destroy() { this.destroyed = true; }
}

function streamOf(bytes) {
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return; }
      const n = Math.min(32, bytes.length - pos);
      controller.enqueue(bytes.subarray(pos, pos + n));
      pos += n;
    },
  });
}

// ── selectMediaFile ──────────────────────────────────────

test('selectMediaFile：扩展名优先、体积兜底', () => {
  const files = [
    { name: 'doc.pdf', length: 9999 },
    { name: 'small.mp4', length: 10 },
    { name: 'big.mkv', length: 500 },
    { name: 'tiny.webm', length: 300 },
  ];
  assert.equal(selectMediaFile(files).name, 'big.mkv');       // 扩展名池中最大
  assert.equal(
    selectMediaFile([{ name: 'a.txt', length: 1 }, { name: 'b.bin', length: 2 }]).name,
    'b.bin',
  );                                                          // 无媒体扩展名 → 全局最大
  assert.equal(selectMediaFile([]), null);
});

// ── attach 成功路径 ──────────────────────────────────────

test('attach：桩客户端全流程 ready，source 可读', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });

  const events = [];
  player.on('status', (s) => events.push(`status:${s}`));
  const readyPromise = new Promise((r) => player.once('ready', r));

  const { file, source } = await player.attach('magnet:?xt=urn:btih:fake');
  const client = player.client;

  assert.equal(player.state, 'ready');
  assert.equal(file.name, 'movie.mkv');
  assert.ok(source.byteLength > 0);
  await readyPromise;

  // source 实际可读（读文件头）
  const head = await source.read(0, 16);
  assert.equal(head.length, 16);

  assert.deepEqual(events, ['status:loading', 'status:ready']);

  await player.destroy();
  assert.equal(client.destroyed, true);
  assert.equal(player.state, 'destroyed');
});

test('attach：无可用库时优雅降级（NO_CLIENT）', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => null });
  const noClientEvents = [];
  player.on('no-client', () => noClientEvents.push(true));

  await assert.rejects(
    () => player.attach('magnet:?xt=urn:btih:x'),
    (err) => err instanceof PlayerError && err.code === 'NETWORK_ERROR'
      && err.detail?.reason === 'NO_CLIENT',
  );
  assert.equal(player.state, 'degraded');
  assert.equal(noClientEvents.length, 1);

  // 降级后仍允许销毁回收
  await player.destroy();
});

test('attach：种子错误映射为 ATTACH_FAILED', async () => {
  class ErrClient extends Emitter {
    add(_id, _o, cb) {
      setImmediate(() => cb?.(new Error('invalid torrent')));
    }
  }
  const player = new WebTorrentPlayer({ clientFactory: async () => ErrClient });
  await assert.rejects(
    () => player.attach('bad-id'),
    (err) => err instanceof PlayerError && err.code === 'NETWORK_ERROR'
      && err.detail?.reason === 'ATTACH_FAILED',
  );
  await player.destroy().catch(() => {});
});

test('attach 后 destroy 重复调用幂等', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
  await player.attach('magnet:?x');
  await player.destroy();
  await player.destroy(); // 第二次应静默
  assert.equal(player.state, 'destroyed');
});

// ── loadWebTorrent 加载器 ────────────────────────────────

test('loadWebTorrent：全局注入优先', async () => {
  const saved = globalThis.WebTorrent;
  globalThis.WebTorrent = function FakeWT() {};
  try {
    const WT = await loadWebTorrent({ cdnUrls: [] });
    assert.equal(WT, globalThis.WebTorrent);
  } finally {
    if (saved === undefined) delete globalThis.WebTorrent;
    else globalThis.WebTorrent = saved;
  }
});

test('loadWebTorrent：全部 CDN 失败返回 null（不抛错）', async () => {
  const bad = 'data:text/javascript,' + encodeURIComponent('throw new Error("cdn down")');
  const WT = await loadWebTorrent({ cdnUrls: [bad], timeoutMs: 2000 });
  assert.equal(WT, null);
});


// ── 评审 round-1 修复锁定：运行期错误转发 / 状态收敛 ────────

test('评审修复：元数据就绪后 client 错误持续转发（NETWORK_ERROR/CLIENT），且不随 attach 累积', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
  await player.attach('magnet:?xt=urn:btih:' + '11'.repeat(20));
  const client = player.client;

  let errors = [];
  player.on('error', (e) => errors.push(e));

  client.emit('error', new Error('tracker swarm dead'));
  client.emit('error', new Error('second'));
  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'NETWORK_ERROR');
  assert.equal(errors[0].detail?.reason, 'CLIENT');

  // 同一 client 上再次 attach：转发器不得重复注册（再触发一次仅 +1）
  await player.attach('magnet:?xt=urn:btih:' + '22'.repeat(20));
  client.emit('error', new Error('third'));
  assert.equal(errors.length, 3);

  // destroy 后不再转发
  await player.destroy();
  client.emit('error', new Error('after destroy'));
  assert.equal(errors.length, 3);
});

test('评审修复：torrent 运行错误/警告转发', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
  const ready = new Promise((r) => player.once('ready', r));
  await player.attach('magnet:?xt=urn:btih:' + '33'.repeat(20));
  await ready;
  const torrent = player.torrent;

  const errs = []; const warns = [];
  player.on('error', (e) => errs.push(e));
  player.on('warning', (w) => warns.push(w));

  torrent.emit('warning', { message: 'tracker timeout' });
  torrent.emit('error', new Error('swarm disconnected'));

  assert.equal(warns.length, 1);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'NETWORK_ERROR');
  assert.equal(errs[0].detail?.reason, 'TORRENT');
  await player.destroy();
});

test('评审修复：无可播文件 → NOT_SUPPORTED 且 state 收敛为 degraded', async () => {
  class NoMediaClient extends FakeClient {
    constructor() { super(0, { noMedia: true }); }
  }
  const player = new WebTorrentPlayer({ clientFactory: async () => NoMediaClient });
  await assert.rejects(
    () => player.attach('magnet:?xt=urn:btih:' + '44'.repeat(20)),
    (e) => e.code === 'NOT_SUPPORTED',
  );
  assert.equal(player.state, 'degraded'); // 不再永久卡 loading
  await player.destroy();
});
