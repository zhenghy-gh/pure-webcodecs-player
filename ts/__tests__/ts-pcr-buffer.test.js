/**
 * ts-pcr-buffer.test.js —— PCR/时基与背压恢复（引擎级，TsStreamEngine）
 *
 * 覆盖点：
 *   - PCR extension 换算：floor(ext/300) 折算进 90kHz 基准（亚 tick 舍去）
 *   - PCR 33bit 回绕：跨度补 2^33，无 DTS 时长由 PCR 兜底
 *   - 丢包（CC 跳变）：告警 + ccErrors 计数，后续 PUSI 恢复出样本，不触发重探测
 *   - discontinuity_indicator：重置 CC 期望，后续 CC 跳变不计错
 *   - 包级乱序（相邻包交换）：CC 计错、PES 数据乱序重组，但流不崩溃并恢复
 *
 * 说明：引擎为字节序驱动（包顺序=到达顺序），无内建重排序缓冲；
 * 「乱序」在此语义为包流中相邻包位置颠倒后的行为验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPes, dataToPackets, h264IdrSlice, h264NonIdrSlice, annexb, resetCc,
} from './fixtures/build-ts.mjs';
import {
  concatBytes, mkEngine, attachCollector, mkPacket, makeProgram, VIDEO_PID,
} from './ts-testkit.mjs';

/** 构造 AF-only 含 PCR 的 TS 包（base 33bit + ext 9bit） */
function pcrPacket(pid, base, { ext = 0, discontinuity = false, cc = 0 } = {}) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;
  pkt[3] = 0x20 | (cc & 0x0f);        // AF-only（无载荷）
  pkt[4] = 7;                          // afLen = flags(1) + PCR(6)
  pkt[5] = 0x10 | (discontinuity ? 0x80 : 0);
  pkt[6] = (base >> 25) & 0xff;
  pkt[7] = (base >> 17) & 0xff;
  pkt[8] = (base >> 9) & 0xff;
  pkt[9] = (base >> 1) & 0xff;
  pkt[10] = ((base & 0x01) << 7) | ((ext >> 8) & 0x01);
  pkt[11] = ext & 0xff;
  return pkt;
}

/* ------------------------------ PCR/时基 ------------------------------ */

test('PCR extension 换算：floor(ext/300) 折算进 90kHz 基准（9 位 ext）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(pcrPacket(0x0100, 90000, { ext: 0, cc: 0 }));
  e._parsePacket(pcrPacket(0x0100, 90000, { ext: 299, cc: 1 }));
  e._parsePacket(pcrPacket(0x0100, 90000, { ext: 300, cc: 2 }));
  e._parsePacket(pcrPacket(0x0100, 90000, { ext: 511, cc: 3 }));
  assert.equal(ev.pcrs.length, 4);
  assert.equal(ev.pcrs[0].pcr90k, 90000, 'ext=0 → +0');
  assert.equal(ev.pcrs[1].pcr90k, 90000, 'ext=299 → floor(299/300)=0');
  assert.equal(ev.pcrs[2].pcr90k, 90001, 'ext=300 → +1');
  assert.equal(ev.pcrs[3].pcr90k, 90001, 'ext=511（9 位满）→ +1');
  assert.equal(e._pcrSeen, 4);
});

test('PCR 跨度驱动时长兜底（引擎驱动，无 DTS 轨道）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  let meta = null;
  e.on('metadata', (m) => { meta = m; });
  e._parsePacket(pcrPacket(0x0100, 0, { cc: 0 }));
  e._parsePacket(pcrPacket(0x0100, 270000, { cc: 1 }));   // 3s
  e.flush();
  assert.equal(e._pcrFirst, 0);
  assert.equal(e._pcrLast, 270000);
  assert.equal(meta.pcrDurationMs, 3000);
  assert.equal(meta.durationMs, 3000, '无 DTS 轨道时由 PCR 兜底');
  assert.equal(meta.pcrSeen, 2);
  assert.equal(meta.container, 'mpeg-ts');
  assert.equal(ev.errors.length, 0);
});

test('PCR 33bit 回绕：无 discontinuity 标志的回退按回绕抬升，时长正确（第九十五波修复回归）', () => {
  // 修复前：min/max 追踪使回绕后小值拉低 _pcrFirst，长流（>26.5h）回绕后
  // 时长坍缩为 ≈26.5h 垃圾值。修复后：回退值抬升到单调域再取 max。
  const e = mkEngine();
  const ev = attachCollector(e);
  let meta = null;
  e.on('metadata', (m) => { meta = m; });
  e._parsePacket(pcrPacket(0x0100, 2 ** 33 - 90000, { cc: 0 }));
  e._parsePacket(pcrPacket(0x0100, 180000, { cc: 1 }));   // 回绕后再走 180000 tick
  e.flush();
  assert.equal(e._pcrFirst, 2 ** 33 - 90000, '基准保持本段首个 PCR');
  assert.equal(e._pcrLast, 2 ** 33 + 180000, '回绕值抬升到单调域（+2^33）');
  assert.equal(
    meta.pcrDurationMs,
    3000,
    '跨度 = 距回绕 1s + 回绕后 2s = 3s，而非 ≈26.5h 垃圾值',
  );
  assert.equal(ev.pcrs.length, 2);
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ 丢包/乱序恢复 ------------------------------ */

test('丢包（CC 跳变）：告警 + ccErrors 计数，后续 PUSI 恢复出样本，不触发重探测', () => {
  resetCc();
  const pes0 = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 60000 });
  const pes1 = buildPes(0xe0, annexb(h264NonIdrSlice(300)), { pts: 90000 });  // 跨多包
  const pes2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120000 });
  const p1 = dataToPackets(VIDEO_PID, pes1);
  assert.ok(p1.length >= 2, '测试前提：PES1 应跨多包');
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes0)));
  e.push(concatBytes(p1.slice(1)));                // 丢弃 PES1 的 PUSI 首包
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes2)));
  e.flush();
  assert.equal(e.ccErrors, 1, '恰好一处 CC 跳变');
  assert.ok(ev.warns.some((w) => w.includes('连续计数不连续')), '应有丢包告警');
  assert.equal(e.resyncs, 0, 'CC 跳变不得触发重探测');
  assert.equal(ev.samples.length, 2, 'PES0 与 PES2 存活，PES1 丢失');
  assert.equal(ev.errors.length, 0);
});

test('discontinuity_indicator：重置 CC 期望，后续 CC 跳变不计错', () => {
  resetCc();
  const pes0 = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 60000 });
  const pes2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120000 });
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes0)));
  const expect = e._ccExpect.get(VIDEO_PID);
  assert.ok(expect != null, '测试前提：期望 CC 已建立');
  // 拼接点：AF-only + discontinuity 置位，且 CC 故意与期望不一致。
  // 修复前 CC 校验先于 discontinuity_indicator 解析，本包会被误计一次 ccError；
  // 修复后 discontinuity 置位应豁免本包 CC 校验，不计错。
  e._parsePacket(mkPacket({
    pid: VIDEO_PID, afControl: 0x02, afLen: 1, afFlags: 0x80, cc: (expect + 5) & 0x0f,
  }));
  assert.equal(e._ccExpect.has(VIDEO_PID), false, 'discontinuity 应清除期望值');
  // 期望清除后，CC 任意跳变不计错（流拼接语义）
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes2)));
  e.flush();
  assert.equal(e.ccErrors, 0, 'discontinuity 后的 CC 跳变不得计错');
  assert.equal(ev.samples.length, 2, '拼接两侧帧均存活');
  assert.equal(ev.errors.length, 0);
});

test('包级乱序（相邻包交换）：CC 计错、数据乱序重组，但流不崩溃并恢复', () => {
  resetCc();
  const pes1 = buildPes(0xe0, annexb(h264NonIdrSlice(400)), { pts: 90000 });  // 3 包
  const pes2 = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 120000 });
  const p1 = dataToPackets(VIDEO_PID, pes1);
  assert.ok(p1.length >= 3, '测试前提：PES1 应跨 3 包');
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(p1[0]);
  e.push(p1[2]);   // 乱序：先第 3 包
  e.push(p1[1]);   // 再第 2 包
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes2)));
  e.flush();
  assert.ok(e.ccErrors >= 2, `两次乱序至少计两次 CC 错，实际 ${e.ccErrors}`);
  assert.equal(ev.errors.length, 0, '乱序不得抛错');
  assert.equal(e.resyncs, 0, '包级乱序不得触发重探测');
  assert.equal(ev.samples.length, 2, '乱序 PES 以重组结果出样本，后续帧存活');
});
