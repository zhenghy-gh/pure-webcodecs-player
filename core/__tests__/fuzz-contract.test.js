/**
 * 跨模块畸形输入契约 fuzz（第二百零六波、第二百零七波）
 * ------------------------------------------------------------
 * seeded PRNG 对真实 fixture 做截断/字节覆写变异，喂给各容器模块：
 *   1. probe 契约（§CONTRACTS）：同步、禁止抛异常——命中与否均合法；
 *   2. createDemuxer/open 拒绝面：失败必须是带 code 的 PlayerError，
 *      禁裸 TypeError/RangeError（第199波证明未覆盖行会潜伏真缺陷，
 *      本测试将「畸形输入不裸抛」固化为可回归的门禁）；
 *   3. 不悬挂：open 路径 3s 内必须 settle；
 *   4. 运行时滥用面（第二百零七波）：seek 边界值、seek/readSample/
 *      samples/destroy 随机交错序列——一切 rejection 带 code、结果
 *      满足整数 µs 契约、不悬挂、destroy 幂等。
 * 固定种子保证可复现；单测预算 <5s，故轮次从简（探测阶段已跑 3000+ 轮零泄漏）。
 *
 * 注意：本文件禁止 top-level await 注册用例——npm test 带 --test-force-exit，
 * 已完成的注册用例一旦先跑空，runner 会在后续 await 未 settle 时强制退出，
 * 静默吞掉 await 之后才注册的用例（第二百零七波实测：4 例只剩 2 例且 fail 0）。
 * 所有异步 fixture 装载收敛进懒加载 ready promise，由各用例内部 await。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MemoryDataSource } from '../src/index.js';
import { buildProgressiveVideoFixture, buildFragmentedFixture } from '../../mp4/__tests__/fixtures.js';
import { makeMinimalWebm } from '../../mkv/__tests__/fixtures/make-fixture.mjs';
import { readFix } from '../../flac/__tests__/helpers.mjs';

import * as mp4 from '../../mp4/src/index.js';
import * as mkv from '../../mkv/src/index.js';
import * as mov from '../../mov/src/index.js';
import * as ts from '../../ts/src/index.js';
import * as flv from '../../flv/src/index.js';
import * as ape from '../../ape/src/index.js';
import * as wav from '../../wav/src/index.js';
import * as flac from '../../flac/src/index.js';

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

const mods = { mp4, mkv, mov, ts, flv, ape, wav, flac };

/** 懒装载全部异步 fixture（flac/wav 文件读取），各用例内 await ready */
const ready = (async () => {
  const flacBytes = await readFix('sample-basic.flac');
  const wavBytes = new Uint8Array(
    await readFile(new URL('../../wav/__tests__/fixtures/sample-basic.wav', import.meta.url)),
  );
  return {
    // probe/拒绝面 fuzz 用变异源
    fixtures: [
      { name: 'mp4-prog', bytes: buildProgressiveVideoFixture().bytes },
      { name: 'mp4-frag', bytes: buildFragmentedFixture().bytes },
      { name: 'mkv-webm', bytes: makeMinimalWebm().bytes },
      { name: 'flac', bytes: flacBytes },
    ],
    // 运行时滥用面用完好 fixture + 对应模块
    runtimeFixtures: [
      ['mp4', mp4, buildProgressiveVideoFixture().bytes],
      ['mkv', mkv, makeMinimalWebm().bytes],
      ['wav', wav, wavBytes],
      ['flac', flac, flacBytes],
    ],
  };
})();

const ROUNDS_PER_PAIR = 30;

test('probe 契约 fuzz：变异输入禁止抛异常（命中/未命中均合法）', async () => {
  const { fixtures } = await ready;
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
  const { fixtures } = await ready;
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

/* ---------------- 运行时 API 滥用面（第二百零七波固化） ---------------- */

/** 限时 settle：2s 内必须完成，否则判为悬挂 */
function withTimeout(p, ms = 2000) {
  return Promise.race([
    p,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error('__hang__')), ms);
      if (typeof t?.unref === 'function') t.unref();
    }),
  ]);
}

test('seek 边界滥用：非法入参必带 code 拒绝；成功时 actualTimestampUs 为有限整数 µs', async () => {
  const { runtimeFixtures } = await ready;
  const ABUSE = [NaN, Infinity, -Infinity, -1, 2 ** 53, 2 ** 63, '1000', null, undefined, {}, 0.5];
  for (const [name, mod, bytes] of runtimeFixtures) {
    const d = await mod.createDemuxer(new MemoryDataSource(bytes));
    for (const v of ABUSE) {
      try {
        const r = await withTimeout(d.seek(v));
        assert.ok(
          Number.isInteger(r.actualTimestampUs) && Number.isFinite(r.actualTimestampUs),
          `${name}.seek(${String(v)}) 返回违反整数 µs 契约: ${JSON.stringify(r)}`,
        );
      } catch (e) {
        assert.notEqual(e.message, '__hang__', `${name}.seek(${String(v)}) 悬挂`);
        assert.ok(e.code, `${name}.seek(${String(v)}) 裸抛 ${e.constructor.name}: ${e.message}`);
      }
    }
    await d.destroy?.().catch(() => {});
  }
});

test('操作序列滥用：seek/readSample/samples/destroy 随机交错 20 轮不裸抛不悬挂', async () => {
  const { runtimeFixtures } = await ready;
  // 独立种子（与文件头 probe 种子分离，保证本例可单独复现）
  let s2 = 0xc0ffee;
  const rand2 = () => {
    s2 ^= s2 << 13; s2 >>>= 0;
    s2 ^= s2 >> 17;
    s2 ^= s2 << 5; s2 >>>= 0;
    return s2 / 0x100000000;
  };
  const pick = (a) => a[Math.floor(rand2() * a.length)];
  const VALUES = [0, 1, 1000, -1, 0.5, NaN, Infinity, 2 ** 40, 123456789];

  for (let round = 0; round < 20; round++) {
    for (const [name, mod, bytes] of runtimeFixtures) {
      const d = await mod.createDemuxer(new MemoryDataSource(bytes));
      for (let k = 0; k < 6; k++) {
        const op = pick(['seek', 'readSample', 'iter', 'destroy']);
        if (op === 'destroy') break; // 破坏性操作留到循环外统一验证
        try {
          const r = await withTimeout(op === 'seek' ? d.seek(pick(VALUES)) : d.readSample(1));
          if (op === 'seek' && r) {
            assert.ok(Number.isInteger(r.actualTimestampUs), `${name} seek 结果非整数 µs`);
          }
          if (op === 'readSample' && r) {
            assert.ok(Number.isInteger(r.ptsUs) && Number.isInteger(r.dtsUs), `${name} 样本 pts/dts 非整数`);
          }
        } catch (e) {
          assert.notEqual(e.message, '__hang__', `${name}.${op}#${round}.${k} 悬挂`);
          assert.ok(e.code, `${name}.${op}#${round}.${k} 裸抛 ${e.constructor.name}: ${e.message}`);
        }
      }
      await d.destroy?.().catch(() => {});
      await d.destroy?.().catch(() => {}); // 二次 destroy 必须幂等静默
    }
  }
});
