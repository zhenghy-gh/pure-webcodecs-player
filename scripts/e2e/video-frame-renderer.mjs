#!/usr/bin/env node
/**
 * Real-browser VideoFrameRenderer Canvas2D regression.
 * Requires Chrome and playwright-core; set CHROME_PATH / PLAYWRIGHT_CORE_PATH if needed.
 */
import assert from 'node:assert/strict';
import { arg, launchBrowser, startSite } from './browser-env.mjs';

let site;
let browser;

try {
  site = await startSite(Number(arg('--port', '8127')));
  browser = await launchBrowser();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(site.base + '/wav/demo/index.html', { waitUntil: 'load' });

  const supported = await page.evaluate(() => typeof VideoFrame === 'function');
  assert.ok(supported, 'VideoFrame must be available in the target browser');

  const result = await page.evaluate(async () => {
    const { createVideoRenderer } = await import('/core/src/video-frame-renderer.js');
    const source = document.createElement('canvas');
    source.width = 2;
    source.height = 2;
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = 'rgb(255, 0, 0)';
    sourceContext.fillRect(0, 0, source.width, source.height);

    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 2;
    const renderer = createVideoRenderer(canvas, { preference: '2d', fit: 'contain' });
    const frame = new VideoFrame(source, { timestamp: 0 });
    const drawn = renderer.draw(frame);
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const pixel = (x, y) => Array.from(pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4));

    let frameClosed = false;
    try {
      frame.allocationSize();
    } catch (error) {
      frameClosed = error.name === 'InvalidStateError';
    }

    const output = {
      drawn,
      mode: renderer.mode,
      left: pixel(0, 0),
      center: pixel(1, 0),
      right: pixel(3, 0),
      frameClosed,
    };
    renderer.destroy();
    return output;
  });

  assert.equal(result.drawn, true, 'renderer must draw the VideoFrame');
  assert.equal(result.mode, '2d', 'explicit preference must select Canvas2D');
  assert.deepEqual(result.left, [0, 0, 0, 255], 'contain letterbox must clear the left bar to opaque black');
  assert.deepEqual(result.center, [255, 0, 0, 255], 'center pixel must contain the source frame');
  assert.deepEqual(result.right, [0, 0, 0, 255], 'contain letterbox must clear the right bar to opaque black');
  assert.equal(result.frameClosed, true, 'draw must transfer ownership and close VideoFrame');
  assert.deepEqual(pageErrors, [], 'browser page must not raise runtime errors');

  console.log('PASS real VideoFrame Canvas2D render: contain pixels verified and frame closed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  site?.close();
}
