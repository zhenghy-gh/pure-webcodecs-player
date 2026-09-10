/**
 * ts-pes-assembly.test.js —— PES 重组深水区（引擎级，TsStreamEngine）
 *
 * 覆盖点：
 *   - 跨多 TS 包的 PES 完整组装 → sample 事件载荷字段（trackId/codec/pts/dts/keyframe/format/data）
 *   - PES header_data_length 可变（> PTS/DTS 所需字节的 optional 头跳过）
 *   - PTS/DTS 三种前缀形态：'0011' 双时间戳 / '0010' 仅 PTS / '0000' 无时间戳
 *   - 33bit 回绕：跨回绕样本时间戳连续化（unwrapTimestamp 在引擎输出边界生效）
 *   - PES_packet_length=0（视频不限长）：下一个 PUSI 边界才出帧 + flush 兜底
 *   - stream_id 兜底分类：无 PMT codec 时 video id → h264，audio id → 丢弃
 *   - 中途加入（无 PUSI 载荷）被忽略，直到下一个 PUSI
 *   - PES 重组缓冲超限：告警 + 丢弃重来，后续 PUSI 恢复
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeTimestamp5 } from '../src/pes.js';
import {
  buildPes, dataToPackets, h264Sps, h264Pps, h264IdrSlice, h264NonIdrSlice, annexb, resetCc,
} from './fixtures/build-ts.mjs';
import {
  concatBytes, mkEngine, attachCollector, mkPacket, makeProgram, VIDEO_PID,
} from './ts-testkit.mjs';

/** 自定义 PES 构造：可控 declaredLength 与 optional 头字节（header_data_length > 8） */
function buildPesRaw(streamId, es, { pts = null, dts = null, declared = null, extraHeader = null } = {}) {
  const hasPts = pts != null;
  const hasDts = dts != null;
  const flags1 = hasPts ? (hasDts ? 0xc0 : 0x80) : 0x00;
  const parts = [];
  if (hasPts) parts.push(encodeTimestamp5(pts, hasDts ? 0b0011 : 0b0010));
  if (hasDts) parts.push(encodeTimestamp5(dts, 0b0001));
  if (extraHeader) parts.push(extraHeader);
  const headerData = concatBytes(parts);
  const bodyLen = 3 + headerData.length + es.length;
  const declaredLen = declared != null ? declared : (bodyLen <= 0xffff ? bodyLen : 0);
  const head = new Uint8Array([
    0, 0, 1, streamId, (declaredLen >> 8) & 0xff, declaredLen & 0xff, 0x80, flags1, headerData.length,
  ]);
  return concatBytes([head, headerData, es]);
}

/** 依次 push 若干字节块并 flush，返回 { engine, ev } */
function runChunks(chunks) {
  const e = mkEngine();
  const ev = attachCollector(e);
  for (const c of chunks) e.push(c);
  e.flush();
  return { e, ev };
}

/* ------------------------------ 跨包组装与 sample 字段 ------------------------------ */

test('跨包 PES 组装：sample 事件字段完整（trackId/codec/pts/dts/keyframe/format）', () => {
  const pes1 = buildPes(0xe0, annexb(h264Sps(320, 240), h264Pps(), h264IdrSlice()), { pts: 90000, dts: 89000 });
  const pes2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120000, dts: 119000 });
  const { e, ev } = runChunks([
    concatBytes(makeProgram()),
    concatBytes(dataToPackets(VIDEO_PID, pes1)),   // PES 头+ES 跨多包
    concatBytes(dataToPackets(VIDEO_PID, pes2)),
  ]);
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.samples.length, 2);
  const s0 = ev.samples[0];
  const s1 = ev.samples[1];
  assert.equal(s0.trackId, VIDEO_PID);
  assert.equal(s0.type, 'video');
  assert.equal(s0.codec, 'h264');
  assert.equal(s0.pts, 1_000_000, '90000 ticks @90kHz → 1e6 µs');
  assert.equal(s0.dts, Math.round(89000 * 1e6 / 90000), 'dts 与 pts 独立换算');
  assert.equal(s0.keyframe, true, 'IDR 切片 → keyframe');
  assert.equal(s0.format, 'annexb');
  assert.equal(s0.duration, null, '视频 duration 由消费端计算');
  assert.ok(s0.data instanceof Uint8Array && s0.data.byteLength > 0);
  assert.equal(s1.keyframe, false);
  assert.equal(s1.pts, Math.round(120000 * 1e6 / 90000));
  // SPS/PPS 触发轨道参数回填
  const vTrack = e.tracks.find((t) => t.id === VIDEO_PID);
  assert.equal(vTrack.width, 320);
  assert.equal(vTrack.height, 240);
});

test('PES header_data_length 可变：optional 头字节（>PTS/DTS）被正确跳过', () => {
  const es = annexb(h264IdrSlice());
  const extra = new Uint8Array(9).fill(0x77);   // 模拟 ESCR(6)+ES_rate(3) 等 optional 字段
  const pes = buildPesRaw(0xe0, es, { pts: 45000, extraHeader: extra });
  assert.equal(pes[8], 14, 'header_data_length 应为 5+9=14');
  const { ev } = runChunks([
    concatBytes(makeProgram()),
    concatBytes(dataToPackets(VIDEO_PID, pes)),
  ]);
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.samples.length, 1);
  assert.equal(ev.samples[0].pts, 500000, 'PTS 在 optional 头之前，应正确解码');
  assert.equal(ev.samples[0].data.byteLength, es.length, '载荷应恰好从 9+14 处开始');
});

/* ------------------------------ 时间戳前缀形态与回绕 ------------------------------ */

test('PTS/DTS 前缀三形态：0011 双时间戳 / 0010 仅 PTS / 0000 无时间戳', () => {
  const es = annexb(h264IdrSlice());

  // '0011'：PTS+DTS 双时间戳，各自独立换算
  {
    const pes = buildPes(0xe0, es, { pts: 90000, dts: 87000 });
    const { ev } = runChunks([concatBytes(makeProgram()), concatBytes(dataToPackets(VIDEO_PID, pes))]);
    assert.equal(ev.samples[0].pts, 1_000_000);
    assert.equal(ev.samples[0].dts, Math.round(87000 * 1e6 / 90000), '87000 ticks → 966667µs');
    assert.ok(ev.samples[0].pts > ev.samples[0].dts);
  }
  // '0010'：仅 PTS → dts 缺省等同 pts
  {
    const pes = buildPes(0xe0, es, { pts: 90000 });
    const { ev } = runChunks([concatBytes(makeProgram()), concatBytes(dataToPackets(VIDEO_PID, pes))]);
    assert.equal(ev.samples[0].pts, 1_000_000);
    assert.equal(ev.samples[0].dts, 1_000_000, '无 DTS 时 dts=pts');
  }
  // '0000'：无时间戳 → 输出 0（不崩溃、不丢弃）
  {
    const pes = buildPesRaw(0xe0, es, {});
    const { ev } = runChunks([concatBytes(makeProgram()), concatBytes(dataToPackets(VIDEO_PID, pes))]);
    assert.equal(ev.samples.length, 1);
    assert.equal(ev.samples[0].pts, 0);
    assert.equal(ev.samples[0].dts, 0);
  }
});

test('33bit 回绕：PTS/DTS 跨回绕后连续化（解到下一圈）', () => {
  const WRAP = 2 ** 33;
  const pes1 = buildPes(0xe0, annexb(h264IdrSlice()), { pts: WRAP - 3000, dts: WRAP - 3000 });
  const pes2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 3000, dts: 3000 });
  const { ev } = runChunks([
    concatBytes(makeProgram()),
    concatBytes(dataToPackets(VIDEO_PID, pes1)),
    concatBytes(dataToPackets(VIDEO_PID, pes2)),
  ]);
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.samples.length, 2);
  assert.equal(ev.samples[0].pts, Math.round((WRAP - 3000) * 1e6 / 90000));
  assert.equal(
    ev.samples[1].pts,
    Math.round((WRAP + 3000) * 1e6 / 90000),
    '回绕后 PTS 应解到下一圈（连续时间轴）',
  );
  assert.equal(ev.samples[1].dts, Math.round((WRAP + 3000) * 1e6 / 90000));
  assert.ok(ev.samples[1].pts > ev.samples[0].pts, '跨回绕后时间戳保持单调');
});

/* ------------------------------ declaredLength=0 与边界 ------------------------------ */

test('PES_packet_length=0（视频不限长）：PUSI 边界出上一帧，flush 兜底出末帧', () => {
  resetCc();
  const pes1 = buildPesRaw(0xe0, annexb(h264IdrSlice(400)), { pts: 90000, declared: 0 });
  const pes2 = buildPes(0xe0, annexb(h264NonIdrSlice()), { pts: 120000 });
  const p1 = dataToPackets(VIDEO_PID, pes1);
  assert.ok(p1.length >= 2, '测试前提：首帧 PES 应跨多包');
  const e = mkEngine();
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  e.push(p1[0]);
  assert.equal(ev.samples.length, 0, 'declared=0 时首包不得提前出样本');
  e.push(concatBytes([...p1.slice(1), ...dataToPackets(VIDEO_PID, pes2)]));
  assert.equal(ev.samples.length, 2, '第二个 PUSI 结束不限长 PES（帧1），PES2 自身完整（帧2）');
  assert.equal(ev.samples[0].pts, 1_000_000, '帧1 在 PUSI 边界被冲出');
  e.flush();
  assert.equal(ev.samples.length, 2, 'flush 不再新增');
  assert.equal(ev.samples[1].pts, Math.round(120000 * 1e6 / 90000));
});

test('中途加入：无 PUSI 的载荷被忽略（等待下一个 PUSI）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e.streams.set(VIDEO_PID, { codec: 'h264' });
  e._ensureTrackState(VIDEO_PID, 0x1b, 'h264');
  // 前一 PES 的中部残片（无 PUSI）：重组缓冲不存在 → 忽略
  e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: false, cc: 0, payload: new Uint8Array(184).fill(0xaa) }));
  assert.equal(ev.samples.length, 0);
  assert.equal(e.pesChunks.get(VIDEO_PID), undefined, '不得凭空建立重组缓冲');
  // 随后的完整 PES（PUSI）正常出样本
  const pes = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 });
  e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, cc: 1, payload: pes }));
  assert.equal(ev.samples.length, 1);
  assert.equal(ev.samples[0].pts, 1_000_000);
});

test('stream_id 兜底：无 PMT codec 时 video id → h264，audio id → 丢弃', () => {
  // audio stream_id(0xc0) 且无 codec → 丢弃（私有/未知音频不出样本）
  {
    const e = mkEngine();
    const ev = attachCollector(e);
    e.streams.set(VIDEO_PID, { codec: undefined });
    e._ensureTrackState(VIDEO_PID, 0x0f, 'aac');
    const pes = buildPes(0xc0, annexb(h264IdrSlice()), { pts: 90000 });
    e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, cc: 0, payload: pes }));
    assert.equal(ev.samples.length, 0, 'audio stream_id 无 codec 应回退丢弃');
    assert.equal(ev.errors.length, 0);
  }
  // video stream_id(0xe0) 且无 codec → 兜底 h264 出样本
  {
    const e = mkEngine();
    const ev = attachCollector(e);
    e.streams.set(VIDEO_PID, { codec: undefined });
    e._ensureTrackState(VIDEO_PID, 0x1b, 'h264');
    const pes = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000 });
    e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, cc: 0, payload: pes }));
    assert.equal(ev.samples.length, 1, 'video stream_id 应兜底为 h264');
    assert.equal(ev.samples[0].codec, 'h264');
  }
});

test('PES 重组缓冲超限：告警并丢弃重来，后续 PUSI 恢复', () => {
  resetCc();
  const e = mkEngine();
  e.maxPesBufferBytes = 500;
  const ev = attachCollector(e);
  e.push(concatBytes(makeProgram()));
  const big = buildPesRaw(0xe0, annexb(h264IdrSlice(1200)), { pts: 90000, declared: 0 });
  e.push(concatBytes(dataToPackets(VIDEO_PID, big)));
  assert.equal(ev.samples.length, 0, '超限 PES 不得出样本');
  assert.ok(ev.warns.some((w) => w.includes('PES 重组缓冲超过')), '应发出超限告警');
  const small = buildPes(0xe0, annexb(h264IdrSlice()), { pts: 200000 });
  e.push(concatBytes(dataToPackets(VIDEO_PID, small)));
  e.flush();
  assert.equal(ev.samples.length, 1, '恢复后仅完整小 PES 出样本');
  assert.equal(ev.samples[0].pts, Math.round(200000 * 1e6 / 90000));
  assert.equal(ev.errors.length, 0);
});
