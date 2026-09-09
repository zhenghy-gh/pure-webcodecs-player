/**
 * flac/__tests__/perf.test.js — 纯 JS 解码器吞吐基准（任务书硬门槛：≥实时 2×）
 * 方法：确定性 PRNG 生成 FIXED(2阶)+Rice(param 4) 重负荷帧流
 *   （残差 ±255 内，充分触发一元码/readBits 热路径），
 *   整段位级解码计时，断言 解码耗时 ≤ 音频时长 ÷ 2。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlacDecoder } from '../src/decoder.js';

/* ---- 迷你位写入器（fixture 专用 API：write/align/out，MSB first） ---- */
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(v, w) { for (let i = w - 1; i >= 0; i--) { this.acc = (this.acc << 1) | ((v >>> i) & 1); if (++this.n === 8) { this.bytes.push(this.acc & 255); this.acc = 0; this.n = 0; } } return this; }
  align() { while (this.n) this.write(0, 1); return this; }
  out() { this.align(); return new Uint8Array(this.bytes); }
}

/* ---- 编码器（仅保留本基准所需子集；crc 同 src/crc.js 规则） ---- */
const cat = l => { const o = new Uint8Array(l.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of l) { o.set(a, p); p += a.length; } return o; };
const crc8 = b => { let c = 0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 128 ? ((c << 1) ^ 7) & 255 : (c << 1) & 255; } return c; };
function crc16(b) {
  if (!crc16.tab) {
    crc16.tab = [];
    for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 32768 ? ((c << 1) ^ 0x8005) & 65535 : (c << 1) & 65535; crc16.tab[i] = c; }
  }
  let c = 0;
  for (const x of b) c = ((c << 8) & 65535) ^ crc16.tab[((c >> 8) ^ x) & 255];
  return c;
}

function frameHeader(blockSize, codedNumber) {
  const w = new BitWriter();
  w.write(0b11111111111110, 14).write(0, 1).write(0, 1)
    .write(7, 4)      // blockSizeCode=0111 → 后跟 16 位（支持大块）
    .write(13, 4)     // sampleRate 后跟 16 位 Hz
    .write(0, 4).write(4, 3).write(0, 1);
  w.write(codedNumber < 128 ? codedNumber : 0, 8);       // UTF 式编码数（fixture 只用小值）
  w.write(blockSize - 1, 16);
  w.write(48000, 16);
  w.align();
  const head = w.out();
  return cat([head, new Uint8Array([crc8(head)])]);
}

/** FIXED 二阶子帧：warmup 2 样本 + Rice(4bit param) 残差（单分区） */
function fixedFrame(residuals, warmup, codedNumber, blockSize, riceParam = 4) {
  const b = new BitWriter();
  b.write(0, 1).write(0b001000 | 2, 6).write(0, 1);      // FIXED 阶 2
  b.write(warmup[0] < 0 ? warmup[0] + 65536 : warmup[0], 16);
  b.write(warmup[1] < 0 ? warmup[1] + 65536 : warmup[1], 16);
  b.write(0, 2).write(0, 4).write(riceParam, 4);          // method00 / partitionOrder0 / param
  for (const r of residuals) {
    const u = r < 0 ? -r * 2 - 1 : r * 2;
    const q = Math.floor(u / (2 ** riceParam)), rem = u % (2 ** riceParam);
    for (let z = 0; z < q; z++) b.write(0, 1);
    b.write(1, 1);
    b.write(rem, riceParam);
  }
  b.align();
  const payload = cat([frameHeader(blockSize, codedNumber), b.out()]);
  const c = crc16(payload);
  return cat([payload, new Uint8Array([(c >> 8) & 255, c & 255])]);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构造整段流：STREAMINFO + N 帧 FIXED2+Rice 帧 */
export function buildPerfStream({ frames = 240, blockSize = 2048, sampleRate = 48000, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const si = new Uint8Array(34);
  const dv = new DataView(si.buffer);
  dv.setUint16(0, blockSize); dv.setUint16(2, blockSize);
  dv.setUint32(10, (sampleRate << 12) | (0 << 9) | (15 << 4));
  dv.setUint32(14, (frames * blockSize) >>> 0);

  const mk = new BitWriter();
  // STREAMINFO 块封装在 buildFlac 处统一做，这里只出帧序列
  void mk;

  const frameList = [];
  let warmup = [100, -50];
  for (let f = 0; f < frames; f++) {
    const residuals = new Int16Array(blockSize - 2);
    for (let i = 0; i < residuals.length; i++) residuals[i] = Math.floor(rand() * 511) - 255;
    frameList.push(fixedFrame(residuals, warmup, f, blockSize));
    if (f === 0) { /* warmup 沿用 */ }
  }

  const magic = new TextEncoder().encode('fLaC');
  const head = new Uint8Array(4);
  head[0] = 128; head[1] = 0; head[2] = 0; head[3] = 34;   // last=1 type=0 len=34
  const meta = cat([head, si]);

  // 校正总样本数高位片段（b13 低 4 位）
  void meta;
  return { stream: cat([magic, meta, ...frameList]), totalSamples: frames * blockSize, blockSize };
}

test('吞吐基准：JS 解码器 ≥ 实时 2×（FIXED2+Rice 重负荷）', async () => {
  const { stream, totalSamples, blockSize } = buildPerfStream({ frames: 240, blockSize: 2048 });
  const sampleRate = 48000;
  const audioSec = totalSamples / sampleRate;

  // 取三轮最优，剔除调度抖动（门槛仍为硬性 ≥2×）
  let ms = Infinity;
  for (let round = 0; round < 3; round++) {
    const dec = new FlacDecoder({ sampleRate, channels: 1, bitsPerSample: 16 });
    const t0 = process.hrtime.bigint();
    let pos = 42, decoded = 0;                         // 魔数4+块头4+STREAMINFO34
    while (pos < stream.length - 2) {
      while (pos < stream.length - 1 && !(stream[pos] === 0xff && (stream[pos + 1] & 0xfc) === 0xf8)) pos++;
      if (pos >= stream.length - 1) break;
      const f = dec.decodeFrame(stream, pos);
      decoded += f.blockSize;
      pos = f.endByte;
    }
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(decoded, totalSamples, '解码样本数应等于总样本数');
  }
  const realtimeX = audioSec / (ms / 1000);

  assert.ok(realtimeX >= 2,
    `吞吐不达标：${realtimeX.toFixed(1)}× 实时（要求 ≥2×），解码 ${ms.toFixed(0)}ms / 音频 ${audioSec.toFixed(1)}s`);
  console.log(`  [perf] ${blockSize}×${totalSamples / blockSize} 帧 · 最优解码 ${ms.toFixed(0)}ms · ` +
              `${realtimeX.toFixed(1)}× 实时 · 吞吐 ${(totalSamples / 1e6 / (ms / 1000)).toFixed(1)} Msamples/s`);
});
