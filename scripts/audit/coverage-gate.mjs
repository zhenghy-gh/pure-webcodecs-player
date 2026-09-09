#!/usr/bin/env node
/**
 * 分层覆盖率门禁
 *
 * 背景：全仓一刀切的覆盖率阈值不成立。低覆盖高度集中在**环境依赖层**
 * （player/renderer/webcodecs/mse/worklet/video-frame/canvas/capabilities）——它们
 * 依赖 WebCodecs / MSE / Canvas / AudioWorklet / VideoFrame 等浏览器 API，Node 下
 * 根本无法执行，属「环境性低覆盖」而非测试缺失（实测 wav/src/player.js 13.2%、
 * core/src/video-frame-renderer.js 24.8%、hls/src/player.js 40.1%）。
 * 若用统一阈值，要么 CI 长期红（无意义），要么被迫写假测试（有害）。
 *
 * 策略：按文件角色分层，只对**可在 Node 下真实验证的逻辑层**设闸。
 *   - env 层（浏览器依赖）：只报告，不阻断；
 *   - core 逻辑层（demuxer/errors/limits/abort…）：门槛 85%；
 *   - parser 层（各格式解析）：门槛 80%。
 *
 * 用法：
 *   node scripts/audit/coverage-gate.mjs              # 自跑测试取覆盖率
 *   node scripts/audit/coverage-gate.mjs --lcov=x.info # 复用既有 lcov
 *   node scripts/audit/coverage-gate.mjs --json        # 机器可读输出
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 环境依赖层判定：文件名含这些词 → 依赖浏览器 API，Node 下不可测。
 * 该层只统计不入闸，避免把「环境限制」伪装成「质量缺陷」。
 */
const ENV_PAT =
  /(player|renderer|webcodecs|mse[-_]|worklet|video-frame|canvas|capabilities|audio-worklet)/i;

/** 分层门槛（行覆盖率 %） */
const GATE = {
  core: 85,
  parser: 80,
};

function parseArgs(argv) {
  const a = { lcov: null, json: false };
  for (const s of argv.slice(2)) {
    if (s.startsWith('--lcov=')) a.lcov = s.slice('--lcov='.length);
    else if (s === '--json') a.json = true;
  }
  return a;
}

/** 跑测试并产出 lcov；返回文件路径 */
function runCoverage() {
  const dest = path.join(os.tmpdir(), `cov-gate-${process.pid}.info`);
  const r = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=4',
      '--test-timeout=15000',
      '--test-force-exit',
      '--experimental-test-coverage',
      '--test-reporter=lcov',
      `--test-reporter-destination=${dest}`,
      '**/__tests__/*.test.{js,mjs}',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (!fs.existsSync(dest)) {
    console.error('[coverage] lcov 生成失败');
    console.error((r.stderr || '').slice(-800));
    process.exit(2);
  }
  return dest;
}

/** 解析 lcov → 项目内 src 文件行覆盖率 */
function parseLcov(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  let cur = null;
  for (const line of txt.split('\n')) {
    if (line.startsWith('SF:')) cur = { path: line.slice(3), hit: 0, total: 0 };
    else if (line.startsWith('DA:') && cur) {
      const cnt = Number(line.slice(3).split(',')[1]);
      cur.total++;
      if (cnt > 0) cur.hit++;
    } else if (line === 'end_of_record' && cur) {
      out.push(cur);
      cur = null;
    }
  }
  return out
    .filter((f) => {
      const p = f.path;
      if (p.includes('Applications/') || p.includes('node_modules')) return false;
      if (p.includes('__tests__') || p.includes('fixtures')) return false;
      return /\/src\//.test(p);
    })
    .map((f) => {
      // 归一为 <module>/src/<file>：lcov 的 SF 可能是绝对/相对长路径，
      // 必须保留模块段，否则 core/ 与 parser 层的判定会失真（曾误归为 parser）。
      const m = /([A-Za-z0-9_-]+)\/src\/(.+)$/.exec(f.path);
      const rel = m ? `${m[1]}/src/${m[2]}` : f.path.replace(/^[\w./-]*?src\//, 'src/');
      return {
        path: rel,
        pct: f.total ? +((f.hit / f.total) * 100).toFixed(1) : 100,
        miss: f.total - f.hit,
      };
    });
}

/** 分层：env（豁免） / core（85） / parser（80） */
function classify(f) {
  const base = path.basename(f.path);
  if (ENV_PAT.test(base)) return 'env';
  return f.path.startsWith('core/') ? 'core' : 'parser';
}

const args = parseArgs(process.argv);
const lcovFile = args.lcov ?? runCoverage();
const files = parseLcov(lcovFile);
if (!args.lcov && lcovFile) fs.rmSync(lcovFile, { force: true });

const layers = { env: [], core: [], parser: [] };
for (const f of files) layers[classify(f)].push(f);

const agg = (xs) => {
  if (!xs.length) return { n: 0, avg: 100, miss: 0 };
  return {
    n: xs.length,
    avg: +(xs.reduce((a, f) => a + f.pct, 0) / xs.length).toFixed(1),
    miss: xs.reduce((a, f) => a + f.miss, 0),
  };
};

const failed = [];
for (const key of ['core', 'parser']) {
  const gate = GATE[key];
  for (const f of layers[key]) {
    if (f.pct < gate) failed.push({ ...f, layer: key, gate });
  }
}
failed.sort((a, b) => a.pct - b.pct);

if (args.json) {
  console.log(
    JSON.stringify(
      {
        gate: GATE,
        layers: Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, agg(v)])),
        failed,
      },
      null,
      2,
    ),
  );
} else {
  console.log('[coverage] 分层覆盖率门禁（env 层仅报告，不阻断）');
  for (const key of ['env', 'core', 'parser']) {
    const a = agg(layers[key]);
    const gate = GATE[key];
    const mark = gate ? (a.avg >= gate ? '✓' : '✗') : '— 豁免';
    console.log(
      `[coverage] ${key.padEnd(7)} 文件 ${String(a.n).padStart(3)}  均 ${String(a.avg).padStart(6)}%` +
        `  未覆盖 ${String(a.miss).padStart(5)} 行  门槛 ${gate ? gate + '%' : '无'}  ${mark}`,
    );
  }
  if (failed.length) {
    console.log(`[coverage] 未达标文件 ${failed.length} 个：`);
    for (const f of failed.slice(0, 20)) {
      console.log(`[coverage]   ✗ ${String(f.pct).padStart(6)}% < ${f.gate}%  [${f.layer}] ${f.path}`);
    }
    if (failed.length > 20) console.log(`[coverage]   … 另有 ${failed.length - 20} 个`);
  } else {
    console.log('[coverage] 结论：逻辑层全部达标 ✓');
  }
}

process.exit(failed.length ? 1 : 0);
