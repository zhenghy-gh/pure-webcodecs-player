/**
 * ts 边界与容错补充单测（补量单素材：PES 边界 / Section 粘断 / TEI / 加扰 / 多节目）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTsDemuxer } from '../src/ts-demuxer.js';
import { TsStreamEngine } from '../src/ts-stream-engine.js';
import { PsiAssembler, parsePAT } from '../src/psi.js';
import { unwrapTimestamp } from '../src/bits.js';
import { MemoryDataSource } from '../../core/src/index.js';

import {
  resetCc, buildPAT, buildPMT, sectionToPackets, buildPes,
  dataToPackets, tsPacket, h264IdrSlice, h264NonIdrSlice, annexb,
} from './fixtures/build-ts.mjs';

const VIDEO_PID = 0x0101;
const PMT_PID = 0x1000;

function concatBytes(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

function makeProgram(extraStreams = []) {
  resetCc();
  return [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({
      pcrPid: VIDEO_PID,
      streams: [{ streamType: 0x1b, pid: VIDEO_PID }, ...extraStreams],
    })),
  ];
}

test('PES 边界：declaredLength 对齐包尾（提前出帧路径命中）', async () => {
  const es = h264IdrSlice(160);
  const pes = buildPes(0xe0, es, { pts: 90_000, dts: 90_000 });
  const padded = new Uint8Array([...pes, 0xff]);   // 补一字节使长度跨过整包边界组合
  const packets = [
    ...makeProgram(),
    ...dataToPackets(VIDEO_PID, padded),
    ...dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120_000 })),
  ];
  const d = await createTsDemuxer(new Uint8Array(concatBytes(packets)));
  const v = [];
  for await (const s of d.samples(d.tracks[0].id)) v.push(s.timestamp);
  assert.equal(v.length, 2);
  assert.equal(v[0], 1_000_000);                                   // 90000 ticks
  assert.equal(v[1], Math.round((120_000 * 1e6) / 90_000));        // 120000 ticks
  await d.destroy();
});

test('PES 边界：无 PTS/DTS 时样本以 0 时间戳输出且不崩溃', async () => {
  // flags=0x00：无 PTS 无 DTS；header_data_length=0
  const head = new Uint8Array([0, 0, 1, 0xe0, 0, 0, 0x80, 0x00, 0]);
  const pes = new Uint8Array([...head, ...annexb(h264IdrSlice())]);
  const packets = [...makeProgram(), ...dataToPackets(VIDEO_PID, pes)];
  const d = await createTsDemuxer(new Uint8Array(concatBytes(packets)));
  const s = await d.readSample(d.tracks[0].id);
  assert.ok(s, '应产出样本');
  assert.equal(s.timestamp, 0);
  assert.equal(s.dts, 0);
  await d.destroy();
});

test('PsiAssembler：pointer_field 非零时正确跳过上一节残余', async () => {
  const pat = buildPAT([{ number: 1, pid: 0x1000 }]);
  // pointer_field 字节在前、值为 3 → 跳过其后 3 字节残余才是 section 起点
  const payload = new Uint8Array([3, 0xaa, 0xbb, 0xcc, ...pat]);
  const received = [];
  const asm = new PsiAssembler((pid, sec) => received.push({ pid, sec }));
  asm.feed(0x0000, payload, true);
  assert.equal(received.length, 1, '应重组出完整 section');
  assert.equal(received[0].sec[0], 0x00);                          // table_id = PAT
  const parsed = parsePAT(received[0].sec);
  assert.deepEqual(parsed.programs, [{ number: 1, pid: 0x1000 }]);
});

test('多节目 PAT：两套 PMT 并存、轨道按 PID 区分', async () => {
  resetCc();
  const A = 0x0101, B = 0x0201, PMT_A = 0x1000, PMT_B = 0x1001;
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([
      { number: 1, pid: PMT_A },
      { number: 2, pid: PMT_B },
    ])),
    ...sectionToPackets(PMT_A, buildPMT({ pcrPid: A, streams: [{ streamType: 0x1b, pid: A }] })),
    ...sectionToPackets(PMT_B, buildPMT({ pcrPid: B, streams: [{ streamType: 0x24, pid: B }] })),
    ...dataToPackets(A, buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 })),
    ...dataToPackets(B, buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 90000 })),
  ];
  const d = await createTsDemuxer(new Uint8Array(concatBytes(packets)));
  assert.equal(d.tracks.length, 2, '两套节目的轨道并存');
  const codecs = d.tracks.map((t) => t.codec).sort();
  assert.ok(codecs[0].startsWith('avc1') || codecs[0].startsWith('hvc1'));
  assert.ok(codecs[1].startsWith('hvc1') || codecs[1].startsWith('avc1'));
  await d.destroy();
});

test('TEI 置位包被丢弃并计入诊断；加扰包被跳过', async () => {
  resetCc();
  const f1 = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90_000 });
  const f2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120_000 });
  const blob = new Uint8Array(concatBytes([
    ...makeProgram(),
    ...dataToPackets(VIDEO_PID, f1),
    ...dataToPackets(VIDEO_PID, f2),
  ]));

  // 第一个视频包置位 TEI → 帧1 整体丢失，帧2 应存活
  for (let off = 0; off + 188 <= blob.length; off += 188) {
    const pid = ((blob[off + 1] & 0x1f) << 8) | blob[off + 2];
    if (pid === VIDEO_PID && (blob[off + 1] & 0x40)) {
      blob[off + 1] |= 0x80;
      break;
    }
  }
  // 追加一个加扰包（scrambling=2）
  const scrambled = new Uint8Array(188);
  scrambled[0] = 0x47;
  scrambled[1] = (VIDEO_PID >> 8) & 0x1f;
  scrambled[2] = VIDEO_PID & 0xff;
  scrambled[3] = 0x80 | 0x10;                    // scrambling=2 + payload present

  const d = await createTsDemuxer(new Uint8Array([...blob, ...scrambled]));
  const snap = d.engine.psiSnapshot();
  assert.ok(snap.ccErrors >= 1, 'TEI 丢包应计入诊断');
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) n++;
  assert.equal(n, 1, '仅未被破坏的帧产出');
  await d.destroy();
});

test('AF-only 包（无载荷）不参与重组也不崩溃，CC 规则生效', async () => {
  resetCc();
  const good = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90_000 });
  const base = concatBytes([...makeProgram(), ...dataToPackets(VIDEO_PID, good)]);
  // 纯 AF 包：afControl=0b10（有 AF 无载荷）
  const afOnly = new Uint8Array(188);
  afOnly[0] = 0x47;
  afOnly[1] = (VIDEO_PID >> 8) & 0x1f;
  afOnly[2] = VIDEO_PID & 0xff;
  afOnly[3] = 0x20;                              // AF-only，CC 由构造器计数
  afOnly[4] = 183;
  afOnly[5] = 0x00;
  for (let i = 6; i < 188; i++) afOnly[i] = 0xff;

  const d = await createTsDemuxer(new Uint8Array([...base, ...afOnly]));
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) n++;
  assert.equal(n, 1);
  await d.destroy();
});

test('unwrapTimestamp：跨回绕连续多帧序列保持单调', () => {
  const WRAP = 2 ** 33;
  const seq = [];
  let last = null;
  for (const raw of [WRAP - 6000, WRAP - 3000, 0, 3000]) {
    last = unwrapTimestamp(raw % WRAP, last);
    seq.push(last);
  }
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1], `应单调: ${seq.join(',')}`);
  }
});

/* ---------------- 188/192 误锁自愈（罕见边界） ---------------- */

/** 同一 CC 序列下的完整流分段：program + 3 个视频 PES（可交错插入垃圾） */
function buildTsParts() {
  resetCc();
  return {
    program: makeProgram(),
    p0: dataToPackets(VIDEO_PID, buildPes(0xe0, h264IdrSlice(160), { pts: 90_000, dts: 90_000 })),
    p1: dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120_000 })),
    p2: dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 150_000 })),
  };
}

function buildRealTs() {
  const { program, p0, p1, p2 } = buildTsParts();
  return concatBytes([...program, ...p0, ...p1, ...p2]);
}

function driveEngine(bytes) {
  const e = new TsStreamEngine();
  const seen = { samples: 0, tracks: 0, warns: [] };
  e.on('sample', () => seen.samples++);
  e.on('tracks', () => seen.tracks++);
  e.on('warn', (err) => seen.warns.push(err.message));
  e.push(bytes);
  e.flush();
  return { e, seen };
}

test('192 步长三同步巧合误锁后：连续失步超阈值触发重探测自愈（188 流样本全出）', () => {
  // 首窗垃圾 0/192/384 三处 0x47 构成 192 步长三同步巧合 → 引擎必误锁 192；
  // 垃圾长 1300B > 4×192 阈值，误锁后滑动在垃圾区内即触发重置重探
  const garbage = new Uint8Array(1300).fill(0xa5);
  garbage[0] = 0x47; garbage[192] = 0x47; garbage[384] = 0x47;
  const real = buildRealTs();                         // 3 个视频 PES
  const { e, seen } = driveEngine(concatBytes([garbage, real]));

  assert.equal(e.resyncs, 1, '应恰好重探测一次后锁定真格式');
  assert.equal(e.packetSize, 188, '应自愈重锁 188');
  assert.equal(e.syncOffsetInCell, 0);
  assert.equal(seen.tracks, 1, 'PAT/PMT 应被解析出');
  assert.equal(seen.samples, 3, '误锁垃圾损失后真流样本应全出');
});

test('短暂失步（单包垃圾 188B < 4×188 阈值）滑动恢复，不触发重探测', () => {
  // 垃圾插在 p0 与 p1 之间：双校验会连累 p0 尾包被滑掉（引擎固有语义，损失邻近帧），
  // 但滑动仅 188B < 752 阈值 → 不得触发重探测、不得脱锁，后续 PES 恢复解析
  const { program, p0, p1, p2 } = buildTsParts();
  const noise = new Uint8Array(188).fill(0xa5);      // 整包颗粒垃圾（无 0x47，纯滑动）
  const { e, seen } = driveEngine(concatBytes([...program, ...p0, noise, ...p1, ...p2]));

  assert.equal(e.resyncs, 0, '短垃圾只滑动不重置');
  assert.equal(e.packetSize, 188, '不得脱锁');
  assert.equal(seen.samples, 2, 'p0 帧损失后 p1/p2 应恢复解析');
});

test('流式分块喂入（任意切块跨包）不触发重探测', () => {
  const bytes = buildRealTs();
  const e = new TsStreamEngine();
  let samples = 0;
  e.on('sample', () => samples++);
  for (let off = 0; off < bytes.length; off += 137) {  // 非 188/192 倍数的切块
    e.push(bytes.subarray(off, Math.min(off + 137, bytes.length)));
  }
  e.flush();
  assert.equal(e.resyncs, 0, '常规分块失步 ≤ 单包长，不触发重探测');
  assert.equal(e.packetSize, 188);
  assert.equal(samples, 3);
});
