/**
 * hls m3u8 文本变异契约 fuzz（第二百一十一波）
 * ------------------------------------------------------------
 * 真实 playlist fixture 做行级文本变异（敌意标签覆写/插入/删行/字符覆写/
 * 复制巨型行），施加于 parsePlaylist / parseMaster / parseMedia /
 * detectPlaylistType / parseByteRange / parseAttributes 公开面：
 *   - 失败必须抛带 code 的 PlayerError，禁裸 TypeError/RangeError；
 *   - parsePlaylist 成功时 type ∈ {master, media}。
 * 探测阶段 600 轮 × 4 调用面 + utils 敌意串零泄漏（.tmp/fuzz-probe6.mjs），
 * 本文件固化为可回归门禁。固定种子可复现。
 * 同步 readFileSync 装载 fixture——全文件零 top-level await
 * （--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parsePlaylist, parseMaster, parseMedia, detectPlaylistType } from '../src/m3u8-parser.js';
import { parseByteRange, parseAttributes } from '../src/utils.js';

/* seeded xorshift：跨运行确定 */
let seed = 0xd8a17e;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const randInt = (n) => Math.floor(rand() * n);
const pick = (a) => a[randInt(a.length)];

/** 敌意行：溢出数值、未闭合引号、巨型重复、非法日期/带宽 */
const HOSTILE_LINES = [
  '#EXT-X-TARGETDURATION:999999999999999999999',
  '#EXTINF:-999999999999999,',
  '#EXT-X-BYTERANGE:18446744073709551615@18446744073709551615',
  '#EXT-X-PROGRAM-DATE-TIME:not-a-date',
  '#EXT-X-KEY:METHOD=AES-128,URI="',
  '#EXT-X-STREAM-INF:BANDWIDTH=abc,CODECS="' + 'e'.repeat(300) + '"',
  '#EXT-X-MAP:URI="x',
  '#EXT-X-DISCONTINUITY' + 'ÿ'.repeat(50),
  '#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="' + '中'.repeat(200),
  '#' + 'X'.repeat(500),
  '#EXT-X-MAP;' + 'k=v,'.repeat(200),
  Array(2000).fill('#EXTINF:1.0,\nseg.ts\n').join(''),
];

function mutateText(text) {
  let lines = text.split('\n');
  const ops = 1 + randInt(5);
  for (let i = 0; i < ops; i++) {
    if (lines.length === 0) lines = ['#EXTM3U'];
    switch (randInt(5)) {
      case 0: lines[randInt(lines.length)] = pick(HOSTILE_LINES); break;
      case 1: lines.splice(randInt(lines.length + 1), 0, pick(HOSTILE_LINES)); break;
      case 2: lines.splice(randInt(lines.length), 1); break;
      case 3: {
        const li = randInt(lines.length);
        const l = lines[li];
        if (l.length > 0) {
          const at = randInt(l.length);
          lines[li] = l.slice(0, at) + String.fromCharCode(randInt(0x2000)) + l.slice(at + 1);
        }
        break;
      }
      default: {
        const li = randInt(lines.length);
        lines.splice(randInt(lines.length + 1), 0, lines[li] + lines[li]);
      }
    }
  }
  return lines.join('\n');
}

const PLAYLISTS = [
  'master.m3u8', 'media-vod-fmp4.m3u8', 'media-live-ts.m3u8',
  'media-llhls.m3u8', 'media-byterange.m3u8',
].map((f) => readFileSync(new URL(`../__tests__/fixtures/${f}`, import.meta.url), 'utf8'));

test('m3u8 文本变异 fuzz：parse 族失败必带 code，禁裸抛；成功形状合法', () => {
  const offenders = [];
  let ok = 0;
  for (let r = 0; r < 200; r++) {
    const text = mutateText(pick(PLAYLISTS));
    try {
      const p = parsePlaylist(text, 'http://h/p/');
      ok++;
      if (p && p.type !== 'master' && p.type !== 'media') {
        offenders.push(`#${r} parsePlaylist 返回非法 type: ${String(p.type)}`);
      }
    } catch (e) {
      if (!e.code) offenders.push(`#${r} parsePlaylist RAW: ${e.constructor.name}: ${String(e.message).slice(0, 80)}`);
    }
    for (const [name, fn] of [['detectPlaylistType', detectPlaylistType], ['parseMaster', parseMaster], ['parseMedia', parseMedia]]) {
      try { fn(text, 'http://h/p/'); }
      catch (e) {
        if (!e.code) offenders.push(`#${r} ${name} RAW: ${e.constructor.name}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }
  assert.ok(ok > 0, '200 轮全部拒绝说明探测面失效（fixture 装载或变异破坏基线）');
  assert.deepEqual(offenders, []);
});

test('parseByteRange/parseAttributes 敌意串面：失败必带 code 禁裸抛', () => {
  const B = ['', ' ', '@', '@-1', '0@0', '9999999999999999999999@1', 'abc', '12abc@34', '@@', '1@', '@1',
    '18446744073709551616@2'];
  for (const s of B) {
    try { parseByteRange(s, 0); }
    catch (e) { assert.ok(e.code, `parseByteRange(${JSON.stringify(s)}) 裸抛 ${e.constructor.name}: ${e.message}`); }
  }
  const A = ['', 'A=1,B=', '"unbalanced=1', 'k=' + 'v'.repeat(400), ',,,', 'X="a,b",Y=2', '=' + '×'.repeat(50), 'K=V,'.repeat(300)];
  for (const s of A) {
    try { parseAttributes(s); }
    catch (e) { assert.ok(e.code, `parseAttributes(${JSON.stringify(s).slice(0, 30)}) 裸抛 ${e.constructor.name}: ${e.message}`); }
  }
  // 正例锚点：敌意面不得把合法输入也误杀（数值属性解析为 number 属既有契约）
  assert.deepEqual(parseByteRange('100@20', 0), { offset: 20, length: 100 });
  assert.deepEqual(parseAttributes('BANDWIDTH=1,X="a,b"'), { BANDWIDTH: 1, X: 'a,b' });
});
