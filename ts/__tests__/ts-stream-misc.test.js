/**
 * ts-stream-misc.test.js —— ts-stream-engine.js 其余深水分支（引擎级）
 *
 * 聚焦此前 3 个深测文件（ts-pes-assembly / ts-psi / ts-pcr-buffer）尚未覆盖的分支：
 *   - reset()：状态清零后可重新解析全新流（ccErrors/tracks/streams 重置）
 *   - PAT 含 program_number=0（NIT）跳过：不得注册为 PMT PID
 *   - PES 有效载荷为空（ES 长 0）：解析后不出样本
 *   - flush()：未完整（无 PUSI 截断）的已积累 PES 在冲刷时被强制 dispatch 出样本
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPAT, buildPMT, sectionToPackets, buildPes, dataToPackets,
  h264IdrSlice, h264NonIdrSlice, annexb, resetCc,
} from './fixtures/build-ts.mjs';
import {
  concatBytes, mkEngine, attachCollector, mkPacket, psiCell, makeProgram, VIDEO_PID, PMT_PID,
} from './ts-testkit.mjs';

/* ------------------------------ reset 复用 ------------------------------ */

test('reset()：状态清零后可重新解析全新流', () => {
  resetCc();
  const e = mkEngine();
  const ev = attachCollector(e);
  // 第一轮
  e.push(concatBytes(makeProgram()));
  e.push(concatBytes(dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 }))));
  e.flush();
  assert.equal(ev.samples.length, 1);
  assert.ok(e.tracks.length >= 1);
  assert.equal(ev.errors.length, 0);
  // 重置后应为干净状态
  e.reset();
  assert.equal(e.tracks.length, 0, 'tracks 应清零');
  assert.equal(e.ccErrors, 0, 'ccErrors 应清零');
  assert.equal(e.streams.size, 0, 'streams 应清空');
  assert.equal(e.pmtPids.size, 0, 'pmtPids 应清空');
  assert.equal(e.complete, false);
  // 第二轮：全新流可再次解析（不残留旧状态）
  const ev2 = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(concatBytes(dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264IdrSlice()), { pts: 60000 }))));
  e.flush();
  assert.equal(ev2.samples.length, 1, 'reset 后引擎可重新产出样本');
  assert.equal(ev2.errors.length, 0);
  assert.equal(ev2.samples[0].pts, 666667, '第二轮 PTS=60000 → 666667µs');
});

/* ------------------------------ PAT NIT 跳过 ------------------------------ */

test('PAT 含 program_number=0（NIT）跳过：不注册为 PMT PID', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  // 注意：PMT_PID 本身即 0x1000，故 NIT 用不同 pid 0x1001 以区分断言
  const pat = buildPAT([{ number: 0, pid: 0x1001 }, { number: 1, pid: PMT_PID }]);
  e._parsePacket(psiCell(0x0000, pat));
  assert.ok(e.pmtPids.has(PMT_PID), '合法节目应注册');
  assert.ok(!e.pmtPids.has(0x1001), 'NIT(pid=0) 不得注册为 PMT PID');
  assert.equal(e.programNumber, 1, 'programNumber 取最后一个非 0 号');
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ 空载荷 PES ------------------------------ */

test('PES 有效载荷为空（ES 长 0）：解析后不出样本', () => {
  resetCc();
  const e = mkEngine();
  const ev = attachCollector(e);
  const pes = buildPes(0xe0, new Uint8Array(0), { pts: 90000 });
  e.push(concatBytes(makeProgram()));
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes)));
  e.flush();
  assert.equal(ev.samples.length, 0, 'ES 为空 → _dispatchPes 直接 return');
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ flush 冲刷未完成 PES ------------------------------ */

test('flush()：未完整（无 PUSI 截断）的已积累 PES 在冲刷时被 dispatch', () => {
  resetCc();
  const pes = buildPes(0xe0, annexb(h264NonIdrSlice(300)), { pts: 90000 }); // 约跨 2 包
  const pkts = dataToPackets(VIDEO_PID, pes);
  assert.ok(pkts.length >= 2, '测试前提：PES 应跨多包');
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(pkts[0]);            // 仅首包，无后续、无 PUSI
  e.flush();
  assert.equal(ev.samples.length, 1, 'flush 应冲刷已积累的不完整 PES');
  assert.equal(ev.samples[0].pts, 1_000_000);
  assert.equal(ev.errors.length, 0);
});
