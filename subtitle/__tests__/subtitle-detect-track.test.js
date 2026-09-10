/**
 * subtitle/__tests__/subtitle-detect-track.test.js — 格式嗅探 + 字节级 track 接口边界
 *
 * 覆盖 detect.js / track.js 在 src 现有测试中薄弱的边界：
 *   - detectFormat：无签名 VTT、无小时位 SRT、带尾注/版本 WEBVTT、各类 ASS 节头、BOM
 *   - probe：BOM 字节、空字节
 *   - parseCues：显式 format 选项、未知 format 抛 PROBE_FAILED
 *   - createTextTrack：ASS 字节流 codec 推断、cuesUntil 边界（含起点 inclusive）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, probeSubtitleCodec, probe, parseCues, createTextTrack,
  SubtitleError,
} from '../src/index.js';
import { readFixBytes } from './helpers.mjs';

/* ---------------- detectFormat 边界 ---------------- */

test('detectFormat：无签名 VTT（标识符行 + 点毫秒时间行）', () => {
  const src = 'cue-1\n00:01.000 --> 00:02.000\n台词\n';
  assert.equal(detectFormat(src), 'vtt');
});

test('detectFormat：无小时位 SRT（逗号毫秒）', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n台词\n';
  assert.equal(detectFormat(src), 'srt');
});

test('detectFormat：WEBVTT 带尾注/版本号', () => {
  assert.equal(detectFormat('WEBVTT - 这是字幕文件\n\n00:01.000 --> 00:02.000\nx'), 'vtt');
  assert.equal(detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nx'), 'vtt');
});

test('detectFormat：各类 ASS 节头识别', () => {
  assert.equal(detectFormat('[Script Info]\nTitle: t'), 'ass');
  assert.equal(detectFormat('[V4+ Styles]\nFormat: ...'), 'ass');
  assert.equal(detectFormat('[V4 Styles]\nFormat: ...'), 'ass');
  assert.equal(detectFormat('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x'), 'ass');
});

test('detectFormat：BOM 前缀 VTT 仍识别', () => {
  assert.equal(detectFormat('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nx'), 'vtt');
});

test('detectFormat：空/非字幕文本返回 null', () => {
  assert.equal(detectFormat(''), null);
  assert.equal(detectFormat('   \n'), null);
  assert.equal(detectFormat('随便的文本内容'), null);
});

test('probeSubtitleCodec：内联样例映射与未知 null', () => {
  assert.equal(probeSubtitleCodec('1\n00:00:01,000 --> 00:00:02,000\nx'), 'x-srt');
  assert.equal(probeSubtitleCodec('cue\n00:01.000 --> 00:02.000\nx'), 'x-vtt');
  assert.equal(probeSubtitleCodec('???'), null);
});

/* ---------------- probe（字节级） ---------------- */

test('probe：BOM VTT 字节命中 vtt', () => {
  const bytes = new TextEncoder().encode('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nx');
  assert.deepEqual(probe(bytes), { format: 'vtt' });
});

test('probe：空字节与随机字节返回 null', () => {
  assert.equal(probe(new Uint8Array(0)), null);
  assert.equal(probe(new TextEncoder().encode('随便的文本')), null);
});

test('probe：SRT 字节命中 srt', async () => {
  const bytes = await readFixBytes('sample-basic.srt');
  assert.deepEqual(probe(bytes), { format: 'srt' });
});

/* ---------------- parseCues ---------------- */

test('parseCues：显式 format 选项生效，产出 trackId/raw', async () => {
  const bytes = await readFixBytes('sample-basic.srt');
  const got = [];
  for await (const c of parseCues(bytes, { format: 'srt' })) got.push(c);
  assert.equal(got.length, 3);
  assert.equal(got[0].trackId, 1);
  assert.ok(got[0].raw instanceof Uint8Array);
});

test('parseCues：未知 format 抛 PROBE_FAILED', async () => {
  await assert.rejects(
    async () => { for await (const c of parseCues(await readFixBytes('sample-basic.srt'), { format: 'xyz' })) void c; },
    (e) => e instanceof SubtitleError && e.code === 'PROBE_FAILED',
  );
});

/* ---------------- createTextTrack ---------------- */

test('createTextTrack：ASS 字节流推断 codec 为 x-ass（修复 raw 双编码后）', async () => {
  const tr = createTextTrack(parseCues(await readFixBytes('sample-styled.ass')));
  assert.equal(tr.type, 'text');
  assert.equal(typeof tr.id, 'number');
  let n = 0;
  for await (const c of tr.cues()) n++;
  assert.equal(n, 5, 'styled.ass 应含 5 条 Dialogue');
  // 修复前：raw 被二次编码为逗号串，detectFormat 认不出 ASS，codec 退回 x-srt
  assert.equal(tr.codec, 'x-ass');
});

test('createTextTrack：SRT 字节流 codec 推断为 x-srt', async () => {
  const tr = createTextTrack(parseCues(await readFixBytes('sample-basic.srt')));
  assert.equal(tr.codec, 'x-srt');
});

test('createTextTrack：cuesUntil 起点 inclusive、起点前 exclusive', async () => {
  const tr = createTextTrack(parseCues(await readFixBytes('sample-basic.srt')));
  // 必须先消费 cues() 触发缓存（cachedAndPump），否则 cache 为空
  let n = 0;
  for await (const c of tr.cues()) n++;
  assert.equal(n, 3);
  // sample-basic.srt 首条 startUs=1_000_000
  const atStart = tr.cuesUntil(1_000_000);
  assert.ok(atStart.length >= 1, 't==startUs 应含首条');
  const before = tr.cuesUntil(999_999);
  assert.equal(before.length, 0, 't 早于所有 startUs 应为空');
  const mid = tr.cuesUntil(3_500_000);
  assert.equal(mid.length, 2);
});
