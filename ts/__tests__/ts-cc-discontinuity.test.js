/**
 * ts-cc-discontinuity.test.js —— 最小回归：discontinuity_indicator 与 CC 校验顺序
 *
 * 契约：transport_packet 携带 adaptation_field 且 discontinuity_indicator=1 时，
 * 该包的 continuity_counter 不应参与连续性检测（拼接点 CC 跳变合法），且需重置
 * 期望 CC，使后续包从新序列起步。即「AF 解析必须先于 CC 校验」。
 *
 * 本文件只验证这一条顺序契约，不改动任何 src。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkEngine, mkPacket, VIDEO_PID, attachCollector } from './ts-testkit.mjs';

test('discontinuity_indicator=1 的包：CC 不匹配也豁免本包，不计错且重置期望', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  // 先建立期望 CC：VIDEO_PID 上一个正常包 cc=0 → 期望变为 1
  e._parsePacket(mkPacket({ pid: VIDEO_PID, afControl: 0x01, cc: 0 }));
  assert.equal(e._ccExpect.get(VIDEO_PID), 1, '测试前提：期望 CC 已建立为 1');

  // 拼接点：AF-only + discontinuity_indicator 置位，且 CC 故意与期望不一致（=7）
  e._parsePacket(mkPacket({
    pid: VIDEO_PID, afControl: 0x02, afLen: 1, afFlags: 0x80, cc: 7,
  }));

  // 核心契约：本包自身不得被计为连续性错误（AF 解析先于 CC 校验）
  assert.equal(e.ccErrors, 0, 'discontinuity 置位应豁免本包 CC 校验，不计错');
  assert.equal(e._ccExpect.has(VIDEO_PID), false, 'discontinuity 应清除期望 CC');
  assert.equal(ev.errors.length, 0, '不得抛错');
});

test('逆测试：无 discontinuity_indicator 的 CC 跳变必须计错（豁免是 discontinuity 专用）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  // 建立期望 CC：正常包 cc=0 → 期望变为 1
  e._parsePacket(mkPacket({ pid: VIDEO_PID, afControl: 0x01, cc: 0 }));
  assert.equal(e._ccExpect.get(VIDEO_PID), 1, '测试前提：期望 CC 已建立为 1');

  // 无 AF、无 discontinuity，CC 故意跳变到 7
  e._parsePacket(mkPacket({ pid: VIDEO_PID, afControl: 0x01, cc: 7 }));

  assert.equal(e.ccErrors, 1, '无 discontinuity 时 CC 跳变应计一次错误');
  assert.ok(ev.warns.some((w) => w.includes('连续计数不连续')), '应有连续性告警');
});
