#!/usr/bin/env node
/**
 * Real-browser WAV source replacement regression.
 * Requires Chrome and playwright-core; set CHROME_PATH / PLAYWRIGHT_CORE_PATH if needed.
 */
import assert from 'node:assert/strict';
import { arg, launchBrowser, startSite } from './browser-env.mjs';

let site;
let browser;

try {
  site = await startSite(Number(arg('--port', '8124')));
  browser = await launchBrowser();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(site.base + '/wav/demo/index.html', { waitUntil: 'load' });

  const supported = await page.evaluate(() => typeof AudioContext === 'function' && typeof AudioWorkletNode === 'function');
  assert.ok(supported, 'AudioContext and AudioWorkletNode must be available');

  await page.evaluate(async () => {
    const { WavPlayer } = await import('/wav/src/player.js');
    window.__wavAudit = { writes: [], sent: [], received: [], processorErrors: [] };
    const NativeWorkletNode = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(NativeWorkletNode, {
      construct(target, args) {
        const node = Reflect.construct(target, args);
        node.addEventListener('processorerror', () => window.__wavAudit.processorErrors.push('processorerror'));
        const port = node.port;
        const postMessage = port.postMessage.bind(port);
        port.postMessage = (message, transfer) => {
          if (message.type === 'write') window.__wavAudit.writes.push(message.planar[0].length);
          else window.__wavAudit.sent.push({ type: message.type, value: message.value, baseFrame: message.baseFrame });
          return postMessage(message, transfer);
        };
        port.addEventListener('message', event => window.__wavAudit.received.push(event.data));
        port.start();
        return node;
      },
    });

    const nativeConnect = AudioNode.prototype.connect;
    let analyser;
    AudioNode.prototype.connect = function connectWithAnalyser(destination, ...args) {
      const result = nativeConnect.call(this, destination, ...args);
      if (!analyser && this instanceof GainNode && destination === this.context.destination) {
        analyser = this.context.createAnalyser();
        analyser.fftSize = 512;
        nativeConnect.call(this, analyser);
        nativeConnect.call(analyser, destination);
      }
      return result;
    };

    const makeWav = sample => {
      const frames = 48000 * 4;
      const bytes = new Uint8Array(44 + frames * 2);
      const view = new DataView(bytes.buffer);
      const writeId = (offset, value) => {
        for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
      };
      writeId(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      writeId(8, 'WAVE');
      writeId(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 48000, true);
      view.setUint32(28, 96000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeId(36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, sample, true);
      return bytes;
    };

    window.__wavMake = makeWav;
    window.__wavPlayer = new WavPlayer();
    window.__wavPlayer.load(makeWav(12000));
    window.__wavProbe = () => {
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      let sum = 0;
      let peak = 0;
      for (const value of values) {
        sum += value;
        peak = Math.max(peak, Math.abs(value));
      }
      return { mean: sum / values.length, peak, sampleRate: analyser.context.sampleRate };
    };
    await window.__wavPlayer.play();
  });

  await page.waitForFunction(() => window.__wavProbe().mean > 0.2, null, { timeout: 5000, polling: 'raf' });
  await page.waitForFunction(() => window.__wavPlayer.currentTime() > 0.05, null, { timeout: 5000, polling: 'raf' });

  const beforePause = await page.evaluate(() => {
    const writtenFrames = window.__wavAudit.writes.reduce((sum, frames) => sum + frames, 0);
    const consumedFrames = Math.round(window.__wavPlayer.currentTime() * window.__wavPlayer.sampleRate);
    return { writtenFrames, consumedFrames, queuedFrames: writtenFrames - consumedFrames };
  });
  assert.ok(beforePause.writtenFrames >= 8192 + 4096, 'prefill and first push must be written before pause');
  assert.ok(beforePause.queuedFrames > 4096, 'old positive samples must remain queued at pause');

  await page.evaluate(() => window.__wavPlayer.pause());
  await page.waitForFunction(() => window.__wavProbe().peak < 0.01, null, { timeout: 2000, polling: 'raf' });
  const paused = await page.evaluate(() => ({
    state: window.__wavPlayer.state,
    writtenFrames: window.__wavAudit.writes.reduce((sum, frames) => sum + frames, 0),
    consumedFrames: Math.round(window.__wavPlayer.currentTime() * window.__wavPlayer.sampleRate),
  }));
  assert.equal(paused.state, 'paused');
  assert.ok(paused.writtenFrames - paused.consumedFrames > 4096, 'pause must preserve queued old samples');

  await page.evaluate(async () => {
    window.__wavHistory = [];
    window.__wavSampling = true;
    window.__wavSwitchStarted = performance.now();
    const record = () => {
      if (!window.__wavSampling) return;
      const probe = window.__wavProbe();
      window.__wavHistory.push({ mean: probe.mean, peak: probe.peak, elapsedMs: performance.now() - window.__wavSwitchStarted });
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    window.__wavPlayer.load(window.__wavMake(-12000));
    await window.__wavPlayer.play();
  });

  await page.waitForFunction(() => window.__wavProbe().mean < -0.2, null, { timeout: 2000, polling: 'raf' });
  const replacement = await page.evaluate(() => {
    window.__wavSampling = false;
    return {
      probe: window.__wavProbe(),
      history: window.__wavHistory,
      sent: window.__wavAudit.sent,
      received: window.__wavAudit.received,
      processorErrors: window.__wavAudit.processorErrors,
    };
  });
  const positiveWindows = replacement.history.filter(sample => sample.mean > 0.05 && sample.peak > 0.05);
  assert.equal(positiveWindows.length, 0, 'replacement output must not replay queued positive samples');
  assert.ok(replacement.history.some(sample => sample.mean < -0.2), 'history must include the negative replacement source');
  assert.ok(replacement.sent.some(message => message.type === 'flush'), 'load must flush the worklet queue');
  assert.ok(replacement.received.some(message => message.type === 'progress' && message.frame > 0), 'worklet must report consumed frames');
  assert.deepEqual(replacement.processorErrors, [], 'AudioWorklet must not raise processorerror');
  assert.deepEqual(pageErrors, [], 'browser page must not raise runtime errors');

  const firstNegative = replacement.history.find(sample => sample.mean < -0.2);
  console.log(
    'PASS real AudioWorklet replacement: ' +
    'queued old frames=' + beforePause.queuedFrames + ', first negative=' + firstNegative.elapsedMs.toFixed(1) +
    'ms, output mean=' + replacement.probe.mean.toFixed(3) + ' @ ' + replacement.probe.sampleRate + 'Hz',
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  site?.close();
}
