/**
 * flac/__tests__/fixtures/gen.mjs — 程序化生成最小合法 FLAC fixture
 * 结构：fLaC + STREAMINFO + 两帧 CONSTANT 子帧（各 16 样本，位级自洽）。
 */
import path from 'node:path';

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(v, w) { for (let i = w - 1; i >= 0; i--) { this.acc = (this.acc << 1) | ((v >>> i) & 1); if (++this.n === 8) { this.bytes.push(this.acc & 255); this.acc = 0; this.n = 0; } } return this; }
  align() { while (this.n) this.write(0, 1); return this; }
  out() { this.align(); return new Uint8Array(this.bytes); }
}
const crc8 = b => { let c = 0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 128 ? ((c << 1) ^ 7) & 255 : (c << 1) & 255; } return c; };
function crc16(b) {
  if (!crc16.tab) { crc16.tab = []; for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 32768 ? ((c << 1) ^ 0x8005) & 65535 : (c << 1) & 65535; crc16.tab[i] = c; } }
  let c = 0; for (const x of b) c = ((c << 8) & 65535) ^ crc16.tab[((c >> 8) ^ x) & 255];
  return c;
}
const cat = l => { const o = new Uint8Array(l.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of l) { o.set(a, p); p += a.length; } return o; };

function frameHeader(blockSize, sampleRate, codedNumber) {
  const w = new BitWriter();
  w.write(0b11111111111110, 14).write(0, 1).write(0, 1)
    .write(6, 4).write(13, 4).write(0, 4).write(4, 3).write(0, 1);
  w.write(codedNumber, 8); w.write(blockSize - 1, 8); w.write(sampleRate, 16);
  w.align();
  const head = w.out();
  return cat([head, new Uint8Array([crc8(head)])]);
}
function constantFrame(value, codedNumber, blockSize = 16, sampleRate = 8000) {
  const body = new BitWriter();
  body.write(0, 1).write(0b000000, 6).write(0, 1);
  body.write(value < 0 ? value + 65536 : value, 16);
  body.align();
  const payload = cat([frameHeader(blockSize, sampleRate, codedNumber), body.out()]);
  const c = crc16(payload);
  return cat([payload, new Uint8Array([(c >> 8) & 255, c & 255])]);
}
function streamInfo(totalSamples) {
  const b = new Uint8Array(34); const dv = new DataView(b.buffer);
  dv.setUint16(0, 16); dv.setUint16(2, 16);
  dv.setUint32(10, (8000 << 12) | (0 << 9) | (15 << 4));
  dv.setUint32(14, totalSamples >>> 0);
  return b;
}
const metaBlock = (type, body, last) => {
  const h = new Uint8Array(4);
  h[0] = (last ? 128 : 0) | type;
  h[1] = (body.length >> 16) & 255; h[2] = (body.length >> 8) & 255; h[3] = body.length & 255;
  return cat([h, body]);
};

export function buildFlac() {
  return cat([
    new TextEncoder().encode('fLaC'),
    metaBlock(0, streamInfo(32), true),
    constantFrame(100, 0),
    constantFrame(-100, 1),
  ]);
}

export async function generate(dir) {
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
  await atomicWrite(path.join(dir, 'sample-basic.flac'), buildFlac());
}
/** 原子写盘：避免并行 ensureFixtures 时读到半截文件（竞态加固） */
async function atomicWrite(file, data) {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  generate(process.argv[2] || new URL('.', import.meta.url).pathname)
    .then(() => console.log('fixtures written'));
}
