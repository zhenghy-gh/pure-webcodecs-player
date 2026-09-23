/**
 * 跨模块畸形输入契约 fuzz（第二百零六波）
 * ------------------------------------------------------------
 * seeded PRNG 对真实 fixture 做截断/字节覆写变异，喂给各容器模块：
 *   1. probe 契约（§CONTRACTS）：同步、禁止抛异常——命中与否均合法；
 *   2. createDemuxer/open 拒绝面：失败必须是带 code 的 PlayerError，
 *      禁裸 TypeError/RangeError（第199波证明未覆盖行会潜伏真缺陷，
 *      本测试将「畸形输入不裸抛」固化为可回归的门禁）；
 *   3. 不悬挂：open 路径 3s 内必须 settle。
 * 固定种子保证可复现；单测预算 <5s，故轮次从简（探测阶段已跑 3000 轮零泄漏）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDataSource } from '../src/index.js';
import { buildProgressiveVideoFixture, buildFragmentedFixture } from '../../mp4/__tests__/fixtures.js';
import { makeMinimalWebm } from '../../mkv/__tests__/fixtures/make-fixture.mjs';
import { readFix } from '../../flac/__tests__/helpers.mjs';

/* seeded xorshift：跨运行确定 */
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const randInt = (n) => Math.floor(rand() * n);

function mutate(bytes) {
  if (randInt(3) === 0) return bytes.subarray(0, randInt(bytes.length + 1)); // 截断
  const out = Uint8Array.from(bytes); // 注意：不用 slice 视图，避免污染原 fixture
  const n = 1 + randInt(4);
  for (let i = 0; i < n; i++) out[randInt(out.length)] = randInt(256);
  return out;
}

const MODULE_NAMES = ['mp4', 'mkv', 'mov', 'ts', 'flv', 'ape', 'wav', 'flac'];
const mods = {};
for (const m of MODULE_NAMES) {
  mods[m] = await import(`../../${m}/src/index.js`);
}

const fixtures = [
  { name: 'mp4-prog', bytes: buildProgressiveVideoFixture().bytes },
  { name: 'mp4-frag', bytes: buildFragmentedFixture().bytes },
  { name: 'mkv-webm', bytes: makeMinimalWebm().bytes },
  { name: 'flac', bytes: await readFix('sample-basic.flac') },
];

const ROUNDS_PER_PAIR = 30;

test('probe 契约 fuzz：变异输入禁止抛异常（命中/未命中均合法）', () => {
  const offenders = [];
  for (const fix of fixtures) {
    for (const [name, mod] of Object.entries(mods)) {
      if (typeof mod.probe !== 'function') continue;
      for (let r = 0; r < ROUNDS_PER_PAIR; r++) {
        try {
          mod.probe(mutate(fix.bytes));
        } catch (e) {
          offenders.push(`${name}.probe(${fix.name}#${r}): ${e.constructor.name} ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('createDemuxer/open 拒绝面 fuzz：失败必带契约 code 且限时 settle', async () => {
  const offenders = [];
  for (const fix of fixtures) {
    for (const [name, mod] of Object.entries(mods)) {
      if (typeof mod.createDemuxer !== 'function') continue;
      for (let r = 0; r < 10; r++) {
        const bytes = mutate(fix.bytes);
        let verdict;
        try {
          const d = await Promise.race([
            mod.createDemuxer(new MemoryDataSource(bytes)),
            new Promise((_, rej) => {
              const t = setTimeout(() => rej(new Error('__hang__')), 3000);
              if (typeof t?.unref === 'function') t.unref();
            }),
          ]);
          await d.destroy?.();
          verdict = null; // 成功亦合法（变异未破坏关键结构）
        } catch (e) {
          verdict = e;
        }
        if (verdict && (verdict.message === '__hang__' || !verdict.code)) {
          offenders.push(
            `${name}.createDemuxer(${fix.name}#${r}): ` +
            (verdict.message === '__hang__' ? 'HANG' : `${verdict.constructor.name}(${verdict.message})`),
          );
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
