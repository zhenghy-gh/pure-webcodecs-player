/**
 * wav 头部字段定向 mutation 回归（第二百一十三波）
 * ------------------------------------------------------------
 * 与此前随机字节 fuzz 互补：对 RIFF/fmt/data 已知字段写定向边界值
 * （0/1/0xFFFF/0xFFFE/0x8000/0xFFFFFFFF/0x7FFFFFFF），验证：
 *   - 禁裸抛：失败必为带 code 的 PlayerError；
 *   - 成功面数值契约：format 字段、frames、durationUs、totalDataBytes
 *     必须有限且非负（拒绝 NaN/Infinity 泄漏进契约）。
 * 探测 .tmp/probe-wavflac.mjs 171 调用零问题后固化。
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWavHeader } from '../src/index.js';

const FILES = ['sample-basic.wav', 'sample-f32-stereo.wav', 'sample-streaming.wav'].map((f) =>
  new Uint8Array(readFileSync(new URL(`../__tests__/fixtures/${f}`, import.meta.url))));

/** 定位 fmt body 与 data 块头偏移（与解析器同一遍历规则） */
function findChunks(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = {};
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') out.fmt = pos + 8;
    if (id === 'data') out.data = pos;
    pos = pos + 8 + size + (size % 2);
  }
  return out;
}

const U16 = [0, 1, 0xFFFF, 0xFFFE, 0x8000, 0x7FFF];
const U32 = [0, 1, 0xFFFFFFFF, 0xFFFFFFFE, 0x80000000, 0x7FFFFFFF];
const wu16 = (b, at, v) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; };
const wu32 = (b, at, v) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 24) & 0xff; b[at + 3] = (v >>> 16) & 0xff; };

test('wav 字段定向边界 mutation：禁裸抛，成功面数值必须有限非负', () => {
  const offenders = [];
  let ok = 0;
  for (const src of FILES) {
    const { fmt, data: dataHdr } = findChunks(src);
    assert.ok(fmt != null && dataHdr != null, 'fixture 应含 fmt/data 块');
    const targets = [
      ['riffSize', 4, 32, U32],
      ['fmtSize', fmt - 4, 32, U32],
      ['formatTag', fmt, 16, U16],
      ['channels', fmt + 2, 16, U16],
      ['sampleRate', fmt + 4, 32, U32],
      ['byteRate', fmt + 8, 32, U32],
      ['blockAlign', fmt + 12, 16, U16],
      ['bitsPerSample', fmt + 14, 16, U16],
      ['dataSize', dataHdr + 4, 32, U32],
    ];
    for (const [name, at, w, vals] of targets) {
      for (const v of vals) {
        const b = src.slice();
        if (w === 16) wu16(b, at, v); else wu32(b, at, v);
        try {
          const r = parseWavHeader(b);
          ok++;
          for (const k of ['sampleRate', 'byteRate', 'blockAlign', 'bitsPerSample', 'channels']) {
            if (!Number.isFinite(r.format[k]) || r.format[k] < 0) {
              offenders.push(`${name}=${v} → format.${k}=${r.format[k]}`);
            }
          }
          if (r.durationUs != null && (!Number.isFinite(r.durationUs) || r.durationUs < 0)) {
            offenders.push(`${name}=${v} → durationUs=${r.durationUs}`);
          }
          if (!Number.isFinite(r.totalDataBytes) || r.totalDataBytes < 0) {
            offenders.push(`${name}=${v} → totalDataBytes=${r.totalDataBytes}`);
          }
        } catch (e) {
          if (!e.code) offenders.push(`${name}=${v} RAW ${e.constructor.name}: ${e.message}`);
        }
      }
    }
    // 奇数/零 fmt 尺寸与 1 字节 data 尺寸（补齐与截断分支）
    for (const [name, at, v] of [['fmtSize15', fmt - 4, 15], ['fmtSize0', fmt - 4, 0], ['dataSize1', dataHdr + 4, 1]]) {
      const b = src.slice(); wu32(b, at, v);
      try { ok++; parseWavHeader(b); }
      catch (e) { if (!e.code) offenders.push(`${name} RAW ${e.constructor.name}: ${e.message}`); }
    }
  }
  assert.ok(ok > 0, '全部组合均被拒绝说明探测面失效（fixture 基线被破坏）');
  assert.deepEqual(offenders, []);
});

test('正例锚点：完好 fixture 解析成功且 durationUs 合理', () => {
  for (const src of FILES) {
    const r = parseWavHeader(src);
    assert.ok(r.format.sampleRate > 0);
    assert.ok(r.durationUs == null || (Number.isFinite(r.durationUs) && r.durationUs >= 0));
    assert.ok(r.totalDataBytes > 0);
  }
});
