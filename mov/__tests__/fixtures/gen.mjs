/**
 * mov fixture 生成器（CONTRACTS §0.6 / docs/fixtures-约定.md）。
 * 复用本模块测试构造器（基于生产 box-builder），幂等覆盖写。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQuickTimeMovFixture, buildCompressedMovFixture } from '../fixtures.js';

/** @param {string} fixDir 产物目录 */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });

  const qt = buildQuickTimeMovFixture();
  await writeFile(path.join(fixDir, 'quicktime.mov'), qt.bytes);
  await writeFile(
    path.join(fixDir, 'quicktime.meta.json'),
    JSON.stringify({ expectedTags: qt.expectedTags, movieTimescale: qt.movieTimescale }),
  );
  console.log(`[fixtures] quicktime.mov: ${qt.bytes.length}B / 三轨`);

  const cmov = buildCompressedMovFixture();
  await writeFile(path.join(fixDir, 'compressed-mov.mov'), cmov.bytes);
  console.log(`[fixtures] compressed-mov.mov: ${cmov.bytes.length}B / 拒载用例`);
}
