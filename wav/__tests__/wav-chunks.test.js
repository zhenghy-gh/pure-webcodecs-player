/**
 * wav/__tests__/wav-chunks.test.js — 子块顺序/未知块跳过/超大与截断容错
 * 低层组装任意子块序列，验证解析器对非 fmt/data 块的跳过与异常容错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWavHeader, ErrorCode, WAVE_FORMAT } from '../src/index.js';

/* ---------------- 低层子块组装 ---------------- */

function putFourCC(dv, off, id) { for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i)); }

/** 用「实际 body 长度」布局，但允许 per-part size 声明大于实际（模拟截断/超大） */
function assemble(parts, { riffSize } = {}) {
  const declared = parts.map((pt) => pt.size ?? pt.body.length);
  let total = 12;
  for (const pt of parts) { const a = pt.body.length; total += 8 + a + (a % 2); }
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  putFourCC(dv, 0, 'RIFF'); dv.setUint32(4, riffSize ?? total - 8, true); putFourCC(dv, 8, 'WAVE');
  let p = 12;
  parts.forEach((pt, i) => {
    const a = pt.body.length;
    putFourCC(dv, p, pt.id); dv.setUint32(p + 4, declared[i], true); p += 8;
    u8.set(pt.body, p); p += a + (a % 2);
  });
  return new Uint8Array(buf);
}

function fmtBody({ formatTag = WAVE_FORMAT.PCM, channels = 1, sampleRate = 8000, bits = 16 } = {}) {
  const bps = bits >> 3;
  const blockAlign = channels * bps;
  const byteRate = sampleRate * blockAlign;
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, formatTag, true);
  dv.setUint16(2, channels, true);
  dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, byteRate, true);
  dv.setUint16(12, blockAlign, true);
  dv.setUint16(14, bits, true);
  return b;
}

const dataBody = (n) => new Uint8Array(n);
const infoBody = (obj) => {
  const enc = new TextEncoder();
  const parts = [enc.encode('INFO')];
  for (const [k, v] of Object.entries(obj)) {
    const vb = enc.encode(v);
    const arr = new Uint8Array(8 + vb.length);
    const dv = new DataView(arr.buffer);
    for (let i = 0; i < 4; i++) arr[i] = k.charCodeAt(i);
    dv.setUint32(4, vb.length, true);
    arr.set(vb, 8);
    parts.push(arr);
  }
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/* ---------------- 未知块跳过 ---------------- */

describe('未知/元数据子块跳过', () => {
  test('JUNK 未知块被跳过且记入 chunks，data 仍解析', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody() },
      { id: 'JUNK', body: new Uint8Array(5) },
      { id: 'data', body: dataBody(16) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.codec, 'pcm-s16');
    assert.ok(h.chunks.some((c) => c.id === 'JUNK'));
    assert.ok(h.chunks.some((c) => c.id === 'data'));
  });

  test('fact 块（常见于压缩/浮点 WAV）被忽略且解析通过', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody({ formatTag: WAVE_FORMAT.IEEE_FLOAT, bits: 32, sampleRate: 48000 }) },
      { id: 'fact', body: new Uint8Array(4) },
      { id: 'data', body: dataBody(32) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.codec, 'pcm-f32');
    assert.ok(h.chunks.some((c) => c.id === 'fact'));
  });

  test('奇数长度块后紧邻子块按 +1 补齐被正确定位', () => {
    const bytes = assemble([
      { id: 'JUNK', body: new Uint8Array(5) },   // 5 → 补 1
      { id: 'fmt ', body: fmtBody() },
      { id: 'data', body: dataBody(8) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.codec, 'pcm-s16');
    const junk = h.chunks.find((c) => c.id === 'JUNK');
    const fmt = h.chunks.find((c) => c.id === 'fmt ');
    // 奇数长度 JUNK(5) 后按 RIFF 规范 +1 补齐，紧邻的 fmt 应落在 junk.payload + 5 + 1
    assert.equal(fmt.offset, junk.offset + 8 + 5 + 1);
  });

  test('LIST/INFO 与普通块共存：元数据仍提取', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody() },
      { id: 'LIST', body: infoBody({ INAM: 'hi', IART: 'me' }) },
      { id: 'JUNK', body: new Uint8Array(3) },
      { id: 'data', body: dataBody(16) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.info.INAM, 'hi');
    assert.equal(h.info.IART, 'me');
    assert.ok(h.chunks.some((c) => c.id === 'JUNK'));
  });

  test('data 出现在 fmt 之前：两者都被解析', () => {
    const bytes = assemble([
      { id: 'data', body: dataBody(16) },
      { id: 'fmt ', body: fmtBody({ sampleRate: 22050 }) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.format.sampleRate, 22050);
    assert.equal(h.dataChunk.size, 16);
  });

  test('重复 fmt：以最后一个为准', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody({ sampleRate: 8000 }) },
      { id: 'fmt ', body: fmtBody({ sampleRate: 44100 }) },
      { id: 'data', body: dataBody(16) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.format.sampleRate, 44100);
  });
});

/* ---------------- 超大 / 截断容错 ---------------- */

describe('超大/截断子块容错', () => {
  test('非 data 超大块（声明 > 实际）→ PARSE_ERROR', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody() },
      { id: 'fact', body: new Uint8Array(4), size: 9999 }, // 声明 9999 但仅 4 字节
      { id: 'data', body: dataBody(16) },
    ]);
    assert.throws(() => parseWavHeader(bytes), (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('data 被截断（声明 > 可得字节）→ 容错以实际长度继续', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody({ channels: 1, sampleRate: 8000, bits: 16 }) },
      { id: 'data', body: dataBody(4), size: 9999 }, // 仅 4 字节可得
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.dataChunk.size, 4);
    assert.equal(h.totalDataBytes, 4);
    assert.equal(h.format.blockAlign, 2);
    assert.equal(h.durationUs, Math.round((4 / (8000 * 2)) * 1e6));
  });

  test('data 后追加未知块也被跳过（循环到末尾）', () => {
    const bytes = assemble([
      { id: 'fmt ', body: fmtBody() },
      { id: 'data', body: dataBody(16) },
      { id: 'LIST', body: new Uint8Array(4) },
    ]);
    const h = parseWavHeader(bytes);
    assert.equal(h.dataChunk.size, 16);
    assert.ok(h.chunks.some((c) => c.id === 'LIST'));
  });
});
