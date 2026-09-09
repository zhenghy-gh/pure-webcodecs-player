#!/usr/bin/env node
/**
 * P2 真机 e2e 回归 —— 把 docs/review/i3/ 的手工验证固化成可重跑脚本。
 *
 * 做法：起 serve.mjs（共享实例）→ playwright 驱动真实 Chrome，遍历 16 个模块 demo 页 + hub
 * 总览页，逐页：捕获 console error / pageerror（白屏/import 失败硬指标）→ 对可自动驱动的 demo
 * 注入本地样本并验证播放/解析 → 全屏截图刷新 docs/review/i3/<module>.png 与 docs/demo/demo-hub.png
 * → 输出结构化报告，有硬错误则退出码非 0。
 *
 * 用法：
 *   node scripts/e2e/demo-smoke.mjs                # 默认无头
 *   node scripts/e2e/demo-smoke.mjs --headful      # 有头（调试）
 *   node scripts/e2e/demo-smoke.mjs --port 8123
 *   node scripts/e2e/demo-smoke.mjs --only mp4,hls  # 只跑指定模块（逗号分隔）
 *
 * 依赖：playwright-core（本地需 `npm i -D playwright-core`，或用 workspace 已装副本）。
 *       本脚本属「真机 e2e」工具，不进 CI 必跑项（env 浏览器层在 coverage-gate 中豁免）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
function loadPlaywrightCore() {
  const candidates = [
    'playwright-core',
    '/Users/zhenghaiyang/.workbuddy/binaries/node/workspace/node_modules/playwright-core',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* 继续候选 */ }
  }
  throw new Error('playwright-core 未找到：请 `npm i -D playwright-core` 或确认 workspace 路径');
}
const { chromium } = loadPlaywrightCore();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
/** 取 CLI 参数：同时支持 `--flag=value` 与 `--flag value` 两种写法 */
function getArg(flag, dflt) {
  const eq = process.argv.find((a) => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}
const PORT = Number(getArg('--port', 8123));
const HEADFUL = process.argv.includes('--headful');
const ONLY = getArg('--only');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 16 模块 demo + hub 总览；out 指向 i3 手工验证截图（刷新证据） */
const DEMOS = [
  { name: 'core', path: 'core/demo/index.html', out: 'docs/review/i3/core.png' },
  { name: 'mp4', path: 'mp4/demo/index.html', out: 'docs/review/i3/mp4.png', drive: 'mp4' },
  { name: 'mov', path: 'mov/demo/index.html', out: 'docs/review/i3/mov.png' },
  { name: 'ts', path: 'ts/demo/index.html', out: 'docs/review/i3/ts.png' },
  { name: 'flv', path: 'flv/demo/index.html', out: 'docs/review/i3/flv.png' },
  { name: 'mkv', path: 'mkv/demo/index.html', out: 'docs/review/i3/mkv.png' },
  { name: 'hls', path: 'hls/demo/index.html', out: 'docs/review/i3/hls.png', drive: 'hls' },
  { name: 'cmaf', path: 'cmaf/demo/index.html', out: 'docs/review/i3/cmaf.png' },
  { name: 'wav', path: 'wav/demo/index.html', out: 'docs/review/i3/wav.png' },
  { name: 'flac', path: 'flac/demo/index.html', out: 'docs/review/i3/flac.png' },
  { name: 'ape', path: 'ape/demo/index.html', out: 'docs/review/i3/ape.png' },
  { name: 'subtitle', path: 'subtitle/demo/index.html', out: 'docs/review/i3/subtitle.png' },
  { name: 'webrtc', path: 'webrtc/demo/index.html', out: 'docs/review/i3/webrtc.png' },
  { name: 'rtsp', path: 'rtsp/demo/index.html', out: 'docs/review/i3/rtsp.png' },
  { name: 'rtmp', path: 'rtmp/demo/index.html', out: 'docs/review/i3/rtmp.png' },
  { name: 'webtorrent', path: 'webtorrent/demo/index.html', out: 'docs/review/i3/webtorrent.png' },
  { name: 'hub', path: 'site/demo/index.html', out: 'docs/demo/demo-hub.png' },
];

/** 本地样本可加载的 demo 自动驱动（失败仅记 warning，不判 FAIL） */
const DRIVERS = {
  async mp4(page, root) {
    await page.fill('#url', root + '/samples/e2e/sintel-trailer.mp4', { timeout: 5000 });
    await page.click('#playUrl', { timeout: 5000 });
    await page.waitForFunction(
      () => { const v = document.getElementById('video'); return v && !v.paused && v.currentTime > 1; },
      { timeout: 20000 },
    );
  },
  async hls(page, root) {
    await page.fill('#url', root + '/samples/e2e/ts-hls/playlist.m3u8', { timeout: 5000 });
    await page.click('#btn-load', { timeout: 5000 });
    await page.waitForFunction(
      () => { const s = document.getElementById('stats'); return s && /分片|缓冲|就绪/.test(s.textContent); },
      { timeout: 25000 },
    );
  },
};

let server;
async function startServer() {
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/mp4/demo/index.html`, { method: 'HEAD' });
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('serve.mjs 启动超时');
}

async function main() {
  await startServer();
  const root = `http://127.0.0.1:${PORT}`;
  console.log(`[demo-smoke] serve @ :${PORT}  浏览器=${CHROME}`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADFUL,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--mute-audio',
    ],
  });

  const targets = ONLY ? DEMOS.filter((d) => ONLY.split(',').includes(d.name)) : DEMOS;
  const results = [];
  let failed = 0;

  for (const demo of targets) {
    const url = `${root}/${demo.path}`;
    const outPath = path.join(ROOT, demo.out);
    mkdirSync(path.dirname(outPath), { recursive: true });

    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    const errors = [];
    const warnings = [];
    const badResources = []; // 非良性 4xx/5xx（favicon/sourcemap 已豁免）
    const benignResource = (url) => /favicon\.ico$|[?/][^/?]*\.map($|\?)/.test(url) || url.endsWith('.map');
    page.on('console', (m) => {
      // "Failed to load resource" 类由 response 监听负责判定良恶性，这里只留显式错误
      if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(`[console.error] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !benignResource(r.url())) badResources.push(`${r.status()} ${r.url()}`);
    });

    let driveNote = '';
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const driver = demo.drive ? DRIVERS[demo.drive] : null;
      if (driver) {
        try {
          await driver(page, root);
          driveNote = `驱动(${demo.drive})成功`;
        } catch (e) {
          warnings.push(`驱动(${demo.drive})未达成：${e.message?.split('\n')[0] ?? e.message}`);
        }
      }
      await sleep(1200); // 让渲染/动画稳定
      await page.screenshot({ path: outPath });
      const allErrors = [...errors, ...badResources];
      const ok = allErrors.length === 0;
      if (!ok) failed += 1;
      results.push({ name: demo.name, ok, shot: demo.out, errors: [...allErrors], warnings: [...warnings], driveNote });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${demo.name.padEnd(11)} 截图=${demo.out}${driveNote ? '  ' + driveNote : ''}${allErrors.length ? '\n        ' + allErrors.join('\n        ') : ''}${warnings.length ? '\n        [warn] ' + warnings.join('; ') : ''}`);
    } catch (e) {
      failed += 1;
      results.push({ name: demo.name, ok: false, shot: demo.out, errors: [...errors, `[goto] ${e.message}`], warnings: [...warnings], driveNote });
      console.log(`FAIL  ${demo.name.padEnd(11)}  ${e.message?.split('\n')[0] ?? e.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.kill();

  console.log('\n================ demo-smoke 结果 ================');
  console.log(`全部 ${results.length} 页，失败 ${failed}`);
  console.log('截图目录：docs/review/i3/（模块）+ docs/demo/demo-hub.png（总览）');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('[demo-smoke] 失败:', err.message);
  server?.kill();
  process.exit(2);
});
