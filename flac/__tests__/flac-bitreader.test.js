/**
 * flac/__tests__/flac-bitreader.test.js — BitReader/BitWriter 边界与 UTF 编码（node --test）
 * ------------------------------------------------------------
 * 覆盖 bit-reader.js 未充分单测的分支：
 *  · readBits：n=0 返回 0；n=8/32 正常；n<0 或 n>32 抛 PARSE_ERROR；位流提前结束抛错
 *  · readBit / 属性（position/bitsLeft/aligned/absolutePosition）
 *  · readUnary：零计数；超长一元码抛 PARSE_ERROR
 *  · skip / alignToByte / readBytes（字节对齐要求与越界）
 *  · readUtfCodedNumber：1~7 字节全形态；非字节首非法；续字节非 10xxxxxx 非法
 *  · BitWriter：writeBits 位序、merge 位级连续、alignToByte 补零
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BitReader, BitWriter } from '../src/index.js';
import { parseError } from '../src/errors.js';

/* ---------- 位流提前结束：构造恰好够/不够的 reader ---------- */
describe('readBits 边界', () => {
  test('n=0 返回 0', () => {
    const r = new BitReader(new Uint8Array([0xff]));
    assert.equal(r.readBits(0), 0);
    assert.equal(r.position, 0, 'n=0 不推进游标');
  });

  test('n=8 / n=32 跨字节读取', () => {
    const r = new BitReader(new Uint8Array([0x12, 0x34, 0x56, 0x57, 0x58, 0x59]));
    assert.equal(r.readBits(8), 0x12);
    assert.equal(r.readBits(8), 0x34);
    assert.equal(r.readBits(32), 0x56575859);
  });

  test('n<0 或 n>32 抛 PARSE_ERROR', () => {
    const r = new BitReader(new Uint8Array([0, 0]));
    assert.throws(() => r.readBits(-1), (e) => e.code === 'PARSE_ERROR');
    assert.throws(() => r.readBits(33), (e) => e.code === 'PARSE_ERROR');
  });

  test('剩余位不足 n → 抛 PARSE_ERROR', () => {
    // 仅 1 字节（8 位），要求读 9 位
    const r = new BitReader(new Uint8Array([0xff]));
    assert.throws(() => r.readBits(9), (e) => e.code === 'PARSE_ERROR' && /提前结束/.test(e.message));
  });

  test('bitLimit 约束生效（子范围读取）', () => {
    const all = new Uint8Array([0xff, 0xff, 0xff]);
    const r = new BitReader(all, 0, 12); // 只读前 12 位
    assert.equal(r.readBits(8), 0xff);
    assert.throws(() => r.readBits(8), (e) => e.code === 'PARSE_ERROR', '越过 bitLimit 即失败');
  });
});

describe('属性与 readBit', () => {
  test('position/bitsLeft/aligned/absolutePosition 自洽', () => {
    const r = new BitReader(new Uint8Array([0x80, 0x00]), 1); // 从字节偏移 1 起
    assert.equal(r.absolutePosition, 8);
    assert.equal(r.bitsLeft, 8);
    assert.ok(r.aligned);
    r.readBits(3);
    assert.equal(r.position, 3);
    assert.equal(r.bitsLeft, 5);
    assert.equal(r.absolutePosition, 11);
    assert.ok(!r.aligned);
    r.readBits(5);
    assert.ok(r.aligned, '补齐到字节后重新对齐');
  });

  test('readBit 逐位 MSB-first', () => {
    const r = new BitReader(new Uint8Array([0b10100000]));
    assert.equal(r.readBit(), 1);
    assert.equal(r.readBit(), 0);
    assert.equal(r.readBit(), 1);
    assert.equal(r.readBit(), 0);
  });
});

describe('readUnary', () => {
  test('数零直到 1：返回零个数', () => {
    // 位流 00101... → 前 2 个 0 后遇 1 → 返回 2
    const r = new BitReader(new Uint8Array([0b00101000]));
    assert.equal(r.readUnary(), 2);
  });

  test('一元码过长（>2^24 个零）抛 PARSE_ERROR', () => {
    const bits = new Uint8Array(1 << 22).fill(0x00); // 4MB 全零 = 2^25 位 > 2^24 阈值
    const r = new BitReader(bits);
    assert.throws(() => r.readUnary(), (e) => e.code === 'PARSE_ERROR' && /一元码过长/.test(e.message));
  });
});

describe('skip / alignToByte / readBytes', () => {
  test('skip 推进并越界抛错', () => {
    const r = new BitReader(new Uint8Array([0x00, 0x00]), 0, 8);
    r.skip(4);
    assert.equal(r.position, 4);
    assert.throws(() => r.skip(8), (e) => e.code === 'PARSE_ERROR', '跳过超出 bitsLeft 抛错');
  });

  test('alignToByte 仅在非对齐时补位', () => {
    const r = new BitReader(new Uint8Array([0xff, 0xff]));
    r.readBits(3);
    r.alignToByte();
    assert.ok(r.aligned);
    const pos = r.position;
    r.alignToByte(); // 已对齐应原地不动
    assert.equal(r.position, pos);
  });

  test('readBytes 要求字节对齐否则抛错', () => {
    const r = new BitReader(new Uint8Array([0xaa, 0xbb, 0xcc]));
    r.readBits(3); // 非对齐
    assert.throws(() => r.readBytes(1), (e) => e.code === 'PARSE_ERROR' && /字节对齐/.test(e.message));
    r.alignToByte();
    const b = r.readBytes(2);
    assert.deepEqual([...b], [0xbb, 0xcc]);
  });

  test('readBytes 越界抛 PARSE_ERROR', () => {
    const r = new BitReader(new Uint8Array([0x01]), 0, 8);
    assert.throws(() => r.readBytes(2), (e) => e.code === 'PARSE_ERROR');
  });
});

describe('readUtfCodedNumber 全形态', () => {
  function u8(...v) { return new Uint8Array(v); }
  test('1 字节（0x00~0x7f）', () => {
    assert.equal(new BitReader(u8(0x41)).readUtfCodedNumber(), 0x41);
    assert.equal(new BitReader(u8(0x7f)).readUtfCodedNumber(), 0x7f);
  });
  test('2 字节（0x80~0x7ff）', () => {
    // 0x123 = 0b1_0010_0011（9 位）→ 110_00100 10_00100011 = 0xc4 0xa3
    assert.equal(new BitReader(u8(0xc4, 0xa3)).readUtfCodedNumber(), 0x123);
  });
  test('3 字节（0x800~0xffff）', () => {
    assert.equal(new BitReader(u8(0xe4, 0xb8, 0xad)).readUtfCodedNumber(), 0x4e2d); // “中”
  });
  test('4~7 字节大数', () => {
    // 4 字节：0x1_0000 = 65536
    const v4 = new BitReader(u8(0xf0, 0x90, 0x80, 0x80)).readUtfCodedNumber();
    assert.equal(v4, 65536);
    // 7 字节：首字节 0xFE → value 0，全续字节 0x80
    const v7 = new BitReader(u8(0xfe, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80)).readUtfCodedNumber();
    assert.equal(v7, 0);
  });

  test('首位非法（0xFF）抛 PARSE_ERROR', () => {
    const r = new BitReader(u8(0xff));
    assert.throws(() => r.readUtfCodedNumber(), (e) => e.code === 'PARSE_ERROR');
  });

  test('续字节非 10xxxxxx 抛 PARSE_ERROR', () => {
    const r = new BitReader(u8(0xc2, 0x00)); // 续字节应为 10xxxxxx
    assert.throws(() => r.readUtfCodedNumber(), (e) => e.code === 'PARSE_ERROR');
  });
});

describe('BitWriter', () => {
  test('writeBits MSB-first 与 toUint8Array 补零', () => {
    const w = new BitWriter();
    w.writeBits(0b101, 3).writeBits(0b11, 2); // 共 5 位：101 11
    const out = w.toUint8Array();
    assert.equal(out.length, 1);
    assert.equal(out[0], 0b10111000); // 末尾补 3 个 0 对齐
  });

  test('merge 保持位级连续（含未对齐尾部）', () => {
    const a = new BitWriter(); a.writeBits(0b1010, 4); // 半字节
    const b = new BitWriter(); b.writeBits(0b1111, 4);
    const merged = a.merge(b).toUint8Array();
    assert.deepEqual([...merged], [0b10101111]);
  });

  test('alignToByte 补 0 后长度对齐', () => {
    const w = new BitWriter();
    w.writeBits(1, 1);
    const out = w.toUint8Array();
    assert.equal(out.length, 1);
    assert.equal(out[0], 0x80);
  });
});
