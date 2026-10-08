/** Browser tooling only; the player has no third-party runtime dependency. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export function arg(name, fallback) {
  const eq = process.argv.find(value => value.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
export function loadChromium() {
  const require = createRequire(import.meta.url);
  for (const candidate of ['playwright-core', process.env.PLAYWRIGHT_CORE_PATH,
    '/Users/zhenghaiyang/.workbuddy/binaries/node/workspace/node_modules/playwright-core'].filter(Boolean)) {
    try { return require(candidate).chromium; } catch { /* next installed environment */ }
  }
  throw new Error('playwright-core not found; set PLAYWRIGHT_CORE_PATH to an installed copy');
}
export async function startSite(port = 8123, base = arg('--base-url')) {
  if (base) {
    const response = await fetch(new URL('site/demo/index.html', base.endsWith('/') ? base : base + '/'));
    if (!response.ok) throw new Error(`Site unavailable: HTTP ${response.status}`);
    return { base: base.replace(/\/$/, ''), close() {} };
  }
  const address = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = null;
  server.on('error', error => { failure = error; });
  server.on('exit', code => { failure = new Error(`Site server exited (${code})`); });
  for (let i = 0; i < 40; i++) {
    if (failure) throw failure;
    try {
      const response = await fetch(`${address}/site/demo/index.html`);
      if (response.ok && !failure) return { base: address, close() { server.kill(); } };
    } catch { /* wait for readiness */ }
    await sleep(250);
  }
  server.kill();
  throw new Error('Site startup timed out');
}
export async function launchBrowser() {
  return loadChromium().launch({ executablePath: CHROME, headless: !process.argv.includes('--headful'),
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'] });
}
