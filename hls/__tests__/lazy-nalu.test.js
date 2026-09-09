/**
 * 第一轮评审 §16.3 架构项回归：hls 模块图与 ts/ 的 load 期解耦。
 *
 * 旧实现 fmp4-muxer.js 静态 import ts/src/nalu.js：ESM 静态依赖在模块加载期
 * 解析，ts/ 缺失时整条 hls 模块图加载失败，Transmuxer.tsAvailable() 的
 * 「探测后降级」承诺失真。本组用例守护三点：
 *   1) 探测语义成立（tsAvailable 可用）；
 *   2) 惰性 nalu 端到端生效（真实 TS remux 全链路）；
 *   3) 源码守卫：fmp4-muxer.js 不得恢复对 ts/src 的静态 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleTs } from '../../ts/__tests__/fixtures/build-ts.mjs';
import { Transmuxer, TsToFmp4Transmuxer } from '../src/transmuxer.js';
import { loadNalu } from '../src/fmp4-muxer.js';

test('探测：Transmuxer.tsAvailable() 在本仓环境可用（语义成立）', async () => {
  // 关键前提：本测试文件能 import transmuxer.js / fmp4-muxer.js 本身即证明
  // hls 模块图加载不依赖 ts/（旧实现下若 ts/ 缺失此文件都加载不起来）
  const ok = await Transmuxer.tsAvailable();
  assert.equal(ok, true);
});

test('惰性 nalu：loadNalu() 幂等且返回含所需函数的命名空间', async () => {
  const m1 = await loadNalu();
  const m2 = await loadNalu();
  assert.equal(m1, m2, '应缓存同一命名空间（幂等）');
  assert.equal(typeof m1.splitAnnexB, 'function');
  assert.equal(typeof m1.classify, 'function');
  assert.equal(typeof m1.annexbToAvcc, 'function');
});

test('端到端：惰性 nalu 下真实 TS remux 全链路成功（AnnexB→AVCC）', async () => {
  const bytes = assembleTs({ video: { codec: 'h264', width: 320, height: 240, frames: 6, gopSize: 3 } });
  const muxer = new TsToFmp4Transmuxer();
  const out = await muxer.remux(bytes);
  assert.ok(out.video, '应产出视频轨');
  assert.match(out.codecs.video, /^avc1\.[0-9a-fA-F]{6}$/);
  assert.ok(out.video.mediaSegment.length > 0);
});

test('源码守卫：fmp4-muxer.js 不得恢复对 ts/src 的静态 import', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/fmp4-muxer.js', import.meta.url)), 'utf8');
  const staticTsImport = src.match(/^import\s[^;]*from\s+['"][^'"]*ts\/src\//m);
  assert.equal(
    staticTsImport,
    null,
    `发现 ts/src 静态导入（会重新造成 load 期耦合）: ${staticTsImport && staticTsImport[0]}`
  );
  // 动态导入必须保留（remux 运行期依赖）
  assert.match(src, /import\('\.\.\/\.\.\/ts\/src\/index\.js'\)/, 'remux 应保留 TsDemuxer 动态导入');
  assert.match(src, /import\('\.\.\/\.\.\/ts\/src\/nalu\.js'\)/, 'loadNalu 应保留 nalu 动态导入');
});
