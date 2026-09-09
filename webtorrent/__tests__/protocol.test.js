/**
 * protocol.test.js —— bencode 往返 / .torrent 解析 / piece 映射与决策 / assembler
 *
 * 对齐 PRD webtorrent 验收点名：
 *   bencode 往返；固定种子 piece 决策可复现；跨 piece 映射；
 *   assembler 头部齐备即产前缀；断 mock → 等待续传无异常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bdecode, bencode, decodeAt, parseTorrent, buildSingleFileTorrent,
  rangesToPieces, pieceIndexFor, planSequentialPieces,
  TorrentAssembler, TorrentFileSource, createSource,
} from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';

// ── bencode ──────────────────────────────────────────────

test('bencode：嵌套结构编解码往返', () => {
  const value = new Map([
    ['announce', 'https://tracker.example/announce'],
    ['info', new Map([
      ['name', 'sample.webm'],
      ['length', 12345],
      ['piece length', 16384],
    ])],
    ['list', [1, 'two', new Uint8Array([9, 9])]],
  ]);
  const dec = new TextDecoder();
  const round = bdecode(bencode(value));
  assert.equal(dec.decode(round.get('announce')), 'https://tracker.example/announce');
  const info = round.get('info');
  assert.equal(dec.decode(info.get('name')), 'sample.webm');
  assert.equal(info.get('length'), 12345);
  assert.equal(info.get('piece length'), 16384);
  const list = round.get('list');
  assert.equal(list[0], 1);
  assert.equal(dec.decode(list[1]), 'two');
  assert.deepEqual([...list[2]], [9, 9]);
});

test('bencode：整数边界（0/负数）与前导零拒绝', () => {
  assert.equal(bdecode(new TextEncoder().encode('i0e')), 0);
  assert.equal(bdecode(new TextEncoder().encode('i-42e')), -42);
  assert.throws(() => bdecode(new TextEncoder().encode('i04e')), PlayerError);
});

test('bencode：字节串含二进制载荷（非 UTF8 安全）', () => {
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = i;
  const back = bdecode(bencode(payload));
  assert.deepEqual([...back], [...payload]);
});

test('bencode：字典键按字节序输出（规范要求）', () => {
  const map = new Map([['zz', 1], ['aa', 2], ['mm', 3]]);
  const enc = new TextDecoder().decode(bencode(map));
  assert.ok(enc.indexOf('aa') < enc.indexOf('mm') && enc.indexOf('mm') < enc.indexOf('zz'), enc);
});

test('bencode：截断/多余数据报 PARSE_ERROR', () => {
  assert.throws(() => bdecode(new TextEncoder().encode('i5')), PlayerError);
  assert.throws(() => bdecode(new TextEncoder().encode('i5ei1e')), PlayerError); // 尾部多余
  assert.throws(() => bdecode(new TextEncoder().encode('d4:name')), PlayerError);
});

test('bencode：UTF-8 键解码（值为字节串）', () => {
  const dec = new TextDecoder();
  const m = bdecode(bencode(new Map([['名称', '值']])));
  // 键转字符串；值保留字节串（bencode 语义）
  assert.deepEqual([...m.get('名称')], [...new TextEncoder().encode('值')]);
});

// ── .torrent 解析 ────────────────────────────────────────

test('parseTorrent：单文件字段齐全、numPieces 向上取整', () => {
  const bytes = buildSingleFileTorrent({ name: 'a.bin', length: 40000, pieceLength: 16384 });
  const t = parseTorrent(bytes);
  assert.equal(t.name, 'a.bin');
  assert.equal(t.size, 40000);
  assert.equal(t.pieceLength, 16384);
  assert.equal(t.numPieces, Math.ceil(40000 / 16384)); // 3 片
  assert.equal(t.files[0].path, 'a.bin');
  assert.equal(t.files[0].offset, 0);
  assert.ok(t.announce.length >= 1);
});

test('parseTorrent：多文件偏移累加', () => {
  // 手工构造双文件 torrent
  const pieces = new Uint8Array(20); // 1 片即可
  const root = new Map([
    ['announce', 'x'],
    ['info', new Map([
      ['name', 'pack'],
      ['piece length', 32768],
      ['pieces', pieces],
      ['files', [
        new Map([['length', 100], ['path', ['sub', 'a.txt']]]),
        new Map([['length', 50], ['path', ['b.mkv']]]),
      ]],
    ])],
  ]);
  const t = parseTorrent(bencode(root));
  assert.equal(t.size, 150);
  assert.deepEqual(t.files.map((f) => f.offset), [0, 100]);
  assert.equal(t.files[1].path, 'pack/b.mkv');
});

test('parseTorrent：坏输入报 PARSE_ERROR', () => {
  assert.throws(() => parseTorrent(new TextEncoder().encode('not-bencode')), PlayerError);
  const noInfo = bencode(new Map([['announce', 'x']]));
  assert.throws(() => parseTorrent(noInfo), PlayerError);
});

// ── piece 映射与确定性决策 ───────────────────────────────

test('rangesToPieces：片内单映射', () => {
  const r = rangesToPieces(10, 4, 16, 8);
  assert.deepEqual(r, [{ index: 0, start: 10, end: 14 }]);
});

test('rangesToPieces：跨两片与三片的精确切分', () => {
  const two = rangesToPieces(12, 8, 16, 8); // 12..20 跨 0/1
  assert.deepEqual(two, [
    { index: 0, start: 12, end: 16 },
    { index: 1, start: 0, end: 4 },
  ]);
  const three = rangesToPieces(14, 40, 16, 8); // 14..54 跨 0/1/2/3
  assert.equal(three.length, 4);
  assert.deepEqual(three.map((p) => p.index), [0, 1, 2, 3]);
  assert.equal(three.at(-1).end, 6);
});

test('rangesToPieces：末端钳制到 numPieces', () => {
  const r = rangesToPieces(30, 1000, 16, 2); // 只剩第 1 片部分
  assert.deepEqual(r.map((p) => p.index), [1]);
  assert.equal(r[0].end, 16); // 钳到片界（调用方再按 size 截）
});

test('planSequentialPieces：同参数两次调用结果逐元素相等（可复现）', () => {
  const a = planSequentialPieces({ numPieces: 7, firstIndex: 3 });
  const b = planSequentialPieces({ numPieces: 7, firstIndex: 3 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, [3, 4, 5, 6, 0, 1, 2]); // 从起点环绕补齐
});

test('planSequentialPieces：默认从头顺序；wrapFirst 头部段殿后', () => {
  assert.deepEqual(planSequentialPieces({ numPieces: 4 }), [0, 1, 2, 3]);
  const wrapped = planSequentialPieces({ numPieces: 4, firstIndex: 2, wrapFirst: true });
  assert.deepEqual(wrapped, [2, 3, 0, 1]);
});

// ── assembler ────────────────────────────────────────────

function makeAssembler(numBytes, pieceLength) {
  return new TorrentAssembler({ size: numBytes, pieceLength });
}
const fillPiece = (index, pieceLength, seed = index) =>
  new Uint8Array(Array.from({ length: pieceLength }, (_, i) => (index + seed + i) & 0xff));

test('assembler：头部齐备即产前缀，prefix 事件随推进触发', async () => {
  const asm = makeAssembler(48, 16);
  let prefixSeen = 0;
  asm.on('prefix', ({ prefixBytes }) => { prefixSeen = prefixBytes; });

  assert.equal(asm.canReadNow(0, 1), false); // 未写任何片
  asm.writePiece(0, fillPiece(0, 16));
  assert.equal(asm.prefixBytes, 16);
  assert.equal(prefixSeen, 16);

  asm.writePiece(1, fillPiece(1, 16));
  assert.equal(asm.prefixBytes, 32);
  const head = await asm.read(0, 20); // 跨片读
  assert.equal(head.length, 20);
});

test('assembler：乱序到达时 read 挂起等待续传，补齐后自动完成（不抛错）', async () => {
  const asm = makeAssembler(32, 16);
  asm.writePiece(1, fillPiece(1, 16)); // 先到第二片

  const pending = asm.read(0, 24); // 需要 0/1 两片；0 缺失 → 挂起
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false); // 断 mock：等待中不抛不崩

  asm.writePiece(0, fillPiece(0, 16)); // 续传到位
  const data = await pending;
  assert.equal(data.length, 24);
});

test('assembler：末尾部分片长度校验与 EOF 短读', async () => {
  const asm = makeAssembler(40, 16); // 末片仅 8B
  assert.equal(asm.numPieces, 3);
  assert.equal(asm.writePiece(2, fillPiece(2, 16)), false); // 末片长度必须 8
  const last = new Uint8Array(8).fill(7);
  assert.equal(asm.writePiece(2, last), true);
  // 头部前缀尚未建立：先补齐前两片再读
  asm.writePiece(0, fillPiece(0, 16));
  asm.writePiece(1, fillPiece(1, 16));
  assert.equal(await asm.read(0, 4).then((u) => u.length), 4);

  const eof = await asm.read(36, 100); // 跨末尾 → 短读 4B
  assert.equal(eof.length, 4);
  // 完全越界 → reject SOURCE_ERROR（评审严重1）
  await assert.rejects(() => asm.read(41, 2), (e) => e.code === 'SOURCE_ERROR');
});

test('assembler：verifyPiece 注入可拒绝毁坏片；progress/complete 正确', () => {
  const asm = new TorrentAssembler({
    size: 32, pieceLength: 16,
    verifyPiece: (idx, bytes) => bytes[0] === idx, // 约定首字节=片号才算好片
  });
  assert.equal(asm.writePiece(0, new Uint8Array(16).fill(9)), false); // 校验失败
  assert.equal(asm.progress, 0);
  assert.equal(asm.writePiece(0, new Uint8Array(16).fill(0)), true);
  assert.equal(asm.has(0), true);
  assert.equal(asm.complete, false);
});

test('assembler：destroy 幂等；等待中的 read 以 ABORTED 结束', async () => {
  const asm = makeAssembler(64, 16);
  const pending = asm.read(0, 64); // 无任何片 → 挂起
  const assertionPromise = assert.rejects(() => pending, (e) => e.code === 'ABORTED');
  asm.destroy();
  await assertionPromise;
  await asm.destroy(); // 幂等
  await assert.rejects(() => asm.read(0, 1), (e) => e.code === 'STATE_ERROR');
});

// ── createSource 离线路径（§10 传输层形状）────────────────

test('createSource：.torrent 字节 → 就绪 DataSource + meta 文件树', async () => {
  const torrentBytes = buildSingleFileTorrent({
    name: 'movie.webm', length: 1000, pieceLength: 256,
  });
  const { source, meta } = await createSource(torrentBytes);

  assert.equal(meta.mode, 'offline');
  assert.equal(meta.pieceLength, 256);
  assert.equal(meta.numPieces, Math.ceil(1000 / 256));
  assert.deepEqual(meta.files, [{ path: 'movie.webm', length: 1000 }]);

  // DataSource 契约面
  assert.equal(source.size, 1000);
  // 未喂任何 piece：read 挂起（等待续传），喂齐后返回正确字节
  const pending = source.read(0, 300);
  const assembler = meta.assembler;
  for (let idx = 0; idx < meta.numPieces; idx++) {
    const start = idx * meta.pieceLength;
    const len = Math.min(meta.pieceLength, 1000 - start);
    const piece = new Uint8Array(len).fill(idx + 1);
    assembler.writePiece(idx, piece);
  }
  const data = await pending;
  assert.equal(data.length, 300);
  assert.equal(data[0], 1);
  assert.equal(data[255], 1);   // 第 0 片最后一字节
  assert.equal(data[256], 2);   // 第 1 片第一字节（跨片连续性）
  source.close();
});

test('createSource：字符串 magnet 在库缺失时 reject NETWORK_ERROR(NO_CLIENT)', async () => {
  await assert.rejects(
    () => createSource(`magnet:?xt=urn:btih:${'ab'.repeat(20)}`, {
      clientFactory: async () => null, // 注入：可选依赖不可用
    }),
    (e) => e.code === 'NETWORK_ERROR' && e.detail?.reason === 'NO_CLIENT',
  );
});

// ── 补充边界（凑足 webtorrent ≥40 例门槛）─────────────────

test('bencode：负整数与嵌套列表往返', () => {
  const v = new Map([['n', -7], ['l', [1, [2, [3]]]]]);
  const dec = bdecode(bencode(v));
  assert.equal(dec.get('n'), -7);
  assert.deepEqual(dec.get('l')[1][1], [3]);
});

test('bencode：1KiB 长字节串往返', () => {
  const big = new Uint8Array(1024).map((_, i) => i & 0xff);
  assert.deepEqual([...bdecode(bencode(big))], [...big]);
});

test('decodeAt：指定偏移解码并返回下一位置', () => {
  const buf = new TextEncoder().encode('i42ei7e');
  const [v, next] = decodeAt(buf, 0);
  assert.equal(v, 42);
  assert.equal(next, 4); // i42e 共 4 字节，下一个元素从偏移 4 开始
});

test('rangesToPieces：零长度/负偏移返回空数组', () => {
  assert.deepEqual(rangesToPieces(0, 0, 16, 4), []);
  assert.deepEqual(rangesToPieces(-1, 4, 16, 4), []);
});

test('pieceIndexFor：偏移到片号换算', () => {
  assert.equal(pieceIndexFor(0, 256), 0);
  assert.equal(pieceIndexFor(255, 256), 0);
  assert.equal(pieceIndexFor(256, 256), 1);
  assert.equal(pieceIndexFor(511, 256), 1);
});


test('buildSingleFileTorrent：同参数两次构建字节完全一致（确定性）', () => {
  const a = buildSingleFileTorrent({ name: 'x.bin', length: 5000, pieceLength: 1024 });
  const b = buildSingleFileTorrent({ name: 'x.bin', length: 5000, pieceLength: 1024 });
  assert.deepEqual([...a], [...b]);
});

test('parseTorrent：announce-list 多层合并去重', () => {
  const root = new Map([
    ['announce', 'https://t1/a'],
    ['announce-list', [['https://t1/a'], ['wss://t2/b', 'https://t3/c']]],
    ['info', new Map([
      ['name', 'm'], ['piece length', 16384],
      ['pieces', new Uint8Array(20)], ['length', 1],
    ])],
  ]);
  const t = parseTorrent(bencode(root));
  assert.equal(t.announce.length, 3); // 去重后
  assert.ok(t.announce.includes('wss://t2/b'));
});

test('TorrentFileSource：size 字段为契约主名、byteLength 为别名；构造守卫', () => {
  const file = { name: 'f.webm', length: 8, stream: () => new ReadableStream({ start(c) { c.close(); } }) };
  const src = new TorrentFileSource(file);
  assert.equal(src.size, 8);
  assert.equal(src.byteLength, 8);
  assert.throws(() => new TorrentFileSource({ name: 'bad' }), /stream\(\) 或 slice\(\)/);
});

test('planSequentialPieces：非法参数报 PARSE_ERROR', () => {
  assert.throws(() => planSequentialPieces({ numPieces: 0 }), PlayerError);
  assert.throws(() => planSequentialPieces({ numPieces: -1 }), PlayerError);
});



test('评审修复：向后回拖距离受 maxBackfillBytes 上限保护', async () => {
  const bytes = new Uint8Array(2048).fill(5);
  class TinyFile {
    constructor(){ this.name='t.bin'; }
    get length(){ return bytes.length; }
    stream(){
      const self=this; let pos=0;
      return new ReadableStream({
        pull(c){ if(pos>=bytes.length){c.close();return;} const n=Math.min(64, bytes.length-pos); c.enqueue(bytes.subarray(pos,pos+n)); pos+=n; },
        cancel(){ self.restarts=(self.restarts||0)+1; },
      });
    }
  }
  const file = new TinyFile();
  const src = new TorrentFileSource(file, { maxBackfillBytes: 32 });
  await src.read(0, 16);
  await src.read(1024, 16);   // 前进到远处
  await assert.rejects(
    () => src.read(0, 8),      // 回拖距离远超 32B 上限
    (e) => e.code === 'SOURCE_ERROR',
  );
});

test('评审修复：离线 createSource 的 meta.infoHash 与 sha1(info 字典) 一致', async () => {
  const { createHash } = await import('node:crypto');
  const torrentBytes = buildSingleFileTorrent({ name: 'ih.webm', length: 300, pieceLength: 128 });
  const { computeInfoHash } = await import('../src/index.js');
  const parsed = parseTorrent(torrentBytes);
  const expectHex = createHash('sha1').update(parsed.infoBytes).digest('hex');

  const { meta } = await createSource(torrentBytes);
  assert.equal(meta.infoHash, expectHex);
  assert.equal(await computeInfoHash(parsed.infoBytes), expectHex);
});
