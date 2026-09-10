/**
 * flac/__tests__/flac-frame.test.js — 帧同步与帧头错误分支（node --test）
 * ------------------------------------------------------------
 * 覆盖 frame-header.js 的错误分支与 UTF 编码数大形态：
 *  · 帧同步码不匹配 / 保留位非 0 / 第二保留位非 0
 *  · blockSizeCode=0000 保留 / sampleRateCode=1111 非法 / sampleSizeCode=011 保留
 *  · 声道分配码非法（>10）
 *  · UTF-8 式编码数 3~7 字节形态（帧号/采样号大数）
 *  · findSync 无命中返回 -1
 * 用内联迷你帧头编码器，错误分支均在 CRC 校验前触发，故无需关心尾 CRC。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameHeader, findSync, crc8, BitWriter } from '../src/index.js';

/* ---------- 内联帧头编码器（暴露保留位与任意码） ---------- */
function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function writeUtfCodedNumber(w, v) {
  if (v < 0x80) { w.writeBits(v, 8); return; }
  if (v < 0x800) { w.writeBits(0xc0 | (v >>> 6), 8); w.writeBits(0x80 | (v & 0x3f), 8); return; }
  if (v < 0x10000) { w.writeBits(0xe0 | (v >>> 12), 8); w.writeBits(0x80 | ((v >>> 6) & 0x3f), 8); w.writeBits(0x80 | (v & 0x3f), 8); return; }
  if (v < 0x200000) { w.writeBits(0xf0 | (v >>> 18), 8); for (let i = 12; i >= 0; i -= 6) w.writeBits(0x80 | ((v >>> i) & 0x3f), 8); return; }
  if (v < 0x4000000) { w.writeBits(0xf8 | (v >>> 24), 8); for (let i = 18; i >= 0; i -= 6) w.writeBits(0x80 | ((v >>> i) & 0x3f), 8); return; }
  if (v < 0x80000000) { w.writeBits(0xfc | (v >>> 30), 8); for (let i = 24; i >= 0; i -= 6) w.writeBits(0x80 | ((v >>> i) & 0x3f), 8); return; }
  // 7 字节：首字节 0xFE
  w.writeBits(0xfe, 8);
  for (let i = 30; i >= 0; i -= 6) w.writeBits(0x80 | ((v >>> i) & 0x3f), 8);
}

function encodeFrameHeader(o) {
  const w = new BitWriter();
  const blockSizeCode = o.blockSizeCode ?? 6;
  const sampleRateCode = o.sampleRateCode ?? 10;
  const channelAssign = o.channelAssign ?? 0;
  const sampleSizeCode = o.sampleSizeCode ?? 4;
  const reserve1 = o.reserve1 ?? 0;
  const reserve2 = o.reserve2 ?? 0;
  w.writeBits(0b11111111111110, 14)
    .writeBits(reserve1, 1)
    .writeBits(o.blockingStrategy ?? 0, 1)
    .writeBits(blockSizeCode, 4)
    .writeBits(sampleRateCode, 4)
    .writeBits(channelAssign, 4)
    .writeBits(sampleSizeCode, 3)
    .writeBits(reserve2, 1);
  writeUtfCodedNumber(w, o.codedNumber ?? 0);
  if (blockSizeCode === 6) w.writeBits((o.blockSize ?? 1) - 1, 8);
  if (blockSizeCode === 7) w.writeBits((o.blockSize ?? 1) - 1, 16);
  if (sampleRateCode === 13) w.writeBits(o.extSampleRateHz ?? 12345, 16);
  w.alignToByte();
  const b = w.toUint8Array();
  return concatBytes(b, new Uint8Array([crc8(b)]));
}

describe('帧头错误分支', () => {
  test('帧同步码不匹配抛 PARSE_ERROR', () => {
    const w = new BitWriter();
    w.writeBits(0b11111111111111, 14); // 同步码末位应为 0
    w.writeBits(0, 1).writeBits(0, 1).writeBits(6, 4).writeBits(10, 4).writeBits(0, 4).writeBits(4, 3).writeBits(0, 1);
    w.writeBits(0, 8).alignToByte();
    const b = w.toUint8Array();
    const head = concatBytes(b, new Uint8Array([crc8(b)]));
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /同步码/.test(e.message));
  });
  test('帧头保留位（sync 后）非 0 抛错', () => {
    const head = encodeFrameHeader({ reserve1: 1 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /保留位非 0/.test(e.message));
  });
  test('帧头第二保留位非 0 抛错', () => {
    const head = encodeFrameHeader({ reserve2: 1 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /第二保留位非 0/.test(e.message));
  });
  test('blockSizeCode=0000 保留值抛错', () => {
    const head = encodeFrameHeader({ blockSizeCode: 0, reserve1: 0, reserve2: 0 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /0000/.test(e.message));
  });
  test('sampleRateCode=1111 非法抛错', () => {
    const head = encodeFrameHeader({ sampleRateCode: 15 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /1111/.test(e.message));
  });
  test('sampleSizeCode=011 保留值抛错', () => {
    const head = encodeFrameHeader({ sampleSizeCode: 3 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /011/.test(e.message));
  });
  test('声道分配码 > 10 非法抛错', () => {
    const head = encodeFrameHeader({ channelAssign: 11 });
    assert.throws(() => parseFrameHeader(head, 0), (e) => e.code === 'PARSE_ERROR' && /声道分配码非法/.test(e.message));
  });
});

describe('UTF-8 式编码数大形态', () => {
  const cases = [
    { v: 0x1234, desc: '3 字节' },
    { v: 0x1_0000, desc: '4 字节' },
    { v: 0x3_000_000, desc: '5 字节' },
    { v: 0x40_000_000, desc: '6 字节' },
    { v: 0x8000_0000, desc: '7 字节' },
  ];
  for (const { v, desc } of cases) {
    test(`${desc}（${v}）精确还原为 codedNumber`, () => {
      const head = encodeFrameHeader({ codedNumber: v, blockingStrategy: 1 });
      const { header } = parseFrameHeader(head, 0);
      assert.equal(header.codedNumber, v);
      assert.equal(header.blockingStrategy, 1, 'variable blocking 生效');
    });
  }
  test('variable blocking 下 3 字节采样号（>127）', () => {
    const head = encodeFrameHeader({ codedNumber: 4096, blockingStrategy: 1 });
    const { header } = parseFrameHeader(head, 0);
    assert.equal(header.codedNumber, 4096);
  });
});

describe('findSync', () => {
  test('无 0xff·0xfc 模式返回 -1', () => {
    const blob = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0x00, 0x10, 0x20]);
    assert.equal(findSync(blob, 0), -1);
  });
  test('从指定偏移起扫描命中', () => {
    const blob = new Uint8Array([0x00, 0x00, 0xff, 0xf8, 0x00, 0x00, 0xff, 0xf9]);
    assert.equal(findSync(blob, 0), 2);
    assert.equal(findSync(blob, 3), 6); // 越过首帧
  });
});
