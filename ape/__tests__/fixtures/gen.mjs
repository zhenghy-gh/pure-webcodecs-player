/**
 * ape/__tests__/fixtures/gen.mjs — 程序化生成最小合法 APE fixture
 * 结构：MAC descriptor(3990) + 24B header + 音频占位 + APEv2 footer 标签（含 binary 封面）。
 */
import path from 'node:path';

/** 原子写盘：避免并行 ensureFixtures 时读到半截文件（竞态加固） */
async function atomicWrite(file, data) {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const cat = l => { const o = new Uint8Array(l.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of l) { o.set(a, p); p += a.length; } return o; };
const enc = new TextEncoder();

/** MAC descriptor(52B) + header(24B) = 76B */
export function buildMac({ version = 3990, channels = 2, sampleRate = 44100 } = {}) {
  const b = new Uint8Array(76);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, version, true);
  dv.setUint32(8, 52, true);      // nDescriptorBytes
  dv.setUint32(12, 24, true);     // nHeaderBytes
  dv.setUint32(16, 0, true);      // nSeekTableBytes
  dv.setUint32(20, 0, true);      // nHeaderDataBytes
  dv.setUint32(24, 100000, true); // nAPEFrameDataBytes（低 32 位）
  dv.setUint32(28, 0, true);      // nAPEFrameDataBytesHigh
  dv.setUint32(32, 0, true);      // nTerminatingDataBytes
  let p = 52;                     // 头部紧跟描述符
  dv.setUint16(p, 4001, true); p += 2;          // normal
  dv.setUint16(p, 0x02, true); p += 2;
  dv.setUint32(p, 73728, true); p += 4;         // blocksPerFrame
  dv.setUint32(p, 12345, true); p += 4;         // finalFrameBlocks
  dv.setUint32(p, 10, true); p += 4;            // totalFrames
  dv.setUint16(p, 16, true); p += 2;            // bps
  dv.setUint16(p, channels, true); p += 2;
  dv.setUint32(p, sampleRate, true);
  return b;
}

/** APEv2 footer-only 标签 */
export function buildTag(items) {
  const parts = [];
  for (const [key, value] of items) {
    const vb = typeof value === 'string' ? enc.encode(value) : value;
    const kb = enc.encode(key);
    const arr = new Uint8Array(8 + kb.length + 1 + vb.length);
    const dv = new DataView(arr.buffer);
    dv.setUint32(0, vb.length, true);
    dv.setUint32(4, typeof value === 'string' ? 0 : (1 << 1), true); // binary → type=1
    arr.set(kb, 8); arr[kb.length + 8] = 0; arr.set(vb, 9 + kb.length);
    parts.push(arr);
  }
  const itemsBytes = cat(parts);
  const f = new Uint8Array(32);
  const dv = new DataView(f.buffer);
  for (const [i, ch] of [...'APETAGEX'].entries()) f[i] = ch.charCodeAt(0);
  dv.setUint32(8, 2000, true);
  dv.setUint32(12, itemsBytes.length + 32, true);
  dv.setUint32(16, items.length, true);
  return cat([itemsBytes, f]);
}

/** 完整最小 .ape：头 + 假音频占位 + v2 标签（含 binary 封面 mime\0data） */
export function buildApe() {
  const cover = cat([enc.encode('image/png'), new Uint8Array([0, 0x89, 0x50])]);
  const tag = buildTag([['Title', 'fixture 曲目'], ['Artist', 'gen.mjs'], ['Cover Art (front)', cover]]);
  const audioPad = new Uint8Array(256);
  return cat([buildMac(), audioPad, tag]);
}

export async function generate(dir) {
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
  await atomicWrite(path.join(dir, 'sample-basic.ape'), buildApe());
}
if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  generate(process.argv[2] || new URL('.', import.meta.url).pathname)
    .then(() => console.log('fixtures written'));
}
