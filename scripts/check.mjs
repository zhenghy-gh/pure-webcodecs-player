#!/usr/bin/env node
/**
 * 本地一键门禁：fixtures → test → lint 串行执行，任一步失败立即终止并给出结论。
 * M2 起，每个模块完工自检的统一入口（captain 初验材料第 2/3 项直接贴本命令输出摘要）。
 *
 * 附加：无论门禁成败，末尾始终输出「门槛达标表」（scripts/thresholds.mjs，
 * 与 qa 报表同口径的报告性维度，M2 出口起转阻断）。
 *
 * 用法：npm run check
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  ['fixtures', ['run', '-s', 'fixtures']], // 重建落盘 fixture（无 gen.mjs 的模块自动跳过）
  ['test', ['test']],                      // 全仓单测（glob 已覆盖 .js/.mjs）
  ['lint', ['run', '-s', 'lint']],         // 语法 + 卫生 + 导入红线
];

console.log('[check] 开始本地门禁：fixtures → test → lint\n');
const t0 = Date.now();
let failedAt = null;

for (const [name, args] of steps) {
  const t = Date.now();
  const r = spawnSync(NPM, args, { stdio: 'inherit' });
  const sec = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    failedAt = { name, code: r.status };
    console.error(`\n[check] ✗ ${name} 失败（exit=${r.status}，${sec}s）——后续硬步骤已跳过`);
    break;
  }
  console.log(`[check] ✓ ${name} 通过（${sec}s）\n`);
}

// 门槛达标表：报告性维度，无论成败都输出（供补量期与 qa 报表对齐）
try {
  console.log('');
  await import(pathToFileURL(path.join(import.meta.dirname, 'thresholds.mjs')).href)
    .then((m) => m.report());
} catch (err) {
  console.warn(`[check] 门槛表输出失败（不影响门禁结论）：${err?.message || err}`);
}

if (failedAt) {
  console.error(`\n[check] 结论：未通过，卡在 "${failedAt.name}"。请修复后重跑 npm run check。`);
  process.exit(failedAt.code ?? 1);
}
console.log(`\n[check] 结论：全部通过 ✓（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
