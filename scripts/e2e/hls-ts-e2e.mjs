#!/usr/bin/env node
/**
 * HLS TS→fMP4 transmux 端到端真机验收。
 * 构造单分片 TS 形态 HLS（bbb480_30s.ts 作为 seg-000.ts + playlist.m3u8），
 * 由 hls demo 真机加载并播放，验证 Transmuxer→TsToFmp4Transmuxer→MSE 链路打通：
 * 无 pageerror、video.readyState>=3、videoWidth>0。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 8129;
const BASE = `http://127.0.0.1:${PORT}`;

// 1) 准备 TS 形态 HLS 素材
const TS_HLS = path.join(ROOT, 'samples/e2e/ts-hls');
fs.mkdirSync(TS_HLS, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'samples/e2e/bbb480_30s.ts'), path.join(TS_HLS, 'seg-000.ts'));
fs.writeFileSync(path.join(TS_HLS, 'playlist.m3u8'),
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:30\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:30.0,\nseg-000.ts\n#EXT-X-ENDLIST\n');
console.log(`TS HLS 素材就绪: ${TS_HLS}`);

// 2) serve
const server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/hls/demo/index.html`, { method: 'HEAD' }); if (r.ok) break; } catch {}
  await sleep(250);
}

// 3) 真机加载 hls demo，注入 TS playlist，验证播放
const browser = await chromium.launch({ executablePath: CHROME, headless: !process.argv.includes('--headful') });
const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
const pageErrors = [];
const consoleErrors = [];
const res404 = [];
page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
page.on('response', (r) => { if (r.status() >= 400) res404.push(`${r.status()} ${r.url()}`); });
await page.addInitScript(() => { const l = document.createElement('link'); l.rel = 'icon'; l.href = 'data:,'; document.head?.appendChild(l); });

await page.goto(`${BASE}/hls/demo/index.html`, { waitUntil: 'domcontentloaded' });
const url = `${BASE}/samples/e2e/ts-hls/playlist.m3u8`;
await page.fill('#url', url);
await page.click('#btn-load');
await sleep(12000);

const probe = await page.evaluate(() => {
  const v = document.querySelector('video');
  const log = document.querySelector('#log, pre, .log')?.textContent?.slice(-200) ?? '';
  return { readyState: v ? v.readyState : -1, videoWidth: v ? v.videoWidth : 0, videoHeight: v ? v.videoHeight : 0, currentTime: v ? +v.currentTime.toFixed(2) : 0, log };
});

await page.screenshot({ path: path.join(ROOT, 'docs/review/i3/hls-ts-transmux.png') }).catch(() => {});

await browser.close();
server.kill();

const ok = pageErrors.length === 0 && probe.readyState >= 3 && probe.videoWidth > 0;
console.log(`\n=== HLS TS transmux 端到端 ===`);
console.log(`readyState=${probe.readyState} videoWidth=${probe.videoWidth} videoHeight=${probe.videoHeight} currentTime=${probe.currentTime}s`);
console.log(`pageErrors(未捕获异常,${pageErrors.length}):`, pageErrors.slice(0, 5).join(' | '));
console.log(`consoleErrors(${consoleErrors.length}):`, consoleErrors.slice(0, 5).join(' | '));
console.log(`res404(${res404.length}):`, res404.slice(0, 5).join(' | '));
console.log(`log tail: ${probe.log.slice(-160)}`);
console.log(ok ? 'RESULT: PASS ✅' : 'RESULT: FAIL ❌');
process.exit(ok ? 0 : 1);
