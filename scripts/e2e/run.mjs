#!/usr/bin/env node
/**
 * M3 端到端验收驱动 —— 真实 Chrome(系统安装) + 本项目 serve.mjs
 *
 * 用法：
 *   node scripts/e2e/run.mjs                # 默认 TS 素材 / WebCodecs 路线
 *   node scripts/e2e/run.mjs --headful      # 有头模式（调试）
 *   node scripts/e2e/run.mjs --port 8123 --media /samples/e2e/bbb480_30s.ts
 *
 * 产物：退出码 0=全过；非 0=有失败。控制台打印结构化结果。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 8123);
const HEADFUL = process.argv.includes('--headful');
const MEDIA = process.argv.find((a) => a.startsWith('--media='))?.split('=')[1] ?? '/samples/e2e/bbb480_30s.ts';
/** --harness=mse-harness.html 切换验收页（默认 WebCodecs 主路线页） */
const HARNESS = process.argv.find((a) => a.startsWith('--harness='))?.split('=')[1] ?? 'player-harness.html';
const URL = process.argv.find((a) => a.startsWith('--url='))?.split('=')[1] ?? (() => {
  const seekUs = process.argv.find((a) => a.startsWith('--seekUs='))?.split('=')[1];
  const q = new URLSearchParams({ media: MEDIA });
  if (seekUs) q.set('seekUs', seekUs);
  return `http://127.0.0.1:${PORT}/scripts/e2e/${HARNESS}?${q}`;
})();

let server;
async function startServer() {
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/scripts/e2e/${HARNESS}`, { method: 'HEAD' });
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('serve.mjs 启动超时');
}

async function main() {
  await startServer();
  console.log(`[e2e] serve @ :${PORT}  浏览器=${CHROME}`);
  console.log(`[e2e] 页面=${URL}`);

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
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const consoleMsgs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`[${m.type()}] ${m.text()} @${m.location()?.url ?? ''}`); });
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    try {
      const proto = typeof VideoDecoder !== 'undefined' && VideoDecoder.prototype;
      if (proto && !proto.__closeProbe) {
        proto.__closeProbe = true;
        const orig = proto.close;
        proto.close = function () {
          console.error('[VD-CLOSE]' + (new Error().stack?.split('\n').slice(1, 8).join(' <- ') ?? ''));
          return orig.apply(this, arguments);
        };
      }
    } catch { /* 探测补丁尽力而为 */ }
  });

  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => typeof window.__E2E_RUN__ === 'function', null, { timeout: 10000 });

  // 不 await：先在「播放中」截一张真实画面，再取最终结果（结束后元素已销毁，画面为黑）
  const runPromise = page.evaluate(() => window.__E2E_RUN__());
  const shot = path.join(ROOT, `docs/review/e2e-${HARNESS.replace(/\.html$/, '')}-shot.png`);
  const playingShot = shot.replace(/\.png$/, '-playing.png');
  const playingShot2 = shot.replace(/\.png$/, '-playing2.png');
  await sleep(2600);
  try { await page.screenshot({ path: playingShot }); } catch { /* 截图尽力而为 */ }
  await sleep(3500); // 此时多为 seek 后亮场景，作补充凭证
  try { await page.screenshot({ path: playingShot2 }); } catch { /* 截图尽力而为 */ }
  const result = await runPromise;
  await sleep(300);
  try { await page.screenshot({ path: shot }); } catch { /* 截图尽力而为 */ }

  await browser.close();
  server.kill();

  console.log('\n================ E2E 结果 ================');
  for (const r of result.results ?? []) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '\n        ' + r.detail : ''}`);
  }
  console.log('------------------------------------------');
  const pass = (result.results ?? []).filter((r) => r.pass).length;
  const total = (result.results ?? []).length;
  console.log(`${result.ok === false && result.fatal ? 'FATAL: ' + result.fatal : `通过 ${pass}/${total}`}`);
  if (consoleMsgs.length) {
    console.log('\n浏览器 console 告警/错误：');
    consoleMsgs.slice(0, 12).forEach((m) => console.log('  ' + m));
  }
  console.log(`截图：${shot}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e] 失败:', err.message);
  server?.kill();
  process.exit(2);
});
