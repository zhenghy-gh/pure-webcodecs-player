/**
 * webtorrent-select-file.test.js —— WebTorrentPlayer.selectFile() 手动选文件 API 回归
 *
 * 覆盖（第九十二波 backlog：autoSelect=false 此前「声明可用但实际不可用」）：
 *   - autoSelect:false + selectFile 正常路径（文件对象/文件名/索引/谓词四形态）→ ready 且用指定文件建源；
 *   - 非 degraded 状态调用抛 STATE_ERROR；
 *   - 找不到匹配 → SOURCE_ERROR(FILE_NOT_FOUND) + state 仍 degraded + 可重试；
 *   - 非可播媒体格式 → NOT_SUPPORTED(NOT_MEDIA) + state 仍 degraded + 可重试；
 *   - destroy 后调用抛 STATE_ERROR。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebTorrentPlayer } from '../src/index.js';
import { Emitter } from '../src/utils.js';

// ── 测试桩：多文件 FakeClient（doc.txt / b.mkv / a.mp4）────────

class FakeTorrent extends Emitter {}

function makeFile(name, length) {
  const f = { name, path: name, length };
  f.stream = () => new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(length)); c.close(); },
  });
  return f;
}

class FakeClient extends Emitter {
  constructor() { super(); this.destroyed = false; }
  add(_id, _o, cb) {
    const t = new FakeTorrent();
    Object.assign(t, {
      name: 't',
      infoHash: 'f'.repeat(40),
      files: [makeFile('doc.txt', 10), makeFile('b.mkv', 400), makeFile('a.mp4', 100)],
      peers: {},
      destroy: async () => {},
    });
    setImmediate(() => cb?.(null, t));
  }
  async destroy() { this.destroyed = true; }
}

/** autoSelect:false attach 到 degraded 的公共前置 */
async function attachDegraded(player) {
  await assert.rejects(
    () => player.attach('magnet:?xt=urn:btih:' + '77'.repeat(20)),
    (e) => e.code === 'STATE_ERROR' && /autoSelect/.test(e.message),
  );
  assert.equal(player.state, 'degraded');
}

// ── 正常路径 ─────────────────────────────────────────────

test('selectFile：文件对象形态 → ready 且用指定文件建源', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);

  const target = player.torrent.files[1]; // b.mkv
  const events = [];
  player.on('ready', (p) => events.push(['ready', p.file.name]));
  player.on('status', (s) => events.push(['status', s]));

  const { file, source } = player.selectFile(target);
  assert.equal(player.state, 'ready');
  assert.equal(file, target);
  assert.equal(source.size, 400); // 用 b.mkv 建源而非自动选择的最大文件
  assert.equal(source.file, target);
  assert.deepEqual(events, [['status', 'ready'], ['ready', 'b.mkv']]);
  await player.destroy();
});

test('selectFile：文件名/索引/谓词三形态均按语义命中', async () => {
  // 文件名精确匹配
  const p1 = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(p1);
  assert.equal(p1.selectFile('a.mp4').file.name, 'a.mp4');
  await p1.destroy();

  // 索引
  const p2 = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(p2);
  assert.equal(p2.selectFile(2).file.name, 'a.mp4');
  await p2.destroy();

  // 谓词（首个匹配）
  const p3 = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(p3);
  const picked = p3.selectFile((f) => f.name.endsWith('.mkv'));
  assert.equal(picked.file.name, 'b.mkv');
  await p3.destroy();
});

test('selectFile：非媒体文件先抛 NOT_SUPPORTED，换合法 selector 重试成功（可重试语义）', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);

  const errors = [];
  player.on('error', (e) => errors.push(e));
  assert.throws(
    () => player.selectFile('doc.txt'),
    (e) => e.code === 'NOT_SUPPORTED' && e.detail?.reason === 'NOT_MEDIA',
  );
  assert.equal(player.state, 'degraded'); // 不静默、不跳走：仍可重试

  const { file } = player.selectFile('b.mkv'); // 重试
  assert.equal(player.state, 'ready');
  assert.equal(file.name, 'b.mkv');
  assert.equal(errors.length, 1);
  await player.destroy();
});

// ── 状态机守卫 ───────────────────────────────────────────

test('selectFile：idle / ready 状态调用抛 STATE_ERROR', async () => {
  // idle：从未 attach
  const idle = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  assert.throws(() => idle.selectFile('a.mp4'), (e) => e.code === 'STATE_ERROR');
  assert.equal(idle.state, 'idle');

  // ready：已通过 selectFile 完成，不可二次选择
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);
  player.selectFile('a.mp4');
  assert.throws(() => player.selectFile('b.mkv'), (e) => e.code === 'STATE_ERROR');
  await player.destroy();
});

test('selectFile：destroy 后调用抛 STATE_ERROR', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);
  await player.destroy();
  assert.throws(() => player.selectFile('a.mp4'), (e) => e.code === 'STATE_ERROR');
});

// ── 找不到匹配 ───────────────────────────────────────────

test('selectFile：文件名未命中/索引越界/谓词全否/外来对象 → SOURCE_ERROR(FILE_NOT_FOUND)，state 保持 degraded 可重试', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);

  const cases = [
    () => player.selectFile('nope.mp4'),
    () => player.selectFile(3),
    () => player.selectFile(-1),
    () => player.selectFile(() => false),
    () => player.selectFile(makeFile('outsider.mp4', 1)), // 不属于当前种子
  ];
  for (const fn of cases) {
    assert.throws(fn, (e) => e.code === 'SOURCE_ERROR' && e.detail?.reason === 'FILE_NOT_FOUND');
    assert.equal(player.state, 'degraded');
  }

  // 重试仍可用
  assert.equal(player.selectFile('b.mkv').file.name, 'b.mkv');
  await player.destroy();
});

test('selectFile：非法 selector 形态抛 PARSE_ERROR；opts.selectExts 可扩充可播范围', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient, autoSelect: false });
  await attachDegraded(player);
  assert.throws(() => player.selectFile(undefined), (e) => e.code === 'PARSE_ERROR');
  assert.throws(() => player.selectFile(null), (e) => e.code === 'PARSE_ERROR');
  await player.destroy();

  // selectExts 扩充后 .txt 也可手动选中
  const wide = new WebTorrentPlayer({
    clientFactory: async () => FakeClient,
    autoSelect: false,
    selectExts: ['.txt', '.mp4'],
  });
  await attachDegraded(wide);
  assert.equal(wide.selectFile('doc.txt').file.name, 'doc.txt');
  await wide.destroy();
});
