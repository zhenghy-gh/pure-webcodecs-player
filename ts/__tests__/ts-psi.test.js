/**
 * ts-psi.test.js —— PSI 层深水区（引擎级，TsStreamEngine + PsiAssembler 集成）
 *
 * 覆盖点：
 *   - PAT/PMT 跨包分段组装（引擎级：超长 PMT 分包后流表建立、样本可解）
 *   - pointer_field 语义（引擎级：跳过残余字节后解析 PAT）
 *   - CRC32 校验失败：引擎告警但继续解析（PAT/PMT 各一）
 *   - stream_type→codec 全映射：h264/hevc/aac-adts/aac-latm 支持，
 *     mpeg2/mp3/私有/未知类型进 ignoredStreams；LATM 通道标记
 *   - 仅声明未知 stream_type：无轨道、其 ES 数据被忽略
 *   - PMT 版本对账：同版本重发不重建；换版移除被撤销的 ES
 *   - 多节目分账：PMT_A 换版只重建自己的流，PMT_B 不受影响
 *   - 同包双 section 粘包：仅 pointer_field 指向的首节生效，次节待下一个 PUSI
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPAT, buildPMT, sectionToPackets, buildPes, dataToPackets,
  h264IdrSlice, h264NonIdrSlice, annexb, resetCc,
} from './fixtures/build-ts.mjs';
import {
  concatBytes, mkEngine, attachCollector, mkPacket, psiCell, VIDEO_PID, PMT_PID,
} from './ts-testkit.mjs';

/* ------------------------------ 跨包分段组装 ------------------------------ */

test('PMT 跨包组装（引擎级）：60 流超长 PMT 分包后流表与样本可用', () => {
  resetCc();
  const streams = Array.from({ length: 60 }, (_, i) => ({ streamType: 0x1b, pid: 0x0200 + i }));
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({ pcrPid: VIDEO_PID, streams })),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  assert.equal(e.streams.size, 60, 'PMT 跨包后流表应完整建立');
  assert.equal(e.tracks.length, 60);
  const pes = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 });
  e.push(concatBytes(dataToPackets(0x0200, pes)));
  e.flush();
  assert.equal(ev.samples.length, 1, '跨包 PMT 声明的 ES 应可出样本');
  assert.equal(ev.samples[0].trackId, 0x0200);
  assert.equal(ev.errors.length, 0);
});

test('pointer_field 语义（引擎级）：跳过残余字节后解析 PAT', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat = buildPAT([{ number: 5, pid: PMT_PID }]);
  // payload = pointer_field(5) + 5 字节上一节残余 + section
  const payload = concatBytes([new Uint8Array([5, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]), pat]);
  e._parsePacket(mkPacket({ pid: 0x0000, pusi: true, cc: 0, payload }));
  assert.equal(e.programNumber, 5, 'pointer_field 指向的偏移处应为 section 起点');
  assert.ok(e.pmtPids.has(PMT_PID));
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ CRC32 校验 ------------------------------ */

test('CRC 校验失败：引擎告警但继续解析（PAT/PMT 各一）', () => {
  resetCc();
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat = buildPAT([{ number: 1, pid: PMT_PID }]);
  pat[pat.length - 1] ^= 0xff;                       // 破坏 CRC
  e._parsePacket(psiCell(0x0000, pat));
  assert.ok(ev.warns.some((w) => w.includes('PAT CRC')), '应有 PAT CRC 告警');
  assert.equal(e.programNumber, 1, 'CRC 失败仍解析节目映射');

  const pmt = buildPMT({ pcrPid: VIDEO_PID, streams: [{ streamType: 0x1b, pid: VIDEO_PID }] });
  pmt[pmt.length - 1] ^= 0xff;
  e._parsePacket(psiCell(PMT_PID, pmt));
  assert.ok(ev.warns.some((w) => w.includes('PMT CRC')), '应有 PMT CRC 告警');
  assert.equal(e.tracks.length, 1, 'CRC 失败仍建轨');

  const pes = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 });
  e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, cc: 0, payload: pes }));
  assert.equal(ev.samples.length, 1, '解析链路不受 CRC 失败影响');
});

/* ------------------------------ stream_type 映射 ------------------------------ */

test('stream_type→codec 全映射：支持/忽略分流与 LATM 标记', () => {
  resetCc();
  const streams = [
    { streamType: 0x1b, pid: 0x0101 }, // h264
    { streamType: 0x24, pid: 0x0102 }, // hevc
    { streamType: 0x0f, pid: 0x0103 }, // aac-adts
    { streamType: 0x11, pid: 0x0104 }, // aac-latm
    { streamType: 0x02, pid: 0x0105 }, // mpeg2-video → 忽略
    { streamType: 0x03, pid: 0x0106 }, // mp3 → 忽略
    { streamType: 0x06, pid: 0x0107 }, // 私有 PES → 忽略
    { streamType: 0x88, pid: 0x0108 }, // 完全未知 → 忽略
  ];
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({ pcrPid: 0x0101, streams })),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  e.flush();

  const snap = e.psiSnapshot();
  assert.equal(snap.programs.length, 1);
  const byPid = new Map(snap.programs[0].streams.map((s) => [s.pid, s]));
  assert.deepEqual(
    [...byPid.keys()].sort((a, b) => a - b),
    [0x0101, 0x0102, 0x0103, 0x0104],
    '快照只含受支持流',
  );
  assert.equal(byPid.get(0x0101).codec, 'h264');
  assert.equal(byPid.get(0x0102).codec, 'hevc');
  assert.equal(byPid.get(0x0103).codec, 'aac', 'aac-adts 归一化为 aac');
  assert.equal(byPid.get(0x0104).codec, 'aac', 'aac-latm 归一化为 aac');
  assert.ok([...byPid.values()].every((s) => s.supported));

  assert.deepEqual(
    e.ignoredStreams.map((s) => [s.pid, s.streamType]),
    [[0x0105, 0x02], [0x0106, 0x03], [0x0107, 0x06], [0x0108, 0x88]],
    '不受支持类型应记录 pid+streamType',
  );
  assert.ok(ev.warns.some((w) => w.includes('忽略暂不支持的 stream_type')));

  assert.equal(e.tracks.length, 4);
  assert.deepEqual(e.tracks.map((t) => t.type).sort(), ['audio', 'audio', 'video', 'video']);
  assert.equal(e.trackState.get(`t:${0x0103}`).latm, false, 'ADTS 不启用 LATM 通道');
  assert.equal(e.trackState.get(`t:${0x0104}`).latm, true, 'stream_type=0x11 应启用 LATM 通道');
});

test('未知 stream_type：仅声明未知类型时无轨道、其 ES 数据被忽略', () => {
  resetCc();
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({ pcrPid: VIDEO_PID, streams: [{ streamType: 0x88, pid: VIDEO_PID }] })),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  assert.equal(e.tracks.length, 0);
  assert.equal(e.ignoredStreams.length, 1);
  const pes = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 });
  e.push(concatBytes(dataToPackets(VIDEO_PID, pes)));
  e.flush();
  assert.equal(ev.samples.length, 0, '未声明支持的 ES 不得出样本');
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ 版本对账与多节目 ------------------------------ */

test('PMT 版本对账：同版本重发不重建；换版移除被撤销的 ES', () => {
  resetCc();
  const pmtV0 = () => buildPMT({
    pcrPid: VIDEO_PID,
    streams: [{ streamType: 0x1b, pid: 0x0101 }, { streamType: 0x0f, pid: 0x0102 }],
  }, 0);
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, pmtV0()),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  assert.equal(ev.tracks.length, 1, '首次 PMT 发轨道事件');
  assert.equal(e.tracks.length, 2);

  // 同版本重发（全新组包保持 CC 连续）：不应触发重建
  e.push(concatBytes(sectionToPackets(PMT_PID, pmtV0())));
  assert.equal(ev.tracks.length, 1, '同版本重发不得再发轨道事件');
  assert.equal(e.tracks.length, 2);

  // 换版 v1：保留 h264 并新增 aac@0x0103、移除 0x0102（增删并存 → 重建路径）
  e.push(concatBytes(sectionToPackets(PMT_PID, buildPMT(
    {
      pcrPid: VIDEO_PID,
      streams: [{ streamType: 0x1b, pid: 0x0101 }, { streamType: 0x0f, pid: 0x0103 }],
    }, 1,
  ))));
  assert.equal(ev.tracks.length, 2, '换版（含新增）应重发轨道事件');
  assert.equal(e.tracks.length, 2);
  assert.ok(!e.streams.has(0x0102), '被撤销的 ES 应从流表移除');
  assert.ok(!e.trackState.has(`t:${0x0102}`), '对应轨道状态应清除');
  assert.ok(e.streams.has(0x0103), '新增 ES 应入表');
  assert.equal(e.pmtVersions.get(PMT_PID), 1, '版本记账更新');
});

test('PMT 换版仅移除 ES 时：重发 tracks 事件、列表刷新（第九十五波修复回归）', () => {
  // 修复前：`let changed = firstSeen` 使「只移除」的换版不发 tracks 事件、
  // this.tracks 残留旧列表（消费端无法感知轨道消失）。
  resetCc();
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({
      pcrPid: VIDEO_PID,
      streams: [{ streamType: 0x1b, pid: 0x0101 }, { streamType: 0x0f, pid: 0x0102 }],
    }, 0)),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  assert.equal(ev.tracks.length, 1);
  assert.equal(e.tracks.length, 2);

  e.push(concatBytes(sectionToPackets(PMT_PID, buildPMT(
    { pcrPid: VIDEO_PID, streams: [{ streamType: 0x1b, pid: 0x0101 }] }, 1,
  ))));
  assert.ok(!e.streams.has(0x0102), '流表清理');
  assert.equal(ev.tracks.length, 2, '换版（含仅移除）应重发 tracks 事件');
  assert.equal(e.tracks.length, 1, 'this.tracks 应刷新');
});

test('多节目分账：PMT_A 换版只重建自己的流，PMT_B 不受影响', () => {
  resetCc();
  const A = 0x0101, B = 0x0201, PMT_A = 0x1000, PMT_B = 0x1001;
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([
      { number: 1, pid: PMT_A },
      { number: 2, pid: PMT_B },
    ])),
    ...sectionToPackets(PMT_A, buildPMT({ pcrPid: A, streams: [{ streamType: 0x1b, pid: A }] })),
    ...sectionToPackets(PMT_B, buildPMT({ pcrPid: B, streams: [{ streamType: 0x24, pid: B }] })),
  ];
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(packets));
  assert.equal(e.tracks.length, 2);

  e.push(concatBytes(sectionToPackets(PMT_A, buildPMT(
    { pcrPid: 0x0103, streams: [{ streamType: 0x0f, pid: 0x0103 }] }, 1,
  ))));
  assert.equal(e.tracks.length, 2, 'PMT_A 换版后仍两轨');
  assert.ok(!e.streams.has(A), 'PMT_A 旧 ES 应移除');
  assert.ok(e.streams.has(B), 'PMT_B 的 ES 不得被误删');
  assert.equal(e.streams.get(0x0103).codec, 'aac');
  assert.equal(e.pmtVersions.get(PMT_B), 0, 'PMT_B 版本记账不受影响');
  assert.equal(ev.errors.length, 0);
});

/* ------------------------------ 粘包 ------------------------------ */

test('同包双 section 粘包：仅 pointer_field 指向的首节生效，次节待下一个 PUSI', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat1 = buildPAT([{ number: 1, pid: PMT_PID }]);
  const pat2 = buildPAT([{ number: 2, pid: 0x1001 }]);
  const payload = concatBytes([new Uint8Array([0]), pat1, pat2]);
  e._parsePacket(mkPacket({ pid: 0x0000, pusi: true, cc: 0, payload }));
  assert.equal(e.programNumber, 1, '仅首节生效');
  assert.ok(e.pmtPids.has(PMT_PID));
  assert.ok(!e.pmtPids.has(0x1001), '第二节被丢弃');

  e._parsePacket(psiCell(0x0000, pat2, { cc: 1 }));
  assert.equal(e.programNumber, 2, '新 PUSI 后第二节生效');
  assert.ok(e.pmtPids.has(0x1001));
  assert.equal(ev.errors.length, 0);
});
