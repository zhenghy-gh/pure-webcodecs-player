/**
 * webtorrent-source-edge.test.js —— source/assembler/piece-map/torrent-file/player 错误分支补测
 *
 * 既有 source.test.js / protocol.test.js / player.test.js 覆盖主路径；
 * 本文件专攻守卫与畸形分支：
 *   - TorrentFileSource：slice 多种返回类型（ArrayBuffer/Blob 式/垃圾）、零长读、
 *     参数校验 BAD_ARGS、零长块防死循环
 *   - TorrentAssembler：构造守卫、writePiece 全部拒绝分支、read 参数与边界
 *   - piece-map：pieceLength 非法、firstIndex 负数归一化、非整数 numPieces
 *   - torrent-file：坏 pieceLength / pieces 未对齐 / root 非 Map、buildSingleFileTorrent 零长
 *   - WebTorrentPlayer：destroy 后 attach、空 torrentId、stats 定时器
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TorrentFileSource, TorrentAssembler, rangesToPieces, planSequentialPieces,
  parseTorrent, buildSingleFileTorrent, WebTorrentPlayer, bencode, Emitter,
} from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';

// ── TorrentFileSource：slice 路径返回类型与边界 ───────────

class StaticSliceFile {
  constructor(bytes) { this.name = 's.bin'; this.bytes = bytes; }
  get length() { return this.bytes.length; }
  slice(start, end) { return this.bytes.slice(start, Math.min(end, this.bytes.length)); }
}

test('TorrentFileSource：read length=0 立即返回空（不触碰底层）', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const src = new TorrentFileSource(new StaticSliceFile(bytes));
  const empty = await src.read(0, 0);
  assert.equal(empty.length, 0);
  // length=0 时不做 OOB 检查：末尾 offset 也返回空
  assert.equal((await src.read(bytes.length, 0)).length, 0);
});

test('TorrentFileSource：非整数 offset（NaN/小数）报 BAD_ARGS', async () => {
  const src = new TorrentFileSource(new StaticSliceFile(new Uint8Array(8)));
  await assert.rejects(() => src.read(NaN, 1), (e) => e.detail?.reason === 'BAD_ARGS');
  await assert.rejects(() => src.read(1.5, 1), (e) => e.detail?.reason === 'BAD_ARGS');
  await assert.rejects(() => src.read(0, 2.5), (e) => e.detail?.reason === 'BAD_ARGS');
});

test('TorrentFileSource：slice 返回 ArrayBuffer 时正确包装', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const file = {
    name: 'ab.bin',
    length: bytes.length,
    slice: (s, e) => bytes.buffer.slice(s, e), // 返回 ArrayBuffer
  };
  const src = new TorrentFileSource(file);
  const out = await src.read(1, 2);
  assert.deepEqual([...out], [8, 7]);
});

test('TorrentFileSource：slice 返回 Blob 式（arrayBuffer()）时正确包装', async () => {
  const bytes = new Uint8Array([5, 4, 3, 2, 1]);
  const file = {
    name: 'blob.bin',
    length: bytes.length,
    slice: (s, e) => ({
      arrayBuffer: async () => bytes.buffer.slice(s, e),
    }),
  };
  const src = new TorrentFileSource(file);
  const out = await src.read(2, 3);
  assert.deepEqual([...out], [3, 2, 1]);
});

test('TorrentFileSource：slice 返回不支持的类型报 BAD_SLICE', async () => {
  const file = {
    name: 'bad.bin',
    length: 10,
    slice: () => 'not-a-buffer',
  };
  const src = new TorrentFileSource(file);
  await assert.rejects(() => src.read(0, 1), (e) => e.detail?.reason === 'BAD_SLICE');
});

test('TorrentFileSource：size=0 文件任意读返回空（this.size falsy 跳过 OOB 检查）；顺序流零长块不死循环', async () => {
  const empty = new TorrentFileSource(new StaticSliceFile(new Uint8Array(0)));
  // 现行为：size=0 时 `this.size && offset >= size` 短路，OOB 检查被跳过，走 EOF 短读返回空
  const out = await empty.read(0, 1);
  assert.equal(out.length, 0);

  // 顺序流中途产出零长块：read 应正常完成（零长块只发一次，否则源会无限跳过）
  const data = new Uint8Array(16).fill(3);
  let pos = 0;
  let emittedZero = false;
  const zeroChunkFile = {
    name: 'z.bin',
    length: data.length,
    stream() {
      return new ReadableStream({
        pull(c) {
          if (pos >= data.length) { c.close(); return; }
          if (!emittedZero) { emittedZero = true; c.enqueue(new Uint8Array(0)); return; }
          const n = Math.min(8, data.length - pos);
          c.enqueue(data.subarray(pos, pos + n));
          pos += n;
        },
      });
    },
  };
  const seq = new TorrentFileSource(zeroChunkFile);
  const seqOut = await seq.read(0, 16);
  assert.deepEqual([...seqOut], [...data]);
});

// ── TorrentAssembler：构造守卫与拒绝分支 ─────────────────

test('TorrentAssembler：非法 size / pieceLength 构造即抛', () => {
  assert.throws(() => new TorrentAssembler({ size: -1, pieceLength: 16 }), PlayerError);
  assert.throws(() => new TorrentAssembler({ size: 1.5, pieceLength: 16 }), PlayerError);
  assert.throws(() => new TorrentAssembler({ size: 32, pieceLength: 0 }), PlayerError);
  assert.throws(() => new TorrentAssembler({ size: 32, pieceLength: -16 }), PlayerError);
  assert.throws(() => new TorrentAssembler({ size: 32, pieceLength: 1.5 }), PlayerError);
});

test('TorrentAssembler：writePiece 拒绝越界/非整数/重复/销毁后写入', () => {
  const asm = new TorrentAssembler({ size: 32, pieceLength: 16 });
  const piece = new Uint8Array(16);
  assert.equal(asm.writePiece(-1, piece), false);
  assert.equal(asm.writePiece(2, piece), false);       // 越界（numPieces=2）
  assert.equal(asm.writePiece(0.5, piece), false);
  assert.equal(asm.writePiece(0, new Uint8Array(15)), false); // 长度不符
  assert.equal(asm.writePiece(0, 'bytes'), false);     // 非字节类型
  assert.equal(asm.writePiece(0, piece), true);
  assert.equal(asm.writePiece(0, piece), false);       // 重复写入
  asm.destroy();
  assert.equal(asm.writePiece(1, piece), false);       // 销毁后
});

test('TorrentAssembler：read 负长度 SOURCE_ERROR；length=0 空返回；canReadNow 越界恒真', async () => {
  const asm = new TorrentAssembler({ size: 32, pieceLength: 16 });
  await assert.rejects(() => asm.read(0, -1), (e) => e.code === 'SOURCE_ERROR');
  await assert.rejects(() => asm.read(-1, 1), (e) => e.code === 'SOURCE_ERROR');
  assert.equal((await asm.read(0, 0)).length, 0);
  assert.equal(asm.canReadNow(100, 1), true); // offset >= size 恒可读（零长）
  await assert.rejects(() => asm.read(32, 1), (e) => e.code === 'SOURCE_ERROR'); // 越界
});

// ── piece-map 补充边界 ───────────────────────────────────

test('rangesToPieces：pieceLength 非法抛 PARSE_ERROR', () => {
  assert.throws(() => rangesToPieces(0, 1, 0, 4), PlayerError);
  assert.throws(() => rangesToPieces(0, 1, -16, 4), PlayerError);
});

test('planSequentialPieces：firstIndex 负数/越界归一化到 [0, numPieces)', () => {
  assert.deepEqual(
    planSequentialPieces({ numPieces: 4, firstIndex: -1 }),
    [3, 0, 1, 2],
  );
  assert.deepEqual(
    planSequentialPieces({ numPieces: 4, firstIndex: 5 }), // 5 % 4 = 1
    [1, 2, 3, 0],
  );
  assert.deepEqual(
    planSequentialPieces({ numPieces: 3, firstIndex: -4 }), // -4 % 3 → -1 → 归一 2
    [2, 0, 1],
  );
});

test('planSequentialPieces：非整数 numPieces 抛 PARSE_ERROR', () => {
  assert.throws(() => planSequentialPieces({ numPieces: 2.5 }), PlayerError);
  assert.throws(() => planSequentialPieces({ numPieces: '4' }), PlayerError);
});

// ── torrent-file 补充分支 ────────────────────────────────

function makeRoot(infoExtra) {
  return bencode(new Map([
    ['announce', 'x'],
    ['info', new Map([
      ['name', 't'], ['piece length', 16384], ['pieces', new Uint8Array(20)], ['length', 1],
      ...infoExtra,
    ])],
  ]));
}

test('parseTorrent：坏 pieceLength / pieces 未 20B 对齐 / root 非 Map 均抛 PARSE_ERROR', () => {
  const badPieceLen = bencode(new Map([
    ['info', new Map([['piece length', 0], ['pieces', new Uint8Array(20)], ['length', 1]])],
  ]));
  assert.throws(() => parseTorrent(badPieceLen), PlayerError);

  const misaligned = bencode(new Map([
    ['info', new Map([['piece length', 16384], ['pieces', new Uint8Array(21)], ['length', 1]])],
  ]));
  assert.throws(() => parseTorrent(misaligned), (e) => /20B 对齐/.test(e.message));

  assert.throws(() => parseTorrent(new TextEncoder().encode('i1e')), (e) => /info 字典/.test(e.message));
});

test('parseTorrent：info 缺 pieces 字段抛 PARSE_ERROR', () => {
  const noPieces = bencode(new Map([
    ['info', new Map([['piece length', 16384], ['length', 1]])],
  ]));
  assert.throws(() => parseTorrent(noPieces), PlayerError);
});

test('parseTorrent：announce-list 中非数组 tier 被跳过', () => {
  const t = parseTorrent(makeRoot([])); // 基线可解析
  assert.equal(t.size, 1);
  const bytes = bencode(new Map([
    ['announce', 'https://only/a'],
    ['announce-list', ['not-an-array', ['https://real/b']]],
    ['info', new Map([
      ['name', 't'], ['piece length', 16384], ['pieces', new Uint8Array(20)], ['length', 1],
    ])],
  ]));
  const parsed = parseTorrent(bytes);
  assert.deepEqual(parsed.announce, ['https://only/a', 'https://real/b']);
});

test('buildSingleFileTorrent：length=0 与 length<pieceLength 构造合法', () => {
  const zero = parseTorrent(buildSingleFileTorrent({ length: 0, pieceLength: 1024 }));
  assert.equal(zero.numPieces, 1); // Math.max(1, 0)
  assert.equal(zero.size, 0);

  const tiny = parseTorrent(buildSingleFileTorrent({ length: 100, pieceLength: 1024 }));
  assert.equal(tiny.numPieces, 1);
  assert.equal(tiny.size, 100);
});

// ── WebTorrentPlayer 守卫与 stats ────────────────────────

class FakeTorrent extends Emitter {}

class FakeClient extends Emitter {
  constructor() { super(); this.destroyed = false; }
  add(_id, _o, cb) {
    const f = { name: 'a.mp4', length: 4 };
    f.stream = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); c.close(); } });
    const t = new FakeTorrent();
    Object.assign(t, { name: 't', infoHash: 'f'.repeat(40), files: [f], peers: {}, destroy: async () => {} });
    setImmediate(() => cb?.(null, t));
  }
  async destroy() { this.destroyed = true; }
}

test('WebTorrentPlayer：destroy 后 attach 报 STATE_ERROR', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
  await player.attach('magnet:?xt=urn:btih:' + '11'.repeat(20));
  await player.destroy();
  await assert.rejects(() => player.attach('magnet:?xt=urn:btih:x'), (e) => e.code === 'STATE_ERROR');
});

test('WebTorrentPlayer：空/缺失 torrentId 报 PARSE_ERROR', async () => {
  const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
  await assert.rejects(() => player.attach(''), (e) => e.code === 'PARSE_ERROR');
  await assert.rejects(() => player.attach(undefined), (e) => e.code === 'PARSE_ERROR');
});

test('WebTorrentPlayer：stats 定时器每秒产出进度快照', async () => {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const player = new WebTorrentPlayer({ clientFactory: async () => FakeClient });
    const stats = [];
    player.on('stats', (s) => stats.push(s));
    const attachP = player.attach('magnet:?xt=urn:btih:' + '55'.repeat(20));
    mock.timers.tick(1); // 推进 FakeClient.add 的 setTimeout(0)
    await attachP;

    mock.timers.tick(1000);
    mock.timers.tick(1000);
    assert.equal(stats.length, 2);
    assert.equal(stats[0].progress, 0);
    assert.equal(stats[0].peers, 0);
    assert.equal(stats[0].timeRemaining, Infinity);

    await player.destroy(); // 应 clearInterval，后续 tick 不再产出
    const n = stats.length;
    mock.timers.tick(3000);
    assert.equal(stats.length, n);
  } finally {
    mock.timers.reset();
  }
});

// ── 缺陷回归（第九十二波）─────────────────────────────

test('TorrentFileSource：顺序流路径 OOB 也抛 OUT_OF_RANGE（与 slice 路径一致）', async () => {
  // 修复前：#readSequential 无入口检查，offset ≥ size 时静默返回空数组
  const file = {
    name: 'oob.bin',
    length: 8,
    stream() {
      return new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(8)); c.close(); },
      });
    },
  };
  const src = new TorrentFileSource(file);
  await assert.rejects(() => src.read(8, 1), (e) => e.detail?.reason === 'OUT_OF_RANGE');
  await assert.rejects(() => src.read(100, 4), (e) => e.detail?.reason === 'OUT_OF_RANGE');
  // 边界内仍正常
  const out = await src.read(4, 4);
  assert.equal(out.length, 4);
});

test('TorrentFileSource：slice 路径 OOB 检查上提入口后行为不变', async () => {
  const src = new TorrentFileSource(new StaticSliceFile(new Uint8Array(8)));
  await assert.rejects(() => src.read(8, 1), (e) => e.detail?.reason === 'OUT_OF_RANGE');
});

test('WebTorrentPlayer：autoSelect=false 抛 STATE_ERROR 且状态 degraded（不静默卡 loading）', async () => {
  const states = [];
  const player = new WebTorrentPlayer({
    clientFactory: async () => FakeClient,
    autoSelect: false,
  });
  player.on('status', (s) => states.push(s));
  await assert.rejects(
    () => player.attach('magnet:?xt=urn:btih:' + '66'.repeat(20)),
    (e) => e.code === 'STATE_ERROR' && /autoSelect/.test(e.message),
  );
  assert.equal(player.state, 'degraded');
  assert.ok(states.includes('degraded'));
  await player.destroy();
});
