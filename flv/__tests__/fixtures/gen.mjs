/**
 * flv/__tests__/fixtures/gen.mjs —— 《docs/fixtures-约定.md》的参考实现（sdet 维护）。
 *
 * 约定：每个模块可提供本文件，导出 async generate(fixDir)，把样例文件写入 fixDir；
 * `npm run fixtures` 会逐模块调用（无此文件的模块自动跳过）；产物已被根 .gitignore
 * 忽略，不入库、随时可重建。
 *
 * 实现红线：容器字节一律 import 根 fixtures 库（samples/fixtures）复用生成，
 * 禁止在本文件另造编码器；输出必须确定性（无随机、无当前时间戳）。
 *
 * 手动运行：npm run fixtures   （或 node samples/generate-all.mjs）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFLV } from '../../../samples/fixtures/index.js';

/** @param {string} fixDir 产物目录（即本文件所在目录） */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });

  // 用例集：名称 → 生成器调用。按需增删，保持确定性参数即可。
  const cases = [
    ['basic.flv', makeFLV({ frameCount: 6 })],
    ['av.flv', makeFLV({ hasAudio: true, frameCount: 8 })], // 视频+AAC 音频
    ['tiny.flv', makeFLV({ frameCount: 1 })],               // 最小合法文件
  ];

  const written = [];
  for (const [name, { bytes, meta }] of cases) {
    await writeFile(path.join(fixDir, name), bytes);
    written.push(`${name}(${bytes.length}B/${meta.frameCount}帧${meta.hasAudio ? '+音' : ''})`);
  }
  console.log(`[fixtures] flv 参考生成器 → ${written.join(' ')}`);
}
