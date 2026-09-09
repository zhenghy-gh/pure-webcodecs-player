/**
 * ebml.test.js —— EBML 基础层单测（VINT / 元素解析 / 值解码 / Writer / Lacing）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  vintLength, readId, readSize, encodeSize, encodeUnknownSize, encodeId,
  readUInt, readInt, readFloat, readDate, readString,
  iterElements, parseTree, decodeValueByType,
  EbmlWriter, ID, TYPE, SCHEMA,
} from '../src/index.js';
import {
  decodeLacing, signedVintValue, encodeSignedVint, encodeXiphHeader, encodeEbmlLacingHeader,
  LACING_NONE, LACING_XIPH, LACING_FIXED, LACING_EBML,
} from '../src/index.js';
import { makeBlock } from './fixtures/make-fixture.mjs';

// ── VINT ──────────────────────────────────────────────────

test('vintLength：首个 1 位即标记位，其位置定长', () => {
  assert.equal(vintLength(0x80), 1);
  assert.equal(vintLength(0xa3), 1);
  assert.equal(vintLength(0xff), 1); // 全 1 = 1 字节（未知长度标记）
  assert.equal(vintLength(0x7f), 2);
  assert.equal(vintLength(0x40), 2);
  assert.equal(vintLength(0x42), 2); // DocType ID 首字节
  assert.equal(vintLength(0x20), 3);
  assert.equal(vintLength(0x18), 4); // Segment ID 首字节
  assert.equal(vintLength(0x1a), 4); // EBML 头 ID 首字节
  assert.equal(vintLength(0x01), 8);
  assert.throws(() => vintLength(undefined));
  assert.throws(() => vintLength(0)); // 无标记位
});

test('readId：保留标记位的规范 ID', () => {
  const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
  assert.deepEqual(readId(bytes, 0), { id: 0x1a45dfa3, length: 4 });

  const b2 = Uint8Array.of(0x42, 0x86);
  assert.deepEqual(readId(b2, 0), { id: 0x4286, length: 2 });

  const b1 = Uint8Array.of(0xe7);
  assert.deepEqual(readId(b1, 0), { id: 0xe7, length: 1 });
});

test('readSize/encodeSize 往返与未知长度', () => {
  for (const v of [0, 1, 127, 128, 300, 503, 65535, 2 ** 21 - 1]) {
    const enc = encodeSize(v);
    const dec = readSize(enc, 0);
    assert.equal(dec.value, v, `size ${v}`);
    assert.equal(dec.unknown, false);
  }
  // 最小编码形态（1 字节可用域 0..126，127 为「未知长度」保留）
  assert.deepEqual([...encodeSize(0)], [0x80]);
  assert.deepEqual([...encodeSize(126)], [0xfe]);
  assert.deepEqual([...encodeSize(127)], [0x40, 0x7f]);
  assert.deepEqual([...encodeSize(128)], [0x40, 0x80]);
  assert.deepEqual([...encodeSize(300)], [0x41, 0x2c]);
  // 强制最小长度
  assert.deepEqual([...encodeSize(5, 2)], [0x40, 0x05]);
  // 未知长度
  for (const len of [1, 2, 8]) {
    const dec = readSize(encodeUnknownSize(len), 0);
    assert.equal(dec.unknown, true);
    assert.equal(dec.value, -1);
    assert.equal(dec.length, len);
  }
  assert.throws(() => encodeSize(-5));
});

test('encodeId：规范 ID 字节还原', () => {
  assert.deepEqual([...encodeId(ID.EBML)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.deepEqual([...encodeId(ID.ClusterTimecode)], [0xe7]);
  assert.deepEqual([...encodeId(ID.DocType)], [0x42, 0x82]);
  assert.deepEqual([...encodeId(ID.EBMLVersion)], [0x42, 0x86]);
  assert.deepEqual([...encodeId(ID.Segment)], [0x18, 0x53, 0x80, 0x67]);
});

// ── 值解码 ────────────────────────────────────────────────

test('readUInt/readInt 二补码语义', () => {
  assert.equal(readUInt(Uint8Array.of(0x01)), 1);
  assert.equal(readUInt(Uint8Array.of(0x12, 0x34)), 0x1234);
  assert.equal(readInt(Uint8Array.of(0xff, 0xff)), -1);
  assert.equal(readInt(Uint8Array.of(0x80, 0x00)), -32768);
  assert.equal(readInt(Uint8Array.of(0x7f, 0xff)), 32767);
  assert.equal(readInt(Uint8Array.of(0xff)), -1);
});

test('readFloat 支持 0/4/8 字节宽度', () => {
  assert.equal(readFloat(new Uint8Array(0)), 0);
  const f32 = new Uint8Array(4);
  new DataView(f32.buffer).setFloat32(0, 1.5, false); // 规范为大端
  assert.equal(readFloat(f32), 1.5);
  const f64 = new Uint8Array(8);
  new DataView(f64.buffer).setFloat64(0, 1234.5678, false);
  assert.ok(Math.abs(readFloat(f64) - 1234.5678) < 1e-9);
  assert.throws(() => readFloat(Uint8Array.of(1, 2, 3)));
});

test('readDate：2001 纪元纳秒 → JS 毫秒', () => {
  const EPOCH_2001 = Date.UTC(2001, 0, 1);
  // 0 纳秒
  assert.equal(readDate(new Uint8Array(8)), EPOCH_2001);
  // 123456789 ms 的纳秒
  const ns = BigInt(123456789) * 1000000n;
  let big = ns;
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { bytes[i] = Number(big & 0xffn); big >>= 8n; }
  assert.equal(readDate(bytes), EPOCH_2001 + 123456789);
  assert.throws(() => readDate(Uint8Array.of(1, 2, 3)));
});

test('readString 去尾部 NUL', () => {
  assert.equal(readString(new TextEncoder().encode('webm\0\0')), 'webm');
});

// ── 元素遍历 / 树构建 ────────────────────────────────────

test('iterElements 浅层遍历与 schema 命名', () => {
  const w = new EbmlWriter()
    .s(ID.DocType, 'webm')
    .u(ID.TimecodeScale, 1000000)
    .leaf(ID.Void, new Uint8Array(3))
    .done();
  const els = [...iterElements(w, 0, w.length, SCHEMA)];
  assert.equal(els.length, 3);
  assert.equal(els[0].name, 'DocType');
  assert.equal(els[0].type, TYPE.STRING);
  assert.equal(els[1].name, 'TimecodeScale');
  assert.equal(decodeValueByType(els[1].type, w.subarray(els[1].contentStart, els[1].contentEnd)), 1000000);
});

test('parseTree 递归 Master 并解码叶子值', () => {
  const buf = new EbmlWriter()
    .master(ID.EBML, (w) => {
      w.s(ID.DocType, 'matroska');
      w.u(ID.EBMLVersion, 1);
    })
    .done();
  const tree = parseTree(buf);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'EBML');
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].value, 'matroska');
  assert.equal(tree[0].children[1].value, 1);
});

// ── EbmlWriter ───────────────────────────────────────────

test('EbmlWriter 各类型输出字节正确', () => {
  const out = new EbmlWriter().u(ID.ClusterTimecode, 1000).done();
  // e7 82 03 e8
  assert.deepEqual([...out], [0xe7, 0x82, 0x03, 0xe8]);

  const neg = new EbmlWriter().i(0xfb, -1).done(); // ReferenceBlock=-1
  assert.deepEqual([...neg], [0xfb, 0x81, 0xff]); // int 载荷 0xFF = -1

  const f = new EbmlWriter().f(ID.Duration, 4000, 4).done();
  // Duration ID=0x4489 占 2 字节 + Size 1 字节，载荷从偏移 3 开始
  const view = new DataView(f.buffer, f.byteOffset + 3, 4);
  assert.equal(view.getFloat32(0, false), 4000);
});

// ── Lacing ───────────────────────────────────────────────

test('signedVintValue：数据位宽内二补码', () => {
  assert.equal(signedVintValue(63, 1), 63);
  assert.equal(signedVintValue(64, 1), -64);
  assert.equal(signedVintValue(127, 1), -1); // 全 1 位型
  assert.equal(signedVintValue(0, 2), 0);
  assert.equal(signedVintValue(8191, 2), 8191);
  assert.equal(signedVintValue(8192, 2), -8192);
  assert.equal(signedVintValue(16383, 2), -1); // 全 1 位型
  assert.equal(signedVintValue(16382, 2), -2);
});

test('lacing none：单帧直通', () => {
  const data = Uint8Array.from([9, 9, 9]);
  const { frames } = decodeLacing(LACING_NONE, data);
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [9, 9, 9]);
});

test('lacing xiph：编解码往返（含锁存字节链）', () => {
  const sizes = [10, 20, 30];
  const block = makeBlock({ trackNumber: 2, lacing: 'xiph', frames: sizes.map((s, i) => new Uint8Array(s).fill(i + 1)) });
  // 块头之后即 lacing 数据
  const headLen = 1 + 2 + 1; // trackVint(1)+tc(2)+flags(1)
  const laceData = block.subarray(headLen);
  const { frames } = decodeLacing(LACING_XIPH, laceData);
  assert.equal(frames.length, 3);
  assert.deepEqual([...frames[0]].length, 10);
  assert.equal(frames[0][0], 1);
  assert.equal(frames[1][0], 2);
  assert.equal(frames[2][0], 3);
  // 大尺寸触发 255 锁存链
  const big = makeBlock({ trackNumber: 1, lacing: 'xiph', frames: [new Uint8Array(600).fill(7), new Uint8Array(10).fill(8)] });
  const { frames: bf } = decodeLacing(LACING_XIPH, big.subarray(headLen));
  assert.equal(bf.length, 2);
  assert.equal(bf[0].length, 600);
  assert.equal(bf[1].length, 10);
});

test('lacing fixed：等分', () => {
  const block = makeBlock({ trackNumber: 2, lacing: 'fixed', frames: [new Uint8Array(25).fill(1), new Uint8Array(25).fill(2)] });
  const { frames } = decodeLacing(LACING_FIXED, block.subarray(4));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 25);
  assert.equal(frames[0][0], 1);
  assert.equal(frames[1][0], 2);
  // 无法等分应报错
  assert.throws(() => decodeLacing(LACING_FIXED, Uint8Array.of(1, 1, 2, 3, 4, 5, 6, 7)));
});

test('lacing ebml：正负差值往返', () => {
  // 尺寸序列 100 → 95(-5) → 120(+25)
  const sizes = [100, 95, 120];
  const header = encodeEbmlLacingHeader([100, 95]);
  const body = new Uint8Array(header.length + 315);
  body.set(header);
  let off = header.length;
  const payloads = [];
  for (const s of sizes) {
    payloads.push(Array.from({ length: s }, (_, i) => i % 255));
    for (let i = 0; i < s; i++) body[off++] = i % 255;
  }
  const { frames } = decodeLacing(LACING_EBML, body);
  assert.equal(frames.length, 3);
  assert.deepEqual([...frames.map((f) => f.length)], sizes);
  // 有符号 VINT 编解码自洽
  for (const d of [-64, -63, -5, -1, 0, 1, 63, 8191]) {
    const enc = encodeSignedVint(d);
    const raw = readSize(enc, 0);
    const back = raw.unknown ? -1 : signedVintValue(raw.value, raw.length);
    assert.equal(back, d, `delta ${d}`);
  }
});


// ── Size VINT 加宽回归（评审严重2：int32 移位溢出）────────────

test('Size：5~7 字节宽度阈值不再 int32 溢出（评审回归向量）', () => {
  // 评审实测误判向量：len=5 值 7 / len=6 值 1023 / len=7 值 131071
  for (const [v, w] of [[7, 5], [1023, 6], [131071, 7]]) {
    const enc = encodeSize(v, w);
    assert.equal(enc.length, w);
    const dec = readSize(enc, 0);
    assert.equal(dec.unknown, false, `value=${v} width=${w} 被误判未知长度`);
    assert.equal(dec.value, v);
  }
});

test('Size：全宽度边界值往返（每宽最大可表示值与次大值）', () => {
  for (let len = 1; len <= 7; len++) {
    const maxUsable = 2 ** (7 * len) - 2;
    for (const v of [maxUsable, Math.floor(maxUsable / 2)]) {
      const enc = encodeSize(v, len);
      const dec = readSize(enc, 0);
      assert.equal(dec.unknown, false, `width=${len} value=${v}`);
      assert.equal(dec.value, v);
    }
  }
});

test('Size：种子化 fuzz——encode/read 往返 400 例，unknown 仅出现在全 1 位型', () => {
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 400; i++) {
    const len = 1 + Math.floor(rand() * 7);           // 1..7 字节
    const maxV = 2 ** (7 * len) - 2;
    const v = Math.floor(rand() * (maxV + 1));
    const enc = encodeSize(v, len);
    assert.equal(enc.length >= len, true);
    const dec = readSize(enc, 0);
    assert.equal(dec.unknown, false);
    assert.equal(dec.value, v, `iter=${i} width=${enc.length} v=${v}`);
  }
});
