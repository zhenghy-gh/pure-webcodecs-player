#!/usr/bin/env node
/**
 * §2.4 契约对齐 —— 结构层全模块现盘审计
 *
 * 对照 docs/review/checklist.md §2.4 八项，对 16 模块 demuxer 外表面做结构层核对：
 *   1. 类名 <Format>Demuxer 且继承 core Demuxer
 *   2. static probe(bytes) 同步、无副作用、不抛异常、未命中返回 null
 *   3. open() + 迁移别名 parseInit/init/attach
 *   4. readSample(trackId) / samples(trackId) 糖层
 *   5. seek(timestampUs)
 *   6. 直播 start()【可选】/ pause / resume / destroy() 幂等 + 别名 stop
 *   7. 事件名（运行时核对见 contract-2-4-runtime.mjs）
 *   8. 时间戳整数 µs（运行时核对）
 *
 * 用法：node scripts/audit/contract-2-4-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * scope 决定该模块是否适用 §2.4 契约的 demuxer 类级检查：
 *   demuxer    = 适用 §2.4 全文（必须导出 <Format>Demuxer 且继承 core Demuxer）
 *   probe-only = 仅 probe + MediaInfo（Phase 3 未落 demuxer）
 *   source     = 只产 Source（传输层）
 *   base       = 基类自身（不适用子类规则）
 *   segment    = fMP4 分片解析（无契约 Demuxer 定位）
 *   pipeline   = 播放链路（m3u8 + 分片加载 + transmux + MSE，非单一 demuxer）
 *   parser     = 字幕/文本解析渲染（非音视轨 demuxer）
 *
 * ⚠️ 2026-09-09 修正：cmaf/hls/subtitle 原被误标为 demuxer，导致「index 未导出 demuxer 类」
 *    被计为缺陷。三者本就无契约 Demuxer 定位（见各自 index.js 导出面），属 scope 误判。
 */
const MODULES = [
  { dir: 'mp4', scope: 'demuxer' },
  { dir: 'mov', scope: 'demuxer' },
  { dir: 'cmaf', scope: 'segment', note: 'fMP4 分片解析 + WebCodecs player（无契约 Demuxer 定位）' },
  { dir: 'mkv', scope: 'demuxer' },
  { dir: 'ts', scope: 'demuxer' },
  { dir: 'flv', scope: 'demuxer' },
  { dir: 'hls', scope: 'pipeline', note: 'm3u8 + 分片加载 + transmux + MSE（非单一 demuxer）' },
  { dir: 'wav', scope: 'demuxer' },
  { dir: 'flac', scope: 'demuxer' },
  { dir: 'ape', scope: 'probe-only', note: 'Phase 3 仅 probe+MediaInfo' },
  { dir: 'subtitle', scope: 'parser', note: 'SRT/VTT/ASS 解析渲染（非音视轨 demuxer）' },
  { dir: 'webtorrent', scope: 'source', note: '只产 Source' },
  { dir: 'webrtc', scope: 'source', note: '只产 Source' },
  { dir: 'rtmp', scope: 'source', note: '只产 Source；内 FlvDemuxer 为 push/flush 流式解析器，非契约 Demuxer' },
  { dir: 'rtsp', scope: 'source', note: '只产 Source' },
  { dir: 'core', scope: 'base', note: '基类自身' },
];

/**
 * 已裁决保留项：结构层与基类不一致，但经评审裁决明确保留的。
 * 不计入 issues，输出为「○ 已裁决保留」提示，避免后人误当缺陷重构。
 * 依据：docs/review/mkv-base-class-alignment.md §8（I1 首轮裁决）
 */
const DECIDED = {
  mkv: {
    ownDoOpen:
      '案 C 保留自实现 open()（D1 重入抛 STATE_ERROR / D2 失败回 idle 可 attach 重试），见 mkv-base-class-alignment.md §8 裁决 D1/D2',
  },
};

const REQUIRED = ['open', 'readSample', 'samples', 'seek', 'pause', 'resume', 'destroy'];
const OPTIONAL_LIVE = ['start'];
const ALIASES = ['parseInit', 'init', 'attach', 'stop'];

/** 固定伪随机（xorshift），保证多次运行结果可复现 */
function garbage(n) {
  const u = new Uint8Array(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    u[i] = x & 0xff;
  }
  return u;
}

const { Demuxer } = await import(pathToFileURL(path.join(ROOT, 'core', 'src', 'demuxer.js')).href);

/** src 目录下扫 export class ... Demuxer（index 未导出时的兜底定位） */
function scanSrcForDemuxer(dir) {
  const srcDir = path.join(ROOT, dir, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js')) {
        const txt = fs.readFileSync(p, 'utf8');
        for (const m of txt.matchAll(/export\s+class\s+(\w*Demuxer)\b/g)) hits.push(`${path.relative(ROOT, p)}:${m[1]}`);
      }
    }
  };
  walk(srcDir);
  return hits;
}

const rows = [];

for (const mod of MODULES) {
  const entry = path.join(ROOT, mod.dir, 'src', 'index.js');
  const row = {
    dir: mod.dir,
    scope: mod.scope,
    note: mod.note ?? '',
    classes: [],
    hasDefault: null,
    error: null,
    srcHits: [],
  };

  if (!fs.existsSync(entry)) {
    row.error = 'no src/index.js';
    rows.push(row);
    continue;
  }

  let ns;
  try {
    ns = await import(pathToFileURL(entry).href);
  } catch (e) {
    row.error = `import failed: ${e.message}`;
    rows.push(row);
    continue;
  }

  row.hasDefault = 'default' in ns;

  for (const [name, v] of Object.entries(ns)) {
    if (typeof v !== 'function' || !v.prototype) continue;
    // 只认真正的 class（排除 registerDemuxer 之类同名函数）
    const isClass = /^\s*class\s/.test(Function.prototype.toString.call(v));
    const extendsBase = v.prototype instanceof Demuxer;
    if (!isClass) continue;
    if (!extendsBase && !/Demuxer$/.test(name)) continue;

    const ownProbe = Object.prototype.hasOwnProperty.call(v, 'probe');
    const ownDoOpen = Object.prototype.hasOwnProperty.call(v.prototype, '_doOpen');

    // probe 行为：同步 / 不抛 / 垃圾输入返回 null
    let probeSync = null;
    let probeSafe = true;
    let probeNull = null;
    let probeErr = '';
    if (typeof v.probe === 'function') {
      try {
        const r = v.probe(garbage(4096));
        probeSync = !(r && typeof r.then === 'function');
        probeNull = r == null;
        for (const n of [0, 8, 64, 4096]) {
          try {
            const rr = v.probe(garbage(n));
            if (rr != null) probeNull = false;
          } catch (e) {
            probeSafe = false;
            probeErr = `throw@${n}B: ${e.message}`;
            break;
          }
        }
      } catch (e) {
        probeSafe = false;
        probeErr = `throw@4096B: ${e.message}`;
      }
    }

    const missing = REQUIRED.filter((k) => typeof v.prototype[k] !== 'function');
    const liveMissing = OPTIONAL_LIVE.filter((k) => typeof v.prototype[k] !== 'function');
    const aliases = ALIASES.filter((k) => typeof v.prototype[k] === 'function');

    row.classes.push({
      name,
      // 类名 <Format>Demuxer：Format 段允许数字（Mp4Demuxer / MovDemuxer）
      nameOk: /^[A-Z][A-Za-z0-9]*Demuxer$/.test(name),
      extendsBase,
      ownProbe,
      ownDoOpen,
      probeSync,
      probeSafe,
      probeErr,
      probeNull,
      missing,
      liveMissing,
      aliases,
    });
  }

  if (row.classes.length === 0 && mod.scope !== 'source' && mod.scope !== 'base') {
    row.srcHits = scanSrcForDemuxer(mod.dir).slice(0, 5);
  }

  rows.push(row);
}

/* ------------------------------ 输出 ------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
console.log('='.repeat(118));
console.log('§2.4 契约对齐 —— 结构层全模块审计');
console.log('='.repeat(118));

let issues = 0;
for (const r of rows) {
  console.log(`\n[${r.dir}] scope=${r.scope}${r.note ? ' (' + r.note + ')' : ''}`);
  if (r.error) {
    console.log(`  !! ${r.error}`);
    issues++;
    continue;
  }
  if (r.hasDefault) {
    console.log('  !! 存在 default 导出（G3 违规）');
    issues++;
  }
  if (r.classes.length === 0) {
    console.log(`  -- 未导出 demuxer 类${r.srcHits.length ? '（src 内声明：' + r.srcHits.join(', ') + '）' : ''}`);
    if (r.scope === 'demuxer') {
      console.log('  !! scope=demuxer 但 index 未导出 demuxer 类');
      issues++;
    }
    continue;
  }
  for (const c of r.classes) {
    const shape = `  -- ${pad(c.name, 22)} extends=${c.extendsBase ? 'Y' : 'N'} ownProbe=${c.ownProbe ? 'Y' : 'N'} ownDoOpen=${c.ownDoOpen ? 'Y' : 'N'} probe{${c.probeSync === null ? '-' : c.probeSync ? 'sync' : 'ASYNC'}/${c.probeSafe === null ? '-' : c.probeSafe ? 'safe' : 'THROW'}/${c.probeNull === null ? '-' : c.probeNull ? 'null' : 'NOTNULL'}} start=${c.liveMissing.length ? 'N' : 'Y'} alias=[${c.aliases.join(',')}]`;

    // 非 demuxer scope：不适用 §2.4 类级契约（基类自身 / 传输层 / 分片 / 播放链路 / 字幕解析）
    // 仅作信息展示，不计入 issues——避免把「本就无契约 Demuxer 定位」的模块误判为缺陷。
    if (r.scope !== 'demuxer') {
      console.log(shape);
      console.log(`       ○ scope=${r.scope}：不适用 §2.4 demuxer 类级检查，仅登记`);
      continue;
    }

    const flags = [];
    const notes = [];
    if (!c.nameOk) flags.push(`类名不合 <Format>Demuxer（${c.name}）`);
    if (!c.extendsBase) flags.push('未继承 core Demuxer');

    const checks = [
      { k: 'ownProbe', bad: !c.ownProbe, msg: '未自实现 static probe（仅继承基类恒 null）' },
      { k: 'probeSync', bad: c.probeSync === false, msg: 'probe 非同步（返回 Promise）' },
      { k: 'probeSafe', bad: c.probeSafe === false, msg: `probe 抛异常：${c.probeErr}` },
      { k: 'probeNull', bad: c.probeNull === false, msg: 'probe 对垃圾输入未返回 null' },
      { k: 'ownDoOpen', bad: !c.ownDoOpen, msg: '未实现 _doOpen（open 无法产出 MediaInfo）' },
      { k: 'methods', bad: c.missing.length > 0, msg: `缺方法：${c.missing.join('/')}` },
    ];
    for (const chk of checks) {
      if (!chk.bad) continue;
      const decided = DECIDED[r.dir]?.[chk.k];
      if (decided) notes.push(`○ 已裁决保留 [${chk.k}]：${decided}`);
      else flags.push(chk.msg);
    }

    const status = flags.length ? '!!' : 'OK';
    issues += flags.length;
    console.log(
      `  ${status} ${pad(c.name, 22)} extends=${c.extendsBase ? 'Y' : 'N'} ownProbe=${c.ownProbe ? 'Y' : 'N'} ownDoOpen=${c.ownDoOpen ? 'Y' : 'N'} probe{${c.probeSync === null ? '-' : c.probeSync ? 'sync' : 'ASYNC'}/${c.probeSafe === null ? '-' : c.probeSafe ? 'safe' : 'THROW'}/${c.probeNull === null ? '-' : c.probeNull ? 'null' : 'NOTNULL'}} start=${c.liveMissing.length ? 'N' : 'Y'} alias=[${c.aliases.join(',')}]`
    );
    for (const f of flags) console.log(`       ↳ ${f}`);
    for (const n of notes) console.log(`       ${n}`);
  }
}

console.log('\n' + '='.repeat(118));
console.log(`合计结构层问题：${issues}`);
console.log('='.repeat(118));
