/**
 * ts/__tests__/fixtures/gen.mjs —— 《docs/fixtures-约定.md》接入实现。
 *
 * 约定红线：容器字节一律 import 根 fixtures 库（samples/fixtures）复用生成，
 * 禁止在本文件另造编码器；输出确定性（无随机、无当前时间戳）。
 * 手动运行：npm run fixtures
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTS } from '../../../samples/fixtures/index.js';

/** @param {string} fixDir 产物目录（本文件所在目录） */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });

  const cases = [
    ['basic.ts', makeTS({ auCount: 6 })],                       // 纯视频 H.264
    ['av.ts', makeTS({ auCount: 8, withAudio: true })],         // 视频+AAC ADTS
    ['padded.ts', makeTS({ auCount: 4, auPadBytes: 64 })],      // PES 带 AF 填充
  ];

  const written = [];
  for (const [name, made] of cases) {
    const bytes = made.bytes instanceof Uint8Array ? made.bytes : new Uint8Array(made.bytes);
    await writeFile(path.join(fixDir, name), bytes);
    written.push(name);
  }
  return written;
}
