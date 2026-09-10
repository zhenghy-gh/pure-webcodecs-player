/**
 * gen.mjs —— fixture 磁盘产物生成器（契约 §0.6 / 工程约定 v1.1）
 *
 * `npm run fixtures`（根）会调用本文件导出的 generate(fixDir)，
 * 把三种最小合法 MKV/WebM 变体写到磁盘供人工检视与外部工具对照。
 *
 * 注意：单测本身【不依赖】这些产物——测试直接 import make-fixture.mjs
 * 在内存中构建字节，保证零 IO、零残留、离线可复现。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  makeMinimalWebm,
  makeUnknownSizeWebm,
  makeMkvWithAvcAacFlac,
  makeWebmWithTextTrack,
  makeWebmWithEncryptedAudio,
  makeWebmNoDuration,
} from './make-fixture.mjs';

/**
 * @param {string} fixDir 输出目录
 */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });
  const items = [
    ['minimal.webm', makeMinimalWebm().bytes],
    ['unknown-size.webm', makeUnknownSizeWebm().bytes],
    ['avc-aac-flac.mkv', makeMkvWithAvcAacFlac().bytes],
    ['text-track.webm', makeWebmWithTextTrack().bytes],
    ['encrypted-audio.webm', makeWebmWithEncryptedAudio().bytes],
    ['no-duration.webm', makeWebmNoDuration().bytes],
  ];
  for (const [name, bytes] of items) {
    await writeFile(join(fixDir, name), bytes);
  }
  return items.map(([name]) => join(fixDir, name));
}

// 直接执行时输出到 __tests__/fixtures/dist/
if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  const out = join(import.meta.dirname ?? '.', 'dist');
  const files = await generate(out);
  console.log('[mkv fixtures]', files);
}
