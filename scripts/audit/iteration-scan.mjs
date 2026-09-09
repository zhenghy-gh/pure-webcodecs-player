#!/usr/bin/env node
/**
 * 迭代扫描器：一键现盘，输出「下一波该打哪里」。
 *
 * 用途：每波开头跑一次，替代手工挨个跑命令（迭代规则 §1「先现盘」）。
 * 聚合：git 状态 → lint → check(用例阈值) → 结构层审计 → 运行时审计 → 分层覆盖率门禁 → backlog 候选池。
 *
 * 用法：
 *   node scripts/audit/iteration-scan.mjs          # 全量（含覆盖率，约 20s）
 *   node scripts/audit/iteration-scan.mjs --quick  # 跳过覆盖率
 *   node scripts/audit/iteration-scan.mjs --json   # 机器可读
 *
 * 退出码：0=无阻断项；1=存在阻断项（任一检查失败）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = process.execPath;
const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const asJson = argv.includes('--json');

function runNode(script, extra = []) {
  const r = spawnSync(NODE, [script, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/** 取匹配行；没有则返回 null */
function pick(out, re) {
  const m = out.match(re);
  return m ? m[1] : null;
}

const report = { git: {}, checks: [], coverage: null, backlog: [], blocking: [] };

// 1. git 状态
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirtyCount = git(['status', '--porcelain'])
  .split('\n')
  .filter(Boolean).length;
const aheadBehind = git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
report.git = { branch, dirtyCount, aheadBehind: aheadBehind || 'n/a（无 origin）' };
if (dirtyCount > 0) report.blocking.push(`工作区有 ${dirtyCount} 个未提交改动（一趟一提交）`);

// 2. lint
const lint = runNode('scripts/lint.mjs');
report.checks.push({ name: 'lint', ok: lint.code === 0, detail: lastLine(lint.out) });
if (lint.code !== 0) report.blocking.push('lint 未通过');

// 3. check（PRD 用例数阈值）
const check = runNode('scripts/check.mjs');
report.checks.push({ name: 'check(阈值)', ok: check.code === 0, detail: lastLine(check.out) });
if (check.code !== 0) report.blocking.push('用例数阈值未达标');

// 4. 结构层契约审计（§2.4）
const struct = runNode('scripts/audit/contract-2-4-audit.mjs');
const structIssues = Number(pick(struct.out, /合计结构层问题[：:]?\s*(\d+)/) ?? -1);
report.checks.push({
  name: '结构层 §2.4',
  ok: struct.code === 0 && structIssues === 0,
  detail: structIssues >= 0 ? `问题 ${structIssues}` : '未解析到计数',
});
if (structIssues > 0) report.blocking.push(`结构层契约问题 ${structIssues} 项`);

// 5. 运行时契约审计（§2.4）
const runtime = runNode('scripts/audit/runtime-2-4-audit.mjs');
const fails = (runtime.out.match(/\bFAIL\b/g) ?? []).length;
report.checks.push({ name: '运行时 §2.4', ok: runtime.code === 0 && fails === 0, detail: `FAIL ${fails}` });
if (fails > 0) report.blocking.push(`运行时契约 FAIL ${fails} 项`);

// 6. 分层覆盖率门禁
if (quick) {
  report.coverage = { skipped: true };
} else {
  const cov = runNode('scripts/audit/coverage-gate.mjs', ['--json']);
  try {
    // coverage-gate --json 结构：{ gate:{core,parser}, layers:{env|core|parser:{n,avg,miss}}, failed:[{path,pct,miss,layer,gate}] }
    const data = JSON.parse(cov.out.slice(cov.out.indexOf('{')));
    const gate = data.gate ?? {};
    const failed = (data.failed ?? []).map((f) => ({
      path: f.path,
      layer: f.layer,
      pct: f.pct,
      gate: f.gate,
      gap: +((f.gate ?? 0) - f.pct).toFixed(1),
    }));
    const layers = Object.entries(data.layers ?? {}).map(([layer, v]) => ({
      layer,
      files: v.n,
      pct: v.avg,
      miss: v.miss,
      threshold: gate[layer] ?? null,
    }));
    report.coverage = { layers, failed };
    if (failed.length) report.blocking.push(`覆盖率未达标 ${failed.length} 个文件`);
  } catch (err) {
    report.coverage = { parseError: true, raw: `${err.message} | ${cov.out.slice(-200)}` };
  }
}

// 7. backlog 候选池未勾选项
const blPath = path.join(ROOT, 'docs/review/iteration-backlog.md');
if (fs.existsSync(blPath)) {
  const bl = fs.readFileSync(blPath, 'utf8');
  report.backlog = [...bl.matchAll(/^- \[ \]\s+\*\*(P\d)\*\*\s+(.+)$/gm)].map((m) => ({
    priority: m[1],
    text: m[2].replace(/\*\*/g, '').trim(),
  }));
  // 已完成的 - [x] 不进候选
}

// 8. 建议下一波目标
report.suggestion = suggest(report);

function lastLine(out) {
  const lines = out.trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : '';
}

function suggest(r) {
  const cov = r.coverage?.failed ?? [];
  if (cov.length) {
    // 只建议逻辑层（env 层豁免不进建议），取差距最大的
    const logical = cov.filter((f) => f.layer !== 'env').sort((a, b) => b.gap - a.gap);
    if (logical.length) {
      const t = logical[0];
      return `补测 ${t.path}（${t.pct}% < ${t.gate}%，差 ${t.gap} 个百分点）`;
    }
  }
  const p1 = r.backlog.find((b) => b.priority === 'P1');
  if (p1) return `backlog P1：${p1.text}`;
  const any = r.backlog[0];
  if (any) return `backlog ${any.priority}：${any.text}`;
  return '无自动候选 — 需人工现盘（跑真机 e2e 或 owner 裁决项）';
}

// 输出
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = (ok) => (ok ? '✓' : '✗');
  console.log('[scan] 迭代现盘汇总');
  console.log(
    `  git      branch=${report.git.branch} 未提交=${report.git.dirtyCount} 与origin=${report.git.aheadBehind}`
  );
  for (const c of report.checks) {
    console.log(`  ${mark(c.ok)} ${c.name.padEnd(12)} ${c.detail}`);
  }
  if (report.coverage?.skipped) {
    console.log('  – coverage  已跳过（--quick）');
  } else if (report.coverage?.parseError) {
    console.log('  ? coverage  解析失败：' + report.coverage.raw);
  } else if (report.coverage) {
    for (const l of report.coverage.layers) {
      const ok = l.threshold === null || l.pct >= l.threshold;
      console.log(
        `  ${mark(ok)} coverage ${String(l.layer).padEnd(6)} ` +
          `文件 ${String(l.files).padStart(3)}  均 ${String(l.pct).padStart(6)}%  ` +
          `未覆盖 ${String(l.miss).padStart(5)} 行  门槛 ${l.threshold === null ? '无（豁免）' : l.threshold + '%'}`
      );
    }
    for (const f of report.coverage.failed.slice(0, 8)) {
      console.log(`      ✗ ${String(f.pct).padStart(6)}% < ${f.gate}%  [${f.layer}] ${f.path}  差 ${f.gap}`);
    }
  }
  console.log(`\n[scan] backlog 未勾选 ${report.backlog.length} 项`);
  for (const b of report.backlog.slice(0, 6)) console.log(`  · ${b.priority} ${b.text}`);
  console.log(`\n[scan] 建议下一波：${report.suggestion}`);
  if (report.blocking.length) {
    console.log('\n[scan] 阻断项：');
    for (const b of report.blocking) console.log(`  ! ${b}`);
  } else {
    console.log('\n[scan] 无阻断项，可安全开新波');
  }
}

process.exit(report.blocking.length ? 1 : 0);
