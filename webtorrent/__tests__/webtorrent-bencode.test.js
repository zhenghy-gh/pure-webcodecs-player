/**
 * webtorrent-bencode.test.js —— bencode 编解码错误分支与边界补测
 *
 * 既有 protocol.test.js 覆盖了往返主路径；本文件专攻：
 *   - bdecode 输入守卫 / 尾部空白 / 非法起始字节 / 各容器缺终止符 / 字典键非字节串
 *   - 整数与字节串的畸形形态（前导零、超长长度前缀、越界长度、超大整数）
 *   - bencode 编码拒绝分支（非安全整数、不支持类型、字典键非法）与键字节序排序
 *   - bdecodeRaw（此前完全无测试覆盖的导出）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { bdecode, bencode, bdecodeRaw, decodeAt, parseTorrent, computeInfoHash } from '../src/index.js';
import { PlayerError } from '../../core/src/errors.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);

// ── bdecode 输入与整体结构 ────────────────────────────────

test('bdecode：非 Uint8Array 输入直接拒绝', () => {
  assert.throws(() => bdecode('i1e'), PlayerError);
  assert.throws(() => bdecode(undefined), PlayerError);
  assert.throws(() => bdecode(null), PlayerError);
  assert.throws(() => bdecode(123), PlayerError);
});

test('bdecode：尾部允许空白（空格/制表/换行/回车），非空白拒绝', () => {
  assert.equal(bdecode(enc('i5e \t\n\r')), 5);
  assert.throws(() => bdecode(enc('i5e x')), PlayerError);
  assert.throws(() => bdecode(enc('i5e0')), PlayerError);
});

test('bdecode：空输入与非法起始字节报 PARSE_ERROR', () => {
  assert.throws(() => bdecode(new Uint8Array(0)), PlayerError);
  assert.throws(() => bdecode(enc('x')), PlayerError);
  assert.throws(() => bdecode(enc(' ')), PlayerError);
  assert.throws(() => bdecode(enc('ie')), PlayerError);
});

// ── 整数分支 ─────────────────────────────────────────────

test('bdecode 整数：非法形态拒绝（-0/正号/双负号/空/非数字）', () => {
  assert.throws(() => bdecode(enc('i-0e')), PlayerError);
  assert.throws(() => bdecode(enc('i+5e')), PlayerError);
  assert.throws(() => bdecode(enc('i--1e')), PlayerError);
  assert.throws(() => bdecode(enc('ie')), PlayerError);
  assert.throws(() => bdecode(enc('ix5e')), PlayerError);
  assert.throws(() => bdecode(enc('i5.5e')), PlayerError);
});

test('bdecode 整数：缺少终止符 e 与超大整数（Number 化有损但合法解析）', () => {
  assert.throws(() => bdecode(enc('i123')), PlayerError);
  // 21 位整数超出 2^53：按规范可解析为 Number（精度有损是 Number 语义，非解析错误）
  const big = bdecode(enc(`i${'9'.repeat(21)}e`));
  assert.equal(big, Number('9'.repeat(21)));
});

// ── 字节串分支 ───────────────────────────────────────────

test('bdecode 字节串：缺冒号 / 长度前缀超 12 位 / 长度越界', () => {
  assert.throws(() => bdecode(enc('5hello')), PlayerError); // 缺冒号
  assert.throws(() => bdecode(enc('99999999999999:x')), PlayerError); // 14 位长度前缀
  assert.throws(() => bdecode(enc('10:abc')), PlayerError); // 声明 10 字节只有 3 字节
  assert.throws(() => bdecode(enc('5:')), PlayerError); // 声明 5 字节实际 0 字节
});

test('bdecode 字节串长度仅接受 ASCII 十进制数字', () => {
  for (const input of ['1e0:a', '1E0:a', '0x1:a', '0X1:a', '1 :a', '1\t:a', '1\n:a', '1\r:a', '1.0:a', 'l1e0:ae', 'd0x1:ai1ee', 'd1:a1e0:ae', '0000000000000:']) {
    assert.throws(() => bdecode(enc(input)), (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR', input);
  }
  assert.throws(() => bdecode(new Uint8Array([0x31, 0xff, 0x3a, 0x61])),
    (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR');
  assert.deepEqual(bdecode(enc('000000000000:')), new Uint8Array());
  assert.deepEqual(bdecode(enc('3:a b')), enc('a b'));
  assert.deepEqual(bdecode(enc('1:a \t\n\r')), enc('a'));
  assert.deepEqual(bdecode(enc('0:')), new Uint8Array());
  assert.deepEqual(bdecode(enc('1:a')), enc('a'));
  assert.deepEqual(bdecode(enc('01:a')), enc('a'));
  assert.deepEqual(bdecode(enc('l1:ae')), [enc('a')]);
  assert.equal(bdecode(enc('d1:ai1ee')).get('a'), 1);
});

test('decodeAt 非零偏移与 bdecodeRaw 共享长度前缀校验', () => {
  const input = enc('xx01:a1:b');
  const [first, next] = decodeAt(input, 2);
  assert.deepEqual(first, enc('a'));
  assert.equal(next, 6);
  assert.deepEqual(decodeAt(input, next), [enc('b'), 9]);
  assert.deepEqual(bdecodeRaw(enc('01:a')), enc('a'));
  for (const invalid of ['1e0:a', '0x1:a', '1 :a', '1.0:a', '0000000000000:']) {
    assert.throws(() => decodeAt(enc(`xx${invalid}`), 2), (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR', invalid);
    assert.throws(() => bdecodeRaw(enc(invalid)), (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR', invalid);
  }
  assert.throws(() => decodeAt(new Uint8Array([0, 0, 0x31, 0xff, 0x3a, 0x61]), 2),
    (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR');
});

test('parseTorrent 拒绝 info 字典中畸形长度并保留合法原始 infohash', async () => {
  const info = (name) => enc(`d6:lengthi1e4:name${name}12:piece lengthi1e6:pieces20:${'x'.repeat(20)}e`);
  const torrent = (rawInfo) => Uint8Array.from([...enc('d4:info'), ...rawInfo, 0x65]);
  for (const bad of ['1e0:a', '0x1:a', '1 :a', '1.0:a']) {
    assert.throws(() => parseTorrent(torrent(info(bad))),
      (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR' && /bencode/.test(e.message), bad);
  }
  const rawInfo = info('01:a');
  const parsed = parseTorrent(torrent(rawInfo));
  assert.equal(parsed.name, 'a');
  assert.equal(parsed.size, 1);
  assert.equal(parsed.pieceLength, 1);
  assert.deepEqual(parsed.infoBytes, rawInfo);
  assert.equal(await computeInfoHash(parsed.infoBytes), createHash('sha1').update(rawInfo).digest('hex'));
});

test('bdecode 字节串：0 长度合法（空字节串）', () => {
  const v = bdecode(enc('0:'));
  assert.ok(v instanceof Uint8Array);
  assert.equal(v.length, 0);
});

// ── 列表 / 字典容器分支 ──────────────────────────────────

test('bdecode 列表：缺终止符 e 拒绝；空列表合法', () => {
  assert.throws(() => bdecode(enc('l1:a')), PlayerError);
  assert.throws(() => bdecode(enc('l')), PlayerError);
  assert.deepEqual(bdecode(enc('le')), []);
});

test('bdecode 字典：缺终止符 / 键非字节串 / 键后缺值均拒绝', () => {
  assert.throws(() => bdecode(enc('d1:a')), PlayerError); // 键后缺值
  assert.throws(() => bdecode(enc('dle1:e')), PlayerError); // 键是列表
  assert.throws(() => bdecode(enc('di1e1:xe')), PlayerError); // 键是整数
  assert.throws(() => bdecode(enc('d')), PlayerError);
});

test('bdecode 字典：重复键后者覆盖；嵌套字典合法', () => {
  const dup = bdecode(enc('d1:ai1e1:ai2ee'));
  assert.equal(dup.get('a'), 2);
  const nested = bdecode(enc('d1:ad1:bi7eee'));
  assert.ok(nested.get('a') instanceof Map);
  assert.equal(nested.get('a').get('b'), 7);
});

test('bdecode：深层嵌套列表（256 层）可解码', () => {
  let s = 'l'.repeat(256) + '1:x' + 'e'.repeat(256);
  let v = bdecode(enc(s));
  for (let i = 0; i < 256; i++) v = v[0];
  assert.equal(dec(v), 'x');
});

// ── bencode 编码拒绝分支 ─────────────────────────────────

test('bencode：非安全整数（小数/超 2^53/Infinity/NaN）拒绝', () => {
  assert.throws(() => bencode(1.5), PlayerError);
  assert.throws(() => bencode(2 ** 53), PlayerError); // 恰好超出安全整数上界
  assert.throws(() => bencode(Infinity), PlayerError);
  assert.throws(() => bencode(NaN), PlayerError);
});

test('bencode：不支持类型（布尔/null/对象/undefined）拒绝', () => {
  assert.throws(() => bencode(true), PlayerError);
  assert.throws(() => bencode(null), PlayerError);
  assert.throws(() => bencode(undefined), PlayerError);
  assert.throws(() => bencode({ a: 1 }), PlayerError);
});

test('bencode：字典键为数字等非法类型拒绝', () => {
  assert.throws(() => bencode(new Map([[1, 'x']])), PlayerError);
});

test('bencode：字典键按字节序（非字典序）排序 —— 大写排在小写前', () => {
  // 字节序 'B'(0x42) < 'a'(0x61)；JS 默认字符串比较同为 'B' < 'a'，但需验证非 localeCompare 语义
  const out = dec(bencode(new Map([['a', 1], ['B', 2]])));
  assert.ok(out.indexOf('1:B') < out.indexOf('1:a'), out);
});

test('bencode：前缀键排序（a < ab）与 Uint8Array 键编码往返', () => {
  const out = dec(bencode(new Map([['ab', 1], ['a', 2]])));
  assert.ok(out.indexOf('1:a') < out.indexOf('2:ab'), out); // 短前缀键在前

  const key = new Uint8Array([0xff, 0x00, 0x7f]);
  const back = bdecode(bencode(new Map([[key, 'v']])));
  // bdecode 把字典键统一经 TextDecoder 转字符串（0xff 非 UTF8 → 替换字符），值仍可达
  const roundKey = [...back.keys()][0];
  assert.equal(typeof roundKey, 'string');
  // 值按 bencode 语义保留为字节串
  assert.deepEqual([...back.get(roundKey)], [...enc('v')]);
});

test('bencode→bdecode：整数 0 / 负数 / 嵌套 Map 键值往返', () => {
  assert.equal(bdecode(bencode(0)), 0);
  assert.equal(bdecode(bencode(-1)), -1);
  assert.equal(bdecode(bencode(2 ** 53 - 1)), 2 ** 53 - 1);
  const v = new Map([['m', new Map([['x', new Uint8Array([1, 2, 3])]])]]);
  const back = bdecode(bencode(v));
  assert.deepEqual([...back.get('m').get('x')], [1, 2, 3]);
});

// ── bdecodeRaw（此前零覆盖的导出） ────────────────────────

test('bdecodeRaw：与 bdecode 同路径 —— 成功解码与错误行为一致', () => {
  assert.deepEqual([...bdecodeRaw(enc('1:a'))], [...enc('a')]);
  assert.equal(bdecodeRaw(enc('i42e')), 42);
  const list = bdecodeRaw(enc('l1:ai2ee'));
  assert.deepEqual([...list[0]], [...enc('a')]);
  assert.equal(list[1], 2);
  assert.throws(() => bdecodeRaw(enc('bad')), PlayerError);
  assert.throws(() => bdecodeRaw('i1e'), PlayerError);
});

// ── 敌意深度：decodeAt 递归必须有上限（第二百零九波）──────

test('bdecode：敌意 50k 层嵌套列表须以 PlayerError 收敛而非裸 RangeError 爆栈', () => {
  const s = 'l'.repeat(50000) + 'e'.repeat(50000);
  assert.throws(() => bdecode(enc(s)), PlayerError);
});

test('bdecode：敌意 50k 层嵌套字典同样以 PlayerError 收敛', () => {
  const s = 'd'.repeat(50000) + 'e'.repeat(50000);
  assert.throws(() => bdecode(enc(s)), PlayerError);
});
