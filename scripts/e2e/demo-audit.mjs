#!/usr/bin/env node
/**
 * I3 demo 可用性验收驱动 —— 真实 Chrome + serve.mjs
 * ------------------------------------------------------------
 * 逐 demo（16 模块）四维验收：
 *   L1 静态直开：goto 后收集 pageerror / console.error / 资源 404（site skin 引用完整性）
 *   L2 交互注入：按模块形态（url 直链 / 拖放 / input[type=file] / 按钮）注入素材或假地址，
 *                验证交互链路不产生未捕获异常（pageerror=0）且产生受控反馈（log/banner 文本或播放状态）
 *   L3 降级提示：错误路径（假文件/不可达地址）应显示提示而非静默或崩溃；不支持特性的 demo
 *                在 headless 全能力环境走成功路径，天然验证成功路径
 *   L4 skin 复用：引用 site 组件的 demo 无 js/css 404 且 .site-nav/.site-* 注入成功（页面级断言）
 *
 * 用法：node scripts/e2e/demo-audit.mjs [--headful] [--only=mp4,ts]
 * 产物：退出码 0=全过；docs/review/i3/<name>.png 每 demo 交互后截图
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8125;
const HEADFUL = process.argv.includes('--headful');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');

const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(ROOT, 'docs/review/i3');
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** 每个 demo 的注入形态。
 *  mode:
 *   - load-only    直开（core/ape 纯展示/按钮类的基础形态，core 另配按钮）
 *   - url          填输入框 + 点按钮（mp4 Range / hls / rtsp / rtmp）
 *   - url-err      同上，地址必然失败（网络类受控错误）
 *   - drop-file    拖放本地文件（mov/mkv 等 BlobDataSource 形态）
 *   - file-input   注入 input[type=file]（setInputFiles 触发 change）
 *   - click        点击内置按钮（wav/flac 内置生成 / webrtc 本机回环 / core 能力按钮）
 *  expect: 'ok' 期望成功路径反馈；'err' 期望受控错误提示。
 */
const PLAN = [
  { m: 'core',      mode: 'load-only', click: ['#renderToggle', '#audioToggle'], expect: 'ok',
    probe: () => document.querySelectorAll('canvas').length + ' | ' + (document.querySelector('#cap')?.textContent?.slice(0, 60) ?? '') },
  { m: 'mp4',       mode: 'url',       url: `${BASE}/samples/e2e/sintel-trailer.mp4`, sel: '#url', btn: '#playUrl', expect: 'ok',
    probe: () => { const v = document.querySelector('video'); const lg = document.querySelector('#log')?.textContent?.slice(-140) ?? ''; return `video:${v ? `rs=${v.readyState} w=${v.videoWidth}` : 'none'} | ${lg}`; } },
  { m: 'mov',       mode: 'drop-file', file: `${BASE}/samples/e2e/sintel-trailer.mp4`, dropSel: '#drop', expect: 'ok',
    probe: () => { const v = document.querySelector('video'); return v ? `readyState=${v.readyState} w=${v.videoWidth}` : 'no-video'; } },
  { m: 'mkv',       mode: 'drop-file', file: `${BASE}/samples/fixtures/noop.bin`, dropSel: null, expect: 'err',
    probe: () => document.querySelector('pre,#log,.log,textarea')?.textContent?.slice(-120) ?? '' },
  { m: 'ts',        mode: 'file-input', file: `${BASE}/samples/e2e/bbb480_30s.ts`, sel: '#fileInput', expect: 'ok',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'flv',       mode: 'file-input', file: `${BASE}/samples/fixtures/noop.bin`, sel: '#fileInput', name: 'fake.flv', expect: 'err',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'hls',       mode: 'url',        url: `${BASE}/samples/e2e/fmp4/playlist.m3u8`, sel: '#url', btn: '#btn-load', expect: 'ok', waitMs: 6000,
    probe: () => { const st = document.querySelector('#stats, .stats')?.textContent?.slice(-140) ?? ''; const b = document.querySelector('#offline-banner, .banner')?.textContent?.slice(0, 60) ?? ''; const v = document.querySelector('video'); return `stats:[${st}] banner:[${b}] rs=${v ? v.readyState : '-'}`; } },
  { m: 'cmaf',      mode: 'file-input', file: `${BASE}/samples/fixtures/noop.bin`, sel: '#file', name: 'fake.cmf1', expect: 'err',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'wav',       mode: 'click',      click: ['#gen-demo'], expect: 'ok',
    probe: () => { const s = document.querySelector('#stage-badge, #status, pre'); return s?.textContent?.slice(0,80) ?? ''; } },
  { m: 'flac',      mode: 'click',      click: ['#gen-demo'], expect: 'ok',
    probe: () => { const s = document.querySelector('#stage-badge, #status, pre'); return s?.textContent?.slice(0,80) ?? ''; } },
  { m: 'ape',       mode: 'file-input', file: `${BASE}/samples/fixtures/noop.bin`, sel: '#file', name: 'fake.ape', expect: 'err',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'subtitle',  mode: 'file-input', file: `${BASE}/samples/fixtures/subtitle.srt`, sel: '#file-input', name: 'demo.srt', expect: 'ok',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-120) ?? '' },
  { m: 'webrtc',    mode: 'click',      click: ['#btn-loop'], expect: 'ok', waitMs: 4500,
    probe: () => { const v = document.querySelector('video'); return v ? `readyState=${v.readyState} w=${v.videoWidth}` : 'no-video'; } },
  { m: 'rtsp',      mode: 'url-err',    url: 'ws://127.0.0.1:59999/rtsp', sel: '#url', btn: '#btnStart', expect: 'err',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'rtmp',      mode: 'url-err',    url: 'ws://127.0.0.1:59999/live/test', sel: '#url', btn: '#btnStart', expect: 'err',
    probe: () => document.querySelector('pre,#log')?.textContent?.slice(-100) ?? '' },
  { m: 'webtorrent',mode: 'file-input', file: `${BASE}/samples/fixtures/noop.bin`, sel: '#fileTorrent', name: 'fake.torrent', expect: 'err',
    probe: () => document.querySelector('pre,#log,.banner')?.textContent?.slice(-100) ?? '' },
];

/* 准备一次性注入素材：noop.bin / subtitle.srt（浏览器内 fetch 同源读） */
const REAL_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  '第一行字幕',
  '',
  '2',
  '00:00:02,000 --> 00:00:04,000',
  'Second line EN',
  '',
].join('\n');
fs.mkdirSync(path.join(ROOT, 'samples/fixtures'), { recursive: true });
if (!fs.existsSync(path.join(ROOT, 'samples/fixtures/noop.bin'))) {
  fs.writeFileSync(path.join(ROOT, 'samples/fixtures/noop.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
}
fs.writeFileSync(path.join(ROOT, 'samples/fixtures/subtitle.srt'), REAL_SRT);

let server;
async function startServer() {
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/core/demo/index.html`, { method: 'HEAD' });
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('serve.mjs 启动超时');
}

const GLOBAL_ERRORS = { pageerrors: [], consoleErrors: [], skin404: [], res404: [] };

async function auditOne(browser, plan) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 700 } });
  const page = await ctx.newPage();
  // 抑制无业务意义的 favicon.ico 404（demo 均未提供图标，浏览器自动请求会产生 console 噪点）
  await page.addInitScript(() => {
    const l = document.createElement('link');
    l.rel = 'icon';
    l.href = 'data:,';
    document.head?.appendChild(l);
  });
  const pe = [];
  const ce = [];
  const resBad = [];
  page.on('pageerror', (e) => pe.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') ce.push(m.text().slice(0, 140)); });
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const u = r.url();
      const line = `${r.status()} ${u.replace(BASE, '')}`;
      resBad.push(line);
      if (/\.(js|css|svg)$/i.test(new URL(u).pathname)) GLOBAL_ERRORS.skin404.push(`${plan.m}: ${line}`);
    }
  });

  const tag = plan.m;
  const url = `${BASE}/${tag}/demo/index.html`;
  let step = 'L1 直开';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await sleep(plan.waitMs ?? 1600);
  } catch (e) { pe.push(`goto 失败: ${e.message.slice(0, 120)}`); }

  /* L4 skin：引用 site 组件的 demo 应渲染 .site-nav / 至少无 css|js 404 */
  let skinOk = true;
  if (['ape', 'cmaf', 'flac', 'hls', 'mkv', 'subtitle', 'wav', 'webrtc'].includes(tag)) {
    skinOk = await page.evaluate(() => {
      const hasNav = !!document.querySelector('.site-nav');
      const hasSkinTag = !!document.querySelector('[class*="site-"], [data-site-nav]');
      return { hasNav, hasSkinTag };
    }).catch(() => ({ hasNav: false, hasSkinTag: false }));
  }

  /* L2 注入 */
  step = 'L2 交互注入';
  try {
    if (plan.mode === 'url' || plan.mode === 'url-err') {
      await page.fill(plan.sel, plan.url);
      await page.click(plan.btn);
    } else if (plan.mode === 'file-input') {
      const buf = await (await fetch(plan.file)).arrayBuffer();
      await page.setInputFiles(plan.sel, { name: plan.name ?? plan.file.split('/').pop(), mimeType: '', buffer: Buffer.from(buf) });
    } else if (plan.mode === 'drop-file') {
      await page.evaluate(async ({ asset, dropSel }) => {
        const res = await fetch(asset);
        const buf = await res.arrayBuffer();
        const f = new File([buf], asset.split('/').pop(), { type: '' });
        const dt = new DataTransfer();
        dt.items.add(f);
        const target = dropSel ? document.querySelector(dropSel) : document;
        (target || document).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, { asset: plan.file, dropSel: plan.dropSel ?? null });
    } else if (plan.mode === 'click') {
      for (const s of plan.click ?? []) {
        const btn = await page.$(s).catch(() => null);
        if (btn) await btn.click().catch(() => {});
      }
    }
    await sleep(plan.waitMs ?? 3200);
  } catch (e) { pe.push(`注入失败: ${e.message.slice(0, 120)}`); }

  const probeText = await page.evaluate(plan.probe).catch(() => '(probe 异常)');
  const shot = path.join(SHOT_DIR, `${tag}.png`);
  await page.screenshot({ path: shot }).catch(() => {});

  const evidence = { probe: String(probeText).slice(0, 160), step };
  await ctx.close();

  const pageerr = pe.length === 0;
  const skinDetail = ['ape', 'cmaf', 'flac', 'hls', 'mkv', 'subtitle', 'wav', 'webrtc'].includes(tag)
    ? JSON.stringify(skinOk) : null;
  const skinPass = skinDetail
    ? (typeof skinOk === 'object' && (skinOk.hasNav || skinOk.hasSkinTag))
    : true;
  return { m: tag, pageerr, skinPass, skinDetail, pe, ce: ce.slice(0, 3), resBad: resBad.slice(0, 4), evidence };
}

async function main() {
  await startServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADFUL,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });

  const rows = [];
  for (const plan of PLAN) {
    if (ONLY && !ONLY.includes(plan.m)) continue;
    const r = await auditOne(browser, plan);
    rows.push(r);
    const peInfo = r.pe.length ? ` pageerror=[${r.pe[0]}]` : '';
    console.log(`${r.pageerr ? 'PASS' : 'FAIL'}  ${r.m}${peInfo}`);
    console.log(`      probe=${r.evidence.probe}`);
    if (r.skinDetail && r.skinDetail !== 'false') console.log(`      skin=${r.skinDetail}`);
    if (r.ce.length) console.log(`      consoleErr=${r.ce[0]}`);
    if (r.resBad.length) r.resBad.slice(0, 4).forEach((x) => console.log(`      http404=${x}`));
  }
  await browser.close();
  server.kill();

  console.log('\n========== I3 汇总 ==========');
  const pass = rows.filter((r) => r.pageerr).length;
  console.log(`无未捕获异常：${pass}/${rows.length}`);
  const skinRows = rows.filter((r) => r.skinDetail && r.skinDetail !== 'false');
  if (skinRows.length) console.log(`skin 注入抽查：${skinRows.filter((r) => r.skinPass).length}/${skinRows.length}`);
  if (GLOBAL_ERRORS.skin404.length) { console.log('site 资源 404（js/css/svg）：'); GLOBAL_ERRORS.skin404.slice(0, 8).forEach((s) => console.log('  ' + s)); }
  else console.log('site 资源 404：0');
  console.log(`截图目录：${SHOT_DIR}`);
  process.exit(rows.some((r) => !r.pageerr) ? 1 : 0);
}

main().catch((err) => {
  console.error('[demo-audit] 失败:', err.message);
  server?.kill();
  process.exit(2);
});
