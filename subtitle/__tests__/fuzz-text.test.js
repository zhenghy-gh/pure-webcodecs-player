/**
 * subtitle 文本变异契约 fuzz（第二百一十二波）
 * ------------------------------------------------------------
 * 真实 srt/vtt/ass fixture 行级文本变异（敌意行覆写/插入/删行/字符覆写/
 * 复制），施加于字符串入参公开面：parseSrt/parseVtt/parseAss/parseAuto/
 * detectFormat/probe/parseCues/parseTimestamp/parseAssColor/tokenizeDialogue。
 * 契约：失败必抛带 code 的受控错误，禁裸 TypeError/RangeError。
 * 探测 700 轮（4700+ 调用）零泄漏后固化（.tmp/fuzz-probe7.mjs）。
 *
 * 观察登记（非缺陷）：数组工具面（shiftCues/sortCues/findActiveCues/
 * cuesDurationUs）对含 null/undefined 元素的数组抛无 code TypeError——
 * 入参为调用方自组结构而非外部不可信数据，JS 参数类型错误惯例即可，
 * 不纳入 §2.4 拒绝面契约。
 *
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseSrt, parseVtt, parseAss, parseAuto, detectFormat,
  parseTimestamp, parseAssColor, tokenizeDialogue,
} from '../src/index.js';
import { probe, parseCues } from '../src/track.js';

/* seeded xorshift：跨运行确定 */
let seed = 0x5ab1e;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const randInt = (n) => Math.floor(rand() * n);
const pick = (a) => a[randInt(a.length)];

/** 敌意行：溢出时间戳、超长字段、未闭合标签、双向控制符、巨型重复 */
const HOSTILE_LINES = [
  '99:99:99,999 --> 99:99:99,999 x',
  'STYLE: ' + 'a'.repeat(400),
  'Dialogue: ' + '1,'.repeat(200) + 'text',
  'Layer: ' + '9'.repeat(30),
  'Event: ' + '，'.repeat(500),
  '00:00:00,000 --> ' + '9'.repeat(40) + ',000',
  'fontname="' + 'x'.repeat(700),
  'OVERFLOW ' + '9'.repeat(300),
  '\r\r\r',
  String.fromCharCode(0x202e) + 'rtl-mix',
  'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\' + 'an999;'.repeat(60) + '}',
  '[' + 'Section'.repeat(500) + ']',
];

function mutate(text) {
  let lines = text.split('\n');
  const ops = 1 + randInt(6);
  for (let i = 0; i < ops; i++) {
    if (lines.length === 0) lines = ['1'];
    switch (randInt(5)) {
      case 0: lines[randInt(lines.length)] = pick(HOSTILE_LINES); break;
      case 1: lines.splice(randInt(lines.length + 1), 0, pick(HOSTILE_LINES)); break;
      case 2: lines.splice(randInt(lines.length), 1); break;
      case 3: {
        const li = randInt(lines.length);
        const l = lines[li];
        if (l.length > 0) {
          const at = randInt(l.length);
          lines[li] = l.slice(0, at) + String.fromCharCode(randInt(0x2100)) + l.slice(at + 1);
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

const SAMPLES = [
  'sample-basic.srt', 'sample-messy.srt', 'sample-basic.vtt',
  'sample-blocks.vtt', 'sample-styled.ass', 'sample-broken.ass',
].map((f) => readFileSync(new URL(`../__tests__/fixtures/${f}`, import.meta.url), 'utf8'));

const FNS = [
  ['parseSrt', parseSrt], ['parseVtt', parseVtt], ['parseAss', parseAss],
  ['parseAuto', parseAuto], ['detectFormat', detectFormat], ['probe', probe],
  ['parseCues', parseCues], ['parseTimestamp', parseTimestamp],
  ['parseAssColor', parseAssColor], ['tokenizeDialogue', tokenizeDialogue],
];

test('subtitle 文本变异 fuzz：全部字符串面禁裸抛，失败必带 code', () => {
  const offenders = [];
  let ok = 0;
  for (let r = 0; r < 250; r++) {
    const text = mutate(pick(SAMPLES));
    for (const [name, fn] of FNS) {
      try { fn(text); ok++; }
      catch (e) {
        if (!(e && e.code)) offenders.push(`#${r} ${name} RAW: ${e.constructor.name}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }
  assert.ok(ok > 0, '250 轮全部拒绝说明探测面失效（fixture 或基线被破坏）');
  assert.deepEqual(offenders, []);
});

test('正例锚点：敌意面不得把完好 fixture 误杀（三格式均产出非空 cues）', () => {
  const srt = parseSrt(SAMPLES[0]);
  const vtt = parseVtt(SAMPLES[2]);
  const ass = parseAss(SAMPLES[4]);
  assert.equal(srt.format, 'srt');
  assert.equal(vtt.format, 'vtt');
  assert.equal(ass.format, 'ass');
  const cues = [...srt.cues, ...vtt.cues, ...ass.cues];
  assert.ok(cues.length > 0, '完好 fixture 三格式 cues 均不应为空');
  for (const cue of cues) {
    assert.ok(Number.isInteger(cue.startUs) && Number.isInteger(cue.endUs), 'cue 时间戳须为整数 µs');
  }
  assert.equal(detectFormat(SAMPLES[0]), 'srt');
  assert.equal(detectFormat(SAMPLES[2]), 'vtt');
});
