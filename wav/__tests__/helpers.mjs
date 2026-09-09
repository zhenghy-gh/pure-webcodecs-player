/**
 * wav/__tests__/helpers.mjs — 测试辅助（非 .test.js）
 * fixture 缺失时调用 gen.mjs 现场重建，保证离线可复现。
 */
import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let ensured = false;

export async function ensureFixtures() {
  if (ensured) return FIX_DIR;
  await mkdir(FIX_DIR, { recursive: true });
  // 并发安全：始终全量幂等重建（gen.mjs 内为原子替换），
  // 不做单文件存在性短路——否则会读到其他进程生成到一半的目录（ENOENT）。
  const { generate } = await import('./fixtures/gen.mjs');
  await generate(FIX_DIR);
  ensured = true;
  return FIX_DIR;
}
export async function readFix(name) {
  await ensureFixtures();
  return readFile(path.join(FIX_DIR, name));
}
