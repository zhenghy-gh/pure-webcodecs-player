#!/usr/bin/env node
/**
 * 可选的轻量 lint：零依赖，仅做三件事
 *  1) 用 `node --check` 对全部 .js/.mjs 源文件做语法校验（遵循 package.json type=module）
 *  2) 基础卫生检查：行尾空白、文件末尾缺换行（警告级，不阻断）
 *  3) 导入红线检查（错误级，阻断）：
 *     - 裸包名导入（第三方运行时依赖）→ 全仓一律报错（本项目零第三方依赖，含 scripts/）
 *     - `node:` 前缀导入 → 仅允许出现在 tests/scripts/samples；
 *       各模块 src/** 是浏览器代码，禁止依赖 Node API
 *
 * 跳过目录：node_modules / .git / dist / build / coverage / .tmp
 * 用法：npm run lint   （或 node scripts/lint.mjs [路径...]）
 */
import { spawnSync } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.tmp']);
const EXTS = new Set(['.js', '.mjs', '.cjs']);

const args = process.argv.slice(2);
let files = [];

/** 递归收集源码文件 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(path.join(dir, e.name));
    } else if (EXTS.has(path.extname(e.name))) {
      files.push(path.join(dir, e.name));
    }
  }
}

if (args.length > 0) {
  for (const a of args) {
    const s = await stat(a);
    if (s.isDirectory()) await walk(a);
    else files.push(a);
  }
} else {
  await walk(ROOT);
}
files.sort();

const failures = [];
const warnings = [];

for (const file of files) {
  // 1) 语法检查：node --check（ESM 判定遵循最近 package.json 的 type 字段）
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures.push({ file, msg: (r.stderr || r.stdout || '').trim() });
    continue;
  }
  // 2) 卫生检查（只读文本、小文件才查）
  try {
    const info = await stat(file);
    if (info.size < 2 * 1024 * 1024) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/[ \t]+$/.test(line)) warnings.push(`${file}:${i + 1} 行尾空白`);
      });
      if (text.length > 0 && !text.endsWith('\n')) warnings.push(`${file} 文件末尾缺少换行符`);
      checkImportRedLines(file, text, failures);
    }
  } catch { /* 二进制或不可读则跳过 */ }
}

/**
 * 导入红线：从源码文本抽取所有模块说明符并按规则分类。
 * 规则（见文件头注释 3）：
 *   - 裸包名（既非相对 ./ ../、非 / 开头、非 node: 前缀）→ 全仓报错；
 *   - node: 前缀 → 仅 tests / scripts / samples 放行；<模块>/src/** 内报错。
 */
function checkImportRedLines(file, text, failures) {
  const rel = path.relative(ROOT, file);
  const sep = path.sep;
  // 各播放器模块 src/** 是浏览器代码；samples/** 与 scripts/** 是 Node 侧工具，天然豁免
  const underTooling = rel.startsWith(`samples${sep}`) || rel.startsWith(`scripts${sep}`);
  const inModuleSrc = rel.includes(`${sep}src${sep}`) && !underTooling;
  const source = stripComments(text); // 先剥注释，避免 JSDoc 示例误报
  const specs = [];

  // 静态 from 子句（含 export ... from）
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  // 动态 import('...')
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  // 副作用导入 import '...'
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);

  for (const spec of new Set(specs)) {
    if (lineOf(source, spec) === -1) continue; // 理论不可达，防御
    const isRelative = spec.startsWith('.') || spec.startsWith('/');
    const isNode = spec.startsWith('node:');
    const isAbsoluteUrl = /^[a-z][a-z0-9+.-]*:\//i.test(spec); // https:// 等 CDN 可选增强
    if (!isRelative && !isNode && !isAbsoluteUrl) {
      failures.push({
        file,
        msg: `裸包名导入 '${spec}' —— 红线：全仓零第三方运行时依赖`,
        line: lineOf(text, spec),
      });
    } else if (isNode && inModuleSrc) {
      failures.push({
        file,
        msg: `'${spec}' —— 红线：模块 src/** 是浏览器代码，禁止 node: 导入（Node 工具请放 __tests__/scripts/samples）`,
        line: lineOf(text, spec),
      });
    }
  }
}

/**
 * 极简注释剥离（lint 用近似实现，不追求词法完备）：
 * 逐字符扫描，跳过字符串字面量（'/"/` 含转义与模板 ${} 不深处理），
 * 删除 // 行注释与 /* 块注释内容（块注释替换为等长空白以保行号）。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') out += ' ', i++; // 保行号
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 找到说明符首次出现的行号 */
function lineOf(text, spec) {
  const idx = text.indexOf(spec);
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

console.log(`[lint] 共检查 ${files.length} 个 JS 文件`);
for (const f of failures) console.error(`[lint][错误] ${f.file}${f.line ? ':' + f.line : ''}\n  ${f.msg}`);
for (const w of [...new Set(warnings)].slice(0, 50)) console.warn(`[lint][警告] ${w}`);
if (warnings.length > 50) console.warn(`[lint][警告] ...另有 ${warnings.length - 50} 条警告未列出`);

if (failures.length > 0) {
  console.error(`[lint] 失败：${failures.length} 处语法或红线错误`);
  process.exit(1);
}
console.log('[lint] 通过 ✓');
