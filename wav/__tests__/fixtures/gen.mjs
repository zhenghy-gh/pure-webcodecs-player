/**
 * wav/__tests__/fixtures/gen.mjs — 程序化生成最小合法 WAV fixture
 * 约定同 subtitle：generate(dir) 幂等写盘（原子替换），离线可复现。
 */
import path from 'node:path';

/** 原子写盘：避免并行 ensureFixtures 时读到半截文件（竞态加固） */
async function atomicWrite(file, data) {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** 拼装最小 WAV（s16/f32） */
export function buildWav({ channels = 1, sampleRate = 8000, bitsPerSample = 16, frames = 16 } = {}) {
  const bytesPerSample = bitsPerSample >> 3;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); w4(8, 'WAVE');
  w4(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, bitsPerSample === 32 ? 3 : 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, bitsPerSample, true);
  w4(36, 'data'); dv.setUint32(40, dataBytes, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      if (bitsPerSample === 32) { dv.setFloat32(p, Math.sin((i / frames) * Math.PI * 2) * 0.5, true); p += 4; }
      else { dv.setInt16(p, ((i * 1000) % 30000) - 15000, true); p += 2; }
    }
  }
  return new Uint8Array(buf);
}

/** 流式录制哨兵变体：riffSize=0xFFFFFFFF */
export function buildStreaming() {
  const b = buildWav({});
  new DataView(b.buffer).setUint32(4, 0xFFFFFFFF, true);
  return b;
}

export async function generate(dir) {
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
  await atomicWrite(path.join(dir, 'sample-basic.wav'), buildWav({}));
  await atomicWrite(path.join(dir, 'sample-streaming.wav'), buildStreaming());
  await atomicWrite(path.join(dir, 'sample-f32-stereo.wav'),
    buildWav({ channels: 2, sampleRate: 48000, bitsPerSample: 32, frames: 8 }));
}
if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  generate(process.argv[2] || new URL('.', import.meta.url).pathname)
    .then(() => console.log('fixtures written'));
}
