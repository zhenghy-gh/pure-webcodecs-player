#!/usr/bin/env node
/** Real-page smoke: --only mp4,hls --width 1280 --out-dir .tmp/ui-smoke
 * --base-url http://localhost:8080 reuses a running server.
 * Historical screenshots are never overwritten by default.
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { arg, ROOT, startSite, launchBrowser } from './browser-env.mjs';

const names = ['core', 'mp4', 'mov', 'ts', 'flv', 'mkv', 'hls', 'cmaf', 'wav', 'flac', 'ape', 'subtitle', 'webrtc', 'rtsp', 'rtmp', 'webtorrent'];
const demos = [...names.map(name => ({ name, path: `${name}/demo/index.html` })),
  { name: 'hub', path: 'site/demo/index.html' }, { name: 'landing', path: 'site/landing.html' },
  { name: 'ref-hls', path: 'site/demo/ref-hls.html' }, { name: 'ref-flv', path: 'site/demo/ref-flv.html' }];
const only = arg('--only')?.split(',');
const out = path.resolve(ROOT, arg('--out-dir', '.tmp/demo-smoke'));
const viewport = { width: Number(arg('--width', 1280)), height: Number(arg('--height', 900)) };
const results = [];
let site, browser;
try {
  site = await startSite(Number(arg('--port', 8123)));
  browser = await launchBrowser();
  await mkdir(out, { recursive: true });
  const targets = only ? demos.filter(demo => only.includes(demo.name)) : demos;
  if (!targets.length) throw new Error('No matching pages');
  for (const demo of targets) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => { if (!['rtsp', 'rtmp'].includes(demo.name)) errors.push(error.message); });
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,'; document.head.appendChild(icon); }, { once: true }));
    page.on('console', message => {
      if (message.type() === 'error' && !/Failed to load resource/.test(message.text()) && !['rtsp', 'rtmp'].includes(demo.name)) errors.push(message.text());
    });
    if (process.argv.includes('--block-cdn')) {
      await page.route('https://cdn.jsdelivr.net/**', route => route.abort('internetdisconnected'));
      await page.route('https://unpkg.com/**', route => route.abort('internetdisconnected'));
    }
    page.on('response', response => {
      if (response.url().startsWith(site.base) && response.status() >= 400 && !/favicon\.ico|\.map$/.test(response.url()))
        errors.push(`HTTP ${response.status()} ${response.url()}`);
    });
    try {
      await page.goto(`${site.base}/${demo.path}`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForFunction(() => document.body.innerText.trim().length > 20);
      if (['hub', 'landing'].includes(demo.name)) await page.waitForFunction(() => document.querySelectorAll('#module-grid a').length === 16);
      if (['hub', 'landing'].includes(demo.name) && await page.locator('#module-grid a').count() !== 16) errors.push('Expected 16 module cards');
      if (!process.argv.includes('--skip-drive')) {
        const sample = page.locator('[data-demo-sample]').first();
        if (await sample.count()) {
          await sample.click();
          const sampleChecks = {
            mp4: async () => { await page.waitForFunction(() => document.querySelector('video')?.duration < 10 && document.querySelector('video')?.videoWidth > 0, null, { timeout: 30000 }); const video = page.locator('video'); await video.evaluate(element => { element.currentTime = .6; }); await page.waitForFunction(() => document.querySelector('video')?.currentTime >= .5 && document.querySelector('video')?.currentTime < 3.8); },
            hls: async () => { await page.waitForFunction(() => document.querySelector('video')?.duration < 10 && document.querySelector('video')?.videoWidth > 0, null, { timeout: 20000 }); const video=page.locator('video'); await video.evaluate(element=>{element.pause();element.currentTime=.8}); await page.waitForFunction(()=>Math.abs((document.querySelector('video')?.currentTime||0)-.8)<.2); },
            'ref-hls': async () => page.waitForFunction(() => { const video=document.querySelector('video'), engine=document.querySelector('#i-engine')?.textContent; return (video?.videoWidth>0 && video.currentTime>.2) || engine==='不可用'; }, null, {timeout:30000}),
            'ref-flv': async () => page.waitForFunction(() => { const video=document.querySelector('video'), engine=document.querySelector('#i-engine')?.textContent; return (video?.videoWidth>0 && video.currentTime>.2) || engine==='不可用'; }, null, {timeout:30000}),
            wav: async () => { await page.waitForFunction(() => document.querySelector('#stage-badge')?.textContent.includes('就绪'), null, { timeout: 10000 }); await page.locator('[data-skin="play"]').click(); await page.waitForFunction(() => document.querySelector('#controls')?.classList.contains('is-playing'), null, { timeout: 10000 }); await page.waitForFunction(() => /状态.*(playing|ended)/i.test(document.querySelector('#stats')?.textContent || ''), null, { timeout: 10000 }); },
            flac: async () => { await page.waitForFunction(() => document.querySelector('#stage-badge')?.textContent.includes('就绪'), null, { timeout: 20000 }); await page.locator('[data-skin="play"]').click(); await page.waitForFunction(() => document.querySelector('#controls')?.classList.contains('is-playing'), null, { timeout: 10000 }); await page.waitForFunction(() => /状态.*(playing|ended)/i.test(document.querySelector('#stats')?.textContent || ''), null, { timeout: 10000 }); },
            ape: async () => page.waitForFunction(() => document.querySelector('#stage-badge')?.textContent.includes('解析完成'), null, { timeout: 10000 }),
            subtitle: async () => page.waitForFunction(() => Number(document.querySelector('#i-cues')?.textContent || 0) > 0, null, { timeout: 10000 }),
            ts: async () => page.waitForFunction(() => /MPEG-TS/.test(document.querySelector('#summary')?.textContent || ''), null, { timeout: 10000 }),
            flv: async () => { await page.waitForFunction(() => /容器: FLV/.test(document.querySelector('#summary')?.textContent || ''), null, { timeout: 10000 }); await page.locator('#btnRemux').click(); await page.waitForFunction(() => /MSE 就绪/.test(document.querySelector('#mseLog')?.textContent || ''), null, { timeout: 15000 }); await page.waitForFunction(() => document.querySelector('#player')?.videoWidth > 0 && document.querySelector('#player')?.currentTime > 0, null, { timeout: 10000 }); },
            mkv: async () => page.waitForFunction(() => document.querySelector('#iContainer')?.textContent.includes('mkv'), null, { timeout: 10000 }),
            cmaf: async () => page.waitForFunction(() => /chunks:/.test(document.querySelector('#tree')?.textContent || ''), null, { timeout: 10000 }),
            webtorrent: async () => page.waitForFunction(() => /离线装配就绪/.test(document.querySelector('#banner')?.textContent || ''), null, { timeout: 10000 }),
            mov: async () => page.waitForFunction(() => /选路：MovDemuxer/.test(document.querySelector('#log')?.textContent || ''), null, { timeout: 10000 }),
            webrtc: async () => page.waitForFunction(() => document.querySelector('#loopVideo')?.videoWidth > 0, null, { timeout: 10000 }),
          };
          if (sampleChecks[demo.name]) await sampleChecks[demo.name]();
        }
      }
      if (process.argv.includes('--strict-layout')) {
        const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
          skin: !!document.querySelector('body.pp-scope'), nav: !!document.querySelector('.pp-topbar') }));
        if (layout.width > layout.viewport + 1) errors.push(`Horizontal overflow: ${layout.width} > ${layout.viewport}`);
        if (!layout.skin || !layout.nav) errors.push('Shared page shell missing');
      }
    } catch (error) { errors.push(error.message.split('\n')[0]); }
    await page.screenshot({ path: path.join(out, `${demo.name}.png`), fullPage: true });
    results.push({ name: demo.name, ok: !errors.length, errors });
    console.log(`${errors.length ? 'FAIL' : 'PASS'} ${demo.name}${errors.length ? ': ' + errors.join('; ') : ''}`);
    await page.close();
  }
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ viewport, results }, null, 2));
  console.log(`Screenshots: ${out}; passed ${results.filter(result => result.ok).length}/${results.length}`);
  process.exitCode = results.some(result => !result.ok) ? 1 : 0;
} catch (error) { console.error(error); process.exitCode = 2; }
finally { await browser?.close(); site?.close(); }
