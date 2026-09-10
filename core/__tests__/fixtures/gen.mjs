/**
 * core fixture 生成器（CONTRACTS §0.6）。
 *
 * core 是纯库模块：这里产出的是"契约形状样例数据"（JSON），
 * 供 demo/联调与跨模块交叉验证引用；解析层单测本身走内存字节，无磁盘依赖。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSample } from '../../src/types.js';

/** @param {string} fixDir 产物目录 */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });

  // 契约 Sample 样例（µs 时间基）
  const samples = [0, 1, 2].map((i) =>
    createSample({
      trackId: 1,
      codec: 'avc1.42E01E',
      timestamp: i * 40000,
      duration: 40000,
      dts: i * 40000 - (i === 2 ? 20000 : 0),
      keyframe: i === 0,
      size: 16,
      index: i,
    }),
  );
  await writeFile(
    path.join(fixDir, 'contract-sample.json'),
    JSON.stringify({ note: 'Sample 契约形状样例（整数微秒）', sample: samples[1] }, null, 2),
  );
  console.log('[fixtures] contract-sample.json');
}
