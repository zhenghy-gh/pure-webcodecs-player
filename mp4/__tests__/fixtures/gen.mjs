/**
 * mp4 fixture 生成器（CONTRACTS §0.6 / docs/fixtures-约定.md）。
 *
 * 通道组合：
 * - makeMinimalMP4：来自根共享库 samples/fixtures/index.js（团队唯一编码器源）；
 * - 渐进/fMP4 富 fixture：复用本模块生产代码 box-builder 构造（非第二套编码器，
 *   是对 remuxer 同款实现的直接调用），期望样本表以 JSON 一并落盘供断言。
 *
 * 幂等：覆盖写，禁随机数与时间戳。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeMinimalMP4 } from '../../../samples/fixtures/index.js';
import { buildProgressiveVideoFixture, buildFragmentedFixture } from '../fixtures.js';

/** @param {string} fixDir 产物目录（即本文件所在目录） */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });

  // ① 共享库最小 MP4（moov 前置）
  const minimal = makeMinimalMP4();
  await writeFile(path.join(fixDir, 'minimal.mp4'), minimal.bytes ?? minimal);
  console.log(`[fixtures] minimal.mp4: ${(minimal.bytes ?? minimal).length}B`);

  // ② 渐进 MP4（视频轨 + B 帧 ctts + stss 关键帧）
  const prog = buildProgressiveVideoFixture();
  await writeFile(path.join(fixDir, 'progressive.mp4'), prog.bytes);
  await writeFile(
    path.join(fixDir, 'progressive.meta.json'),
    JSON.stringify({
      timescale: 1000,
      expectedSamples: prog.expectedSamples,
      avcC: [...prog.avcC],
    }),
  );
  console.log(`[fixtures] progressive.mp4: ${prog.bytes.length}B / 8 样本`);

  // ③ fMP4（init + 2 fragments）
  const frag = buildFragmentedFixture();
  await writeFile(path.join(fixDir, 'fragmented.mp4'), frag.bytes);
  await writeFile(
    path.join(fixDir, 'fragmented.meta.json'),
    JSON.stringify({ timescale: frag.timescale, trackId: frag.trackId }),
  );
  console.log(`[fixtures] fragmented.mp4: ${frag.bytes.length}B / 6 样本`);
}
