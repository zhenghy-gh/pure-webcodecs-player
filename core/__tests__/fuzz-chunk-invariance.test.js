/**
 * 流式分块不变性 fuzz（第二百零八波）
 * ------------------------------------------------------------
 * 完好流「整体一次喂入」与「随机小块切片喂入」的事件流必须逐一一致：
 * 这是流式解析器（网络分片、MTU 边界、188B TS 包跨块）的核心不变量。
 * 断言面：事件名序列 + 深规范化后的载荷（TypedArray 折叠为 长度+校验和）。
 * 档位含 maxChunk=1（逐字节）与协议结构尺寸（188/376 跨越 TS 包边界）。
 * 探测阶段 6 档 × 3 fixture（flv）+ 5 档 × 3 fixture（ts）零漂移
 * （.tmp/fuzz-probe4.mjs），本文件固化为可回归门禁。
 *
 * 注意：本文件禁止 top-level await 注册用例（--test-force-exit 静默丢例，
 * 第二百零七波教训），异步装载收敛进懒加载 ready promise。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FlvParser } from '../../flv/src/index.js';
import { TsStreamEngine } from '../../ts/src/index.js';

/* seeded xorshift：跨运行确定 */
let seed = 0x5eed1234;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

/** 深规范化：TypedArray → {__bytes:len,sum}，Error → name+message（message 非枚举），对象按 key 排序 */
function norm(v) {
  if (v instanceof Uint8Array) return { __bytes: v.length, sum: v.reduce((a, b) => (a + b) | 0, 0) };
  if (v instanceof Error) return { __err: v.name, msg: v.message };
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

const FLV_EVENTS = ['header', 'audio', 'video', 'metadata', 'complete', 'error'];
const TS_EVENTS = ['tracks', 'pcr', 'sample', 'metadata', 'warn', 'error', 'complete'];

function collect(Ctor, events) {
  const p = new Ctor();
  const log = [];
  for (const name of events) p.on(name, (d) => log.push([name, norm(d)]));
  return { p, log };
}

/** 随机切块：每块 1..maxChunk 字节；每次调用前重置种子保证跨用例确定 */
function split(bytes, maxChunk, resetSeed) {
  if (resetSeed) seed = 0x5eed1234;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const n = 1 + Math.floor(rand() * maxChunk);
    out.push(bytes.subarray(i, Math.min(i + n, bytes.length)));
    i += n;
  }
  return out;
}

/** 核心断言：分块喂入的事件流与整体喂入逐一 JSON 相等 */
function assertInvariance(label, Ctor, events, bytes, maxChunk) {
  const whole = collect(Ctor, events);
  whole.p.push(bytes);
  whole.p.flush();
  const chunked = collect(Ctor, events);
  for (const c of split(bytes, maxChunk, true)) chunked.p.push(c);
  chunked.p.flush();
  assert.ok(whole.log.length > 0, `${label}: 整体喂入零事件，探测本身失效`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(chunked.log)),
    JSON.parse(JSON.stringify(whole.log)),
    `${label} maxChunk=${maxChunk} 分块产出与整体不一致`,
  );
}

/** 懒装载二进制 fixture，各用例内 await（禁止 top-level await） */
const ready = (async () => {
  const fix = async (dir, name) =>
    new Uint8Array(await readFile(new URL(`../../${dir}/__tests__/fixtures/${name}`, import.meta.url)));
  return {
    flv: [
      ['basic.flv', await fix('flv', 'basic.flv')],
      ['av.flv', await fix('flv', 'av.flv')],
      ['tiny.flv', await fix('flv', 'tiny.flv')],
    ],
    ts: [
      ['basic.ts', await fix('ts', 'basic.ts')],
      ['av.ts', await fix('ts', 'av.ts')],
      ['padded.ts', await fix('ts', 'padded.ts')],
    ],
  };
})();

test('FlvParser 分块不变性：3 fixture × 6 档随机切块（含逐字节）事件流一致', async () => {
  const { flv } = await ready;
  for (const [name, bytes] of flv) {
    for (const maxChunk of [1, 2, 3, 7, 13, 64]) {
      assertInvariance(`flv:${name}`, FlvParser, FLV_EVENTS, bytes, maxChunk);
    }
  }
});

test('TsStreamEngine 分块不变性：3 fixture × 5 档随机切块（含 188B 包边界）事件流一致', async () => {
  const { ts } = await ready;
  for (const [name, bytes] of ts) {
    for (const maxChunk of [1, 5, 17, 188, 376]) {
      assertInvariance(`ts:${name}`, TsStreamEngine, TS_EVENTS, bytes, maxChunk);
    }
  }
});
