import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pages = ['core/demo/index.html','mp4/demo/index.html','mov/demo/index.html','ts/demo/index.html','flv/demo/index.html','mkv/demo/index.html','webtorrent/demo/index.html','cmaf/demo/index.html','hls/demo/index.html','wav/demo/index.html','flac/demo/index.html','ape/demo/index.html','subtitle/demo/index.html','webrtc/demo/index.html','rtsp/demo/index.html','rtmp/demo/index.html','site/demo/ref-hls.html','site/demo/ref-flv.html'];
for (const name of pages) {
  test(`${name}: shared skin, preserved controls and valid local resources`, () => {
    const page = readFileSync(path.join(root, name), 'utf8');
    assert.match(page, /<body class="pp-scope">/);
    assert.match(page, /data-site-nav data-root="\.\.\/\.\.\/"/);
    assert.match(page, /data-demo-samples/);
    assert.match(page, /PurePlay|PUREPLAY|LOCAL FIRST/i);
    assert.match(page, /快速体验|initDemoSamples/);
    assert.match(page, /rel="stylesheet" href="[^\"]*skin\.css"/);
    assert.doesNotMatch(page, /\/css\/(?:tokens|base|layout|components)\.css|\/js\/skin\.js|pp-js|pp-css|pp-pp-/);
    const resources = [...page.matchAll(/(?:href|src)="([^"$]+)"/g)].map(match => match[1]);
    resources.push(...[...page.matchAll(/(?:from |import\()(['"])([^'"$]+)\1/g)].map(match => match[2]));
    for (const resource of resources) {
      if (/^(?:https?:|data:|blob:|#)/.test(resource)) continue;
      const file = resource.split(/[?#]/)[0];
      assert.ok(existsSync(path.resolve(root, path.dirname(name), file)), `Missing local resource: ${resource}`);
    }
    if (/^(?:wav|flac)\//.test(name) || name.startsWith('site/demo/ref-')) {
      for (const hook of ['stage', 'controls', 'cur', 'url']) assert.match(page, new RegExp(`id="${hook}"`));
      assert.match(page, /Skin\.syncRange\(progress/);
      assert.doesNotMatch(page, /progress\.dispatchEvent/);
    }
  });
}
test('all modules, two references and overview are links in one navigation renderer', () => {
  const nav = readFileSync(path.join(root, 'site/nav.js'), 'utf8');
  assert.match(nav, /const entries = \[\{ title: '总览'/);
  assert.match(nav, /HLS 对照/);
  assert.match(nav, /FLV 对照/);
  assert.match(nav, /\.\.\.items/);
});
test('shared layout: grid areas and responsive panel use one contract', () => {
  const css = readFileSync(path.join(root, 'site/skin.css'), 'utf8');
  assert.match(css, /grid-template-areas: "main aside"/);
  assert.match(css, /\.pp-demo__panel \{ grid-area: panel; \}/);
  assert.match(css, /\.pp-demo--single/);
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /\.pp-stage:fullscreen/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.pp-page--subtitle/);
});
test('compatibility palette: old names do not override authoritative pp aliases', () => {
  const css = readFileSync(path.join(root, 'site/site.css'), 'utf8');
  const definitions = [...css.matchAll(/--dsk-bg:\s*([^;]+);/g)].map(match => match[1]);
  assert.deepEqual(definitions, ['var(--pp-bg)']);
  assert.match(readFileSync(path.join(root, 'site/css/tokens.css'), 'utf8'), /--accent: var\(--pp-accent\)/);
});

test('FLAC demo: loadFlacSmart already loads the player, its metadata result is not WAV bytes', () => {
  const page = readFileSync(path.join(root, 'flac/demo/index.html'), 'utf8');
  assert.match(page, /await loadFlacSmart\(player, bytes\)/);
  assert.doesNotMatch(page, /player\.load\(playable\.wavBytes\)/);
});
