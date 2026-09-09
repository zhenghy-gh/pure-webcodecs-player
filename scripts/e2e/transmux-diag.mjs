#!/usr/bin/env node
/**
 * HLS TS→fMP4 transmux 真机拒收根因二分（落盘 + fetch 版）。
 * 用 bbb480_30s.ts（TS demux → annexb→avcc）生成 4 种 media 段变体，落盘后由
 * 真实 Chrome fetch().arrayBuffer() 逐段 appendBuffer（复用 M44 真机验证路径），
 * 捕获每段精确错误，定位到底是
 *   (1) styp 头（CMA-style，hls 有 / mp4 remuxer 无）
 *   (2) 整段单 moof（不切 GOP）
 * 哪个导致 Chrome 151+ MSE 拒收。
 *
 * 变体：
 *   A  styp + 整段单 moof（hls 现状）
 *   B  styp + 按 GOP 切批（batchSamplesByGop）
 *   C  整段单 moof 去 styp
 *   D  按 GOP 切批 去 styp（对齐 mp4 Fmp4Remuxer 形态）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TsDemuxer } from '../../ts/src/index.js';
import { annexbToAvcc } from '../../core/src/nal.js';
import { batchSamplesByGop, Fmp4Remuxer } from '../../mp4/src/remuxer.js';
import { _internalForTest, TsToFmp4Transmuxer } from '../../hls/src/fmp4-muxer.js';
import { buildAvcCodecString } from '../../core/src/codec-string.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;
const TS = 90000;
const toTicks = (us) => Math.round((us ?? 0) * TS / 1e6);

// 1) demux ts → 视频样本（avcc 形态，ticks 域）
const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'samples/e2e/bbb480_30s.ts')));
const sink = { write() {}, end() {} };
const demuxer = new TsDemuxer(sink);
const opened = demuxer.open();
sink.write(bytes);
sink.end();
await opened;

let vTrack = null;
const vSamples = [];
for (const t of demuxer.tracks || []) {
  if (t.type !== 'video') continue;
  vTrack = t;
  for (;;) {
    const s = await demuxer.readSample(t.id);
    if (!s) break;
    vSamples.push(s);
  }
}
if (!vTrack) throw new Error('no video track');

const samples = vSamples.map((s) => ({
  dts: toTicks(s.dts ?? s.timestamp),
  pts: toTicks(s.pts ?? s.timestamp),
  duration: toTicks(s.duration || 30000),
  keyframe: !!s.keyframe,
  data: annexbToAvcc(s.data),
}));
console.log(`demux: ${samples.length} video samples, keyframes=${samples.filter((s) => s.keyframe).length}`);

const codecStr = buildAvcCodecString(vTrack.description);
const mime = `video/mp4; codecs="${codecStr}"`;
const track = { id: 1, type: 'video', codec: codecStr, description: { tag: 'avcC', bytes: vTrack.description }, width: vTrack.width, height: vTrack.height, timescale: TS };
const init = _internalForTest.buildInit([track]);

// mp4 验证过的 init（M44 真机通过）：作为对照，隔离「init 是否根因」
const mp4Init = new Fmp4Remuxer().createInitSegment({ ...track, sampleEntryType: 'avc1', description: vTrack.description });

function trimStyp(seg) {
  const size = (seg[0] << 24) | (seg[1] << 16) | (seg[2] << 8) | seg[3];
  const type = String.fromCharCode(seg[4], seg[5], seg[6], seg[7]);
  return type === 'styp' ? seg.slice(size) : seg;
}

const whole = [_internalForTest.buildFragment({ trackId: 1, timescale: TS, samples, seq: 1 })];
const batches = batchSamplesByGop(samples, { targetDurationUs: 2_000_000 * TS / 1e6 });
const gop = batches.map((b, i) => _internalForTest.buildFragment({ trackId: 1, timescale: TS, samples: b, seq: i + 1 }));

// 真实 remux 路径（含 annexb→avcc）：整段 ts 作为单分片
const rt = new TsToFmp4Transmuxer();
const out = await rt.remux(bytes);
const remuxInit = out.video?.initSegment ?? null;
const remuxMedia = out.video?.mediaSegment ?? null;
console.log(`remux real-path: hasInit=${!!remuxInit} hasMedia=${!!remuxMedia} codecs=${JSON.stringify(out.codecs)}`);

const variants = {
  A: { init, medias: whole.map((s) => s) },
  B: { init, medias: gop.map((s) => s) },
  C: { init, medias: whole.map(trimStyp) },
  D: { init, medias: gop.map(trimStyp) },
  G: { init: mp4Init, medias: gop.map(trimStyp) },
  H: { init: mp4Init, medias: whole },
  I: { init: remuxInit, medias: remuxMedia ? [remuxMedia] : [] },
};
const TAG = { A: 'styp+whole', B: 'styp+GOP', C: 'whole-noStyp', D: 'GOP-noStyp', G: 'mp4init+GOP-noStyp', H: 'mp4init+whole', I: 'remux-realpath' };
console.log(`variants: whole=${whole.length}seg, GOP=${gop.length}segs, mime=${mime}`);

// 2) 落盘
const OUT = path.join(ROOT, 'samples/e2e/transmux-diag');
fs.mkdirSync(OUT, { recursive: true });
for (const [name, v] of Object.entries(variants)) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'init.mp4'), v.init);
  v.medias.forEach((m, i) => fs.writeFileSync(path.join(dir, `seg-${String(i).padStart(3, '0')}.m4s`), m));
}
console.log(`written variants to ${OUT}`);

// 3) serve + chrome
function startServer() {
  const server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return server;
}
const server = startServer();
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/core/demo/index.html`, { method: 'HEAD' }); if (r.ok) break; } catch {}
  await sleep(250);
}

async function runVariant(browser, name, count) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const l = document.createElement('link'); l.rel = 'icon'; l.href = 'data:,'; document.head?.appendChild(l);
  });
  const res = await page.evaluate(async ({ base, mime, count }) => {
    const out = { initOk: false, initErr: '', medias: [], msErr: '' };
    const fetchBuf = async (p) => new Uint8Array(await (await fetch(base + '/' + p)).arrayBuffer());
    const ms = new MediaSource();
    const video = document.createElement('video'); video.muted = true;
    video.src = URL.createObjectURL(ms);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sourceopen timeout')), 8000);
      ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
      ms.addEventListener('error', () => { clearTimeout(t); reject(new Error('ms error')); }, { once: true });
    });
    let sb;
    try { sb = ms.addSourceBuffer(mime); } catch (e) { out.initErr = 'addSourceBuffer:' + e.message; return out; }
    const append = (buf) => new Promise((resolve, reject) => {
      const onErr = () => { sb.removeEventListener('error', onErr); const e = sb.error; reject(new Error('append:' + (e ? `${e.code}/${e.message}` : 'unknown'))); };
      const onEnd = () => { sb.removeEventListener('updateend', onEnd); sb.removeEventListener('error', onErr); resolve(); };
      sb.addEventListener('updateend', onEnd, { once: true });
      sb.addEventListener('error', onErr, { once: true });
      try { sb.appendBuffer(buf); } catch (e) { sb.removeEventListener('updateend', onEnd); sb.removeEventListener('error', onErr); reject(e); }
    });
    try { await append(await fetchBuf('init.mp4')); out.initOk = true; } catch (e) { out.initErr = e.message; return out; }
    for (let i = 0; i < count; i++) {
      try { await append(await fetchBuf(`seg-${String(i).padStart(3, '0')}.m4s`)); out.medias.push('ok'); }
      catch (e) { out.medias.push('ERR@' + i + ':' + e.message); break; }
    }
    return out;
  }, { base: `${BASE}/samples/e2e/transmux-diag/${name}`, mime, count });
  await page.close();
  return res;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.argv.includes('--headful') });
for (const [name, v] of Object.entries(variants)) {
  const r = await runVariant(browser, name, v.medias.length);
  const okCount = r.medias.filter((m) => m === 'ok').length;
  console.log(`\n[${name}/${TAG[name]}] initOk=${r.initOk}${r.initErr ? ' initErr=' + r.initErr : ''} mediaOk=${okCount}/${v.medias.length}`);
  if (r.medias.some((m) => m.startsWith('ERR'))) console.log('   fail:', r.medias.filter((m) => m.startsWith('ERR')).join(' | '));
}
await browser.close();
server.kill();
console.log(`(临时变体保留于 ${OUT}，未自动清理)`);
