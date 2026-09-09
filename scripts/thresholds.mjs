#!/usr/bin/env node
/**
 * 门槛达标报表：逐模块统计 node --test 用例数，对照 PRD 摘要表门槛输出缺口。
 *
 * - 口径与 docs/TESTING.md §4 一致：TAP `# tests` 计数（test()=1 例），fail 要求恒为 0；
 * - 当前为**报告性步骤**（不影响 npm run check 退出码），M2 出口起转阻断；
 * - 数据源：docs/PRD.md 摘要表（合计 ≥565 例）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PRD v2.x 摘要表的每模块单测门槛（qa 口径，fail=0） */
export const THRESHOLDS = {
  core: 40, mp4: 40, mov: 30, mkv: 60, ts: 45, flv: 35, hls: 50,
  cmaf: 25, wav: 25, flac: 35, ape: 20, subtitle: 35,
  webtorrent: 40, webrtc: 25, rtmp: 20, rtsp: 40,
};

/** 单模块计数（返回 {tests, pass, fail}；无测试目录时全 0） */
export function countModule(mod) {
  const r = spawnSync(process.execPath, [
    '--test', '--test-timeout=10000', '--test-force-exit',
    `${mod}/__tests__/*.test.{js,mjs}`,
  ], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}`;
  const num = (re) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : 0;
  };
  return {
    tests: num(/^# tests (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
  };
}

/** 打印全量达标表；返回 {total, thresholdTotal, rows} */
export function report() {
  const mods = Object.keys(THRESHOLDS);
  const rows = [];
  let total = 0;
  console.log('[thresholds] 门槛达标表（PRD 摘要表口径，报告性输出）');
  console.log('[thresholds] ' + '模块'.padEnd(12) + '实际'.padStart(5) + '门槛'.padStart(5) + '缺口'.padStart(5) + '  状态');
  for (const mod of mods) {
    const { tests, fail } = countModule(mod);
    const need = THRESHOLDS[mod];
    const gap = Math.max(0, need - tests);
    total += tests;
    const mark = gap === 0 && fail === 0 ? '✓ 达标' : `✗ 缺${gap}${fail ? ` / fail=${fail}` : ''}`;
    rows.push({ mod, tests, need, gap, fail });
    console.log('[thresholds] ' + mod.padEnd(12) + String(tests).padStart(5) + String(need).padStart(5) + String(gap).padStart(5) + '  ' + mark);
  }
  const thresholdTotal = Object.values(THRESHOLDS).reduce((a, b) => a + b, 0);
  console.log(`[thresholds] 合计 ${total}/${thresholdTotal} 例（fail 汇总 ${rows.reduce((a, r) => a + r.fail, 0)}）；达标 ${rows.filter((r) => r.gap === 0 && r.fail === 0).length}/${mods.length} 模块`);
  return { total, thresholdTotal, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  report();
}
