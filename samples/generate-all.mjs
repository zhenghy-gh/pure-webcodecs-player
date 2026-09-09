#!/usr/bin/env node
// fixture 汇总生成器（零依赖）。
//
// 约定：每个模块可提供 `<module>/__tests__/fixtures/gen.mjs`，导出：
//     export async function generate(fixDir) { ... }  // 把样例文件写入 fixDir
// 运行 `npm run fixtures` 时按模块逐个调用；没有 gen.mjs 的模块跳过。
// 生成的二进制产物已被根 .gitignore 忽略，不入库，随时可重建。
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  'core', 'mp4', 'mov', 'mkv', 'webtorrent', 'ts', 'flv', 'hls', 'cmaf',
  'webrtc', 'rtmp', 'rtsp', 'wav', 'flac', 'ape', 'subtitle'
];

let made = 0, skipped = 0;
for (const mod of MODULES) {
  const genPath = path.join(ROOT, mod, '__tests__', 'fixtures', 'gen.mjs');
  if (!existsSync(genPath)) { skipped++; continue; }
  const fixDir = path.dirname(genPath);
  await mkdir(fixDir, { recursive: true });
  const { generate } = await import(pathToFileURL(genPath).href);
  await generate(fixDir);
  console.log(`[fixtures] ${mod} ✓ (${fixDir})`);
  made++;
}
console.log(`[fixtures] 完成：生成 ${made} 个模块，跳过 ${skipped} 个（未提供 gen.mjs）`);
