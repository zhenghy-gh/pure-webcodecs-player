/**
 * flac/__tests__/flac-subframe.test.js — subframe 分支与错误路径（node --test）
 * ------------------------------------------------------------
 * 覆盖 subframe.js 的 decodeSubframe 各类型分支与错误分支、restoreStereo 异常：
 *  · CONSTANT 正/负；VERBATIM 往返
 *  · FIXED 阶 3 往返 + 浪费位左移还原
 *  · LPC 多阶（order 4）带系数往返
 *  · 子帧头填充位非 0 / 非法类型码 / 浪费位超限 / 有效位深非法
 *  · FIXED/LPC 阶 ≥ 块大小 抛 PARSE_ERROR
 *  · LPC 系数精度码 1111 非法
 *  · restoreStereo 未知模式抛 PARSE_ERROR
 * 内联迷你编码器程序化构造合法帧，整帧含 CRC-16 自校验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FlacDecoder, decodeSubframe, restoreStereo, crc8, crc16, BitWriter } from '../src/index.js';

/* ---------- 内联迷你编码器 ---------- */
function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function writeSigned(w, v, bps) { w.writeBits(v < 0 ? v + 2 ** bps : v, bps); }

function encodeFrameHeader(o) {
  const w = new BitWriter();
  const blockSizeCode = o.blockSizeCode ?? 6;
  const sampleRateCode = o.sampleRateCode ?? 10;
  const channelAssign = o.channelAssign ?? 0;
  const sampleSizeCode = o.sampleSizeCode ?? 4;
  w.writeBits(0b11111111111110, 14).writeBits(0, 1).writeBits(o.blockingStrategy ?? 0, 1)
    .writeBits(blockSizeCode, 4).writeBits(sampleRateCode, 4).writeBits(channelAssign, 4)
    .writeBits(sampleSizeCode, 3).writeBits(0, 1);
  w.writeBits(o.codedNumber ?? 0, 8);
  if (blockSizeCode === 6) w.writeBits(o.blockSize - 1, 8);
  if (blockSizeCode === 7) w.writeBits(o.blockSize - 1, 16);
  return w;
}
function finalizeHeader(w) {
  w.alignToByte();
  const b = w.toUint8Array();
  return concatBytes(b, new Uint8Array([crc8(b)]));
}
function encodeRice(w, residuals, { method = 0, riceParam = 4, partitionOrder = 0, blockSize, predictorOrder = 0 }) {
  w.writeBits(method, 2).writeBits(partitionOrder, 4);
  const base = blockSize >> partitionOrder;
  let idx = 0;
  for (let p = 0; p < (1 << partitionOrder); p++) {
    w.writeBits(riceParam, method === 0 ? 4 : 5);
    const n = p === 0 ? base - predictorOrder : base;
    for (let k = 0; k < n; k++, idx++) {
      const r = residuals[idx];
      const u = r < 0 ? -r * 2 - 1 : r * 2;
      const q = Math.floor(u / 2 ** riceParam);
      const rem = u % 2 ** riceParam;
      for (let z = 0; z < q; z++) w.writeBits(0, 1);
      w.writeBits(1, 1);
      if (riceParam > 0) w.writeBits(rem, riceParam);
    }
  }
}
function encodeVerbatim(w, samples, bps, wasted = 0) {
  w.writeBits(0, 1).writeBits(0b000001, 6);
  if (wasted > 0) { w.writeBits(1, 1); for (let i = 0; i < wasted; i++) w.writeBits(0, 1); w.writeBits(1, 1); }
  else w.writeBits(0, 1);
  const eff = bps - wasted;
  for (const s of samples) writeSigned(w, s / (2 ** wasted) | 0, eff);
}
function encodeConstant(w, v, bps, blockSize) {
  w.writeBits(0, 1).writeBits(0b000000, 6).writeBits(0, 1);
  writeSigned(w, v, bps);
  void blockSize;
}
function encodeFixed(w, full, order, bps, riceOpt = {}) {
  w.writeBits(0, 1).writeBits(0b001000 | order, 6).writeBits(0, 1);
  for (let i = 0; i < order; i++) writeSigned(w, full[i], bps);
  encodeRice(w, full.slice(order), { blockSize: riceOpt.blockSize ?? full.length, predictorOrder: order, ...riceOpt });
}
function encodeLpc(w, samples, order, bps, precision, shift, coeffs, riceOpt = {}) {
  w.writeBits(0, 1).writeBits(0b100000 | (order - 1), 6).writeBits(0, 1);
  for (let i = 0; i < order; i++) writeSigned(w, samples[i], bps);
  w.writeBits(precision - 1, 4).writeBits(shift, 5);
  for (const cf of coeffs.slice(0, order)) writeSigned(w, cf, precision);
  encodeRice(w, samples.slice(order), { blockSize: riceOpt.blockSize ?? samples.length, predictorOrder: order, ...riceOpt });
}
function assembleFrame(headerBytes, ...subs) {
  const all = new BitWriter();
  for (const s of subs) all.merge(s);
  all.alignToByte();
  const payload = concatBytes(headerBytes, all.toUint8Array());
  const c = crc16(payload);
  return concatBytes(payload, new Uint8Array([(c >> 8) & 0xff, c & 0xff]));
}
const SI = { sampleRate: 48000, channels: 1, bitsPerSample: 16 };
function frameOf(subWriter, blockSize) {
  return assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize })), subWriter);
}

describe('CONSTANT / VERBATIM', () => {
  test('CONSTANT 正值与负值', () => {
    const f1 = frameOf((() => { const w = new BitWriter(); encodeConstant(w, 12345, 16, 8); return w; })(), 8);
    assert.deepEqual([...new FlacDecoder(SI).decodeFrame(f1, 0).channels[0]], new Array(8).fill(12345));
    const f2 = frameOf((() => { const w = new BitWriter(); encodeConstant(w, -12345, 16, 8); return w; })(), 8);
    assert.deepEqual([...new FlacDecoder(SI).decodeFrame(f2, 0).channels[0]], new Array(8).fill(-12345));
  });
  test('VERBATIM 全范围往返', () => {
    const s = [0, 1, -1, 32767, -32768, 255, -256];
    const f = frameOf((() => { const w = new BitWriter(); encodeVerbatim(w, s, 16); return w; })(), s.length);
    assert.deepEqual([...new FlacDecoder(SI).decodeFrame(f, 0).channels[0]], s);
  });
});

describe('FIXED / LPC 往返', () => {
  test('FIXED 阶 3 + 浪费位左移还原', () => {
    const residuals = [4, -2, 9, -1, 0, 33];
    const warmup = [7, -3, 5];
    const full = [...warmup, ...residuals];
    const w = new BitWriter();
    encodeFixed(w, full, 3, 16, { riceParam: 2 });
    const f = frameOf(w, full.length);
    const COEFFS = [3, -3, 1];
    const expect = [...full];
    for (let i = 3; i < full.length; i++) {
      let pred = 0;
      for (let j = 0; j < 3; j++) pred += COEFFS[j] * expect[i - 1 - j];
      expect[i] = full[i] + (pred >> 3);
    }
    assert.deepEqual([...new FlacDecoder(SI).decodeFrame(f, 0).channels[0]], expect);
  });

  test('LPC 阶 4 带系数往返（独立参考实现）', () => {
    const order = 4;
    const coeffs = [4, -6, 4, -1];
    const shift = 0;
    const warmup = [100, -50, 25, -12];
    const residuals = [1, -1, 2, -3, 5, -8, 13];
    const full = [...warmup, ...residuals];
    const w = new BitWriter();
    encodeLpc(w, full, order, 16, 15, shift, coeffs, { riceParam: 1 });
    const f = frameOf(w, full.length);
    const expect = [...full];
    for (let i = order; i < full.length; i++) {
      let pred = 0;
      for (let j = 0; j < order; j++) pred += coeffs[j] * expect[i - 1 - j];
      expect[i] = full[i] + (pred >> shift);
    }
    assert.deepEqual([...new FlacDecoder(SI).decodeFrame(f, 0).channels[0]], expect);
  });
});

describe('subframe 错误分支', () => {
  function decodeThrows(subWriter, blockSize, msg) {
    const f = frameOf(subWriter, blockSize);
    assert.throws(() => new FlacDecoder(SI).decodeFrame(f, 0), (e) => e.code === 'PARSE_ERROR' && msg.test(e.message));
  }
  test('子帧头填充位非 0', () => {
    const w = new BitWriter(); w.writeBits(1, 1).writeBits(0b000000, 6).writeBits(0, 1);
    writeSigned(w, 1, 16);
    decodeThrows(w, 4, /填充位非 0/);
  });
  test('非法子帧类型码', () => {
    const w = new BitWriter(); w.writeBits(0, 1).writeBits(0b000111, 6).writeBits(0, 1);
    decodeThrows(w, 4, /类型码非法/);
  });
  test('浪费位计数 > 31 抛错', () => {
    const w = new BitWriter();
    w.writeBits(0, 1).writeBits(0b000000, 6).writeBits(1, 1);
    for (let i = 0; i < 32; i++) w.writeBits(0, 1); // 32 个零 → 第 32 次越限
    w.writeBits(1, 1).writeBits(1, 16);
    decodeThrows(w, 4, /浪费位计数超限/);
  });
  test('有效位深 ≤ 0（wasted == bps）抛错', () => {
    const w = new BitWriter();
    encodeVerbatim(w, [0, 0], 16, 16); // 帧头 bps=16，wasted=16 → eff=0
    decodeThrows(w, 2, /有效位深非法/);
  });
  test('FIXED 阶 ≥ 块大小', () => {
    const w = new BitWriter();
    encodeFixed(w, [1, 2], 2, 16, { riceParam: 1 }); // blockSize 2, 阶 2
    decodeThrows(w, 2, /阶 2 ≥ 块大小/);
  });
  test('LPC 阶 ≥ 块大小', () => {
    const w = new BitWriter();
    // order 1 但 blockSize 1（warmup 1 样本）
    encodeLpc(w, [7], 1, 16, 16, 0, [1], { riceParam: 1 });
    decodeThrows(w, 1, /阶 1 ≥ 块大小/);
  });
  test('LPC 系数精度码 1111 非法', () => {
    const w = new BitWriter();
    // order=1, blockSize=2：先过阶检查，再于 warmup 后读到 precision=16（1111）抛错
    encodeLpc(w, [7, 0], 1, 16, 16, 0, [1], { riceParam: 0, blockSize: 2 });
    decodeThrows(w, 2, /系数精度码 1111 非法/);
  });
});

describe('restoreStereo 异常', () => {
  test('未知立体声模式抛 PARSE_ERROR', () => {
    assert.throws(() => restoreStereo([[1, 2], [3, 4]], 'bogus'), (e) => e.code === 'PARSE_ERROR');
  });
  test('independent / 单声道原样返回', () => {
    const ch = [[1, 2], [3, 4]];
    assert.strictEqual(restoreStereo(ch, 'independent'), ch, '引用不变');
  });
});
