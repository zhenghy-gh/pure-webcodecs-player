/**
 * subtitle/__tests__/contract.test.js — CONTRACTS v0.2 §8/§12.3 契约面测试
 * 覆盖：probe / parseCues(bytes,{format,encoding}) / createTextTrack 三件套；
 *       Cue.trackId/raw 冻结字段；GBK 编码；\1c 数字前缀标签词法修复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probe, parseCues, createTextTrack,
  parseAss, SubtitleError,
} from '../src/index.js';
import { readFixBytes } from './helpers.mjs';

test('probe：三种格式命中与未知 null', async () => {
  assert.deepEqual(probe(await readFixBytes('sample-basic.srt')), { format: 'srt' });
  assert.equal(probe(new TextEncoder().encode('随便的文本')), null);
  assert.equal(probe(new Uint8Array(0)), null);
});

test('parseCues：Cue 含 trackId 与 raw（原始条目字节）', async () => {
  const bytes = await readFixBytes('sample-basic.srt');
  const got = [];
  for await (const c of parseCues(bytes)) got.push(c);
  assert.equal(got.length, 3);
  for (const c of got) {
    assert.equal(c.trackId, 1);
    assert.ok(c.raw instanceof Uint8Array, 'raw 必须是 Uint8Array');
  }
  // raw 应包含原始时间行片段
  const rawText = new TextDecoder().decode(got[0].raw);
  assert.match(rawText, /00:00:01,000 --> 00:00:03,000/);
});

test('parseCues：encoding=gbk 解码中文 SRT', async () => {
  // 「中」=0xD6D0，「文」=0xCEC4（GBK 双字节）
  const gbk = new Uint8Array([
    0x31, 0x0d, 0x0a,                                  // "1\r\n"
    0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2c, 0x30, 0x30, 0x30, 0x20, 0x2d, 0x2d, 0x3e, 0x20,
    0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x32, 0x2c, 0x30, 0x30, 0x30, 0x0d, 0x0a,
    0xd6, 0xd0, 0xce, 0xc4,                            // 中文
  ]);
  let n = 0;
  for await (const c of parseCues(gbk, { encoding: 'gbk' })) {
    n++;
    assert.equal(c.text, '中文');
  }
  assert.equal(n, 1);
});

test('parseCues：无法识别格式抛 PROBE_FAILED', async () => {
  await assert.rejects(
    async () => { for await (const c of parseCues(new TextEncoder().encode('gibberish'))) void c; },
    e => e.code === 'PROBE_FAILED',
  );
});

test('createTextTrack：id/type/codec/cues/cuesUntil 全形状', async () => {
  const bytes = await readFixBytes('sample-basic.srt');
  const tr = createTextTrack(parseCues(bytes));
  assert.equal(tr.type, 'text');
  assert.equal(typeof tr.id, 'number');

  let n = 0;
  for await (const c of tr.cues()) n++;
  assert.equal(n, 3);
  assert.equal(tr.codec, 'x-srt');

  // cuesUntil 重放活动窗口：startUs ≤ 3.5s 的两条
  const window = tr.cuesUntil(3_500_000);
  assert.equal(window.length, 2);
  assert.deepEqual(window.map(c => c.startUs), [1_000_000, 3_500_000]);
});

/* ---- \1c/\2c/\3c 数字前缀标签词法修复回归（评审严重1） ---- */
const STYLED_MIN = [
  '[Script Info]',
  'PlayResX: 640',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,sans-serif,48,&H00FFFFFF,&H000000FF,&H00101010,&H7F000000,-1,0,0,0,100,100,0,0,1,2,2,2,20,20,30,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\1c&H0000FF&}红色台词',
].join('\n');

test('\\1c 行内变色生效（数字前缀词法回归）', () => {
  const r = parseAss(STYLED_MIN);
  assert.equal(r.unsupportedTags.includes('1c'), false, '\\1c 不应进入未支持清单');
  const segs = r.cues[0].segments.filter(s => s.type === 'text');
  const colored = segs.find(s => s.style?.primary || s.primaryColor);
  const primary = colored?.style?.primary ?? colored?.primaryColor;
  assert.ok(primary, '应存在主色覆盖');
});
