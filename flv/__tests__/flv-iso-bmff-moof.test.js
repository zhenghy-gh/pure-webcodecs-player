/**
 * iso-bmff.js 媒体分片与 ES_Descriptor 单测
 * 覆盖：esdsBox 描述符树（短长度 / expandable 长度）、moofBox（mfhd/tfhd/tfdt/trun、
 *       关键帧 first_sample_flags 分支、cts 无符号化）、mdatBox、
 *       「构造 → 遍历解析」往返字节一致性（data_offset 占位约定）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes, box, esdsBox, moofBox, mdatBox } from '../src/iso-bmff.js';

function typeAt(bytes, pos) {
  return String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
}

/** 遍历字节流中的顶层盒子（含 size/type/子区起点） */
function walk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos);
    assert.ok(size >= 8 && pos + size <= bytes.length, `盒子越界 @${pos} size=${size}`);
    out.push({ type: typeAt(bytes, pos), size, start: pos });
    pos += size;
  }
  assert.equal(pos, bytes.length, '盒子总长应恰好覆盖输入');
  return out;
}

/** 按 [m, f, t, ...] 路径下钻，返回目标盒的盒体（version/flags 起） */
function drill(bytes, path) {
  let cur = bytes;
  for (const name of path) {
    const hit = walk(cur).find((b) => b.type === name);
    assert.ok(hit, `路径 ${path.join('/')} 缺少 ${name}`);
    cur = cur.subarray(hit.start + 8, hit.start + hit.size);
  }
  return cur;
}

/* --------------------------------- esds --------------------------------- */

test('esdsBox：ES(0x03)→DecoderConfig(0x04)→DSI(0x05)+SL(0x06) 描述符树与短长度编码', () => {
  const asc = Uint8Array.from([0x12, 0x10]);
  const e = esdsBox(asc);
  assert.equal(e[8], 0, 'esds version=0');
  assert.deepEqual([...e.subarray(9, 12)], [0, 0, 0], 'flags=0');

  const es = e.subarray(12);                       // ES_Descriptor 起
  assert.equal(es[0], 0x03, 'tag=ES_DescrTag');
  assert.equal(es[1], es.length - 2, '短长度=后续字节数');
  assert.deepEqual([...es.subarray(2, 4)], [0x00, 0x01], 'ES_ID=1');
  assert.equal(es[4], 0x00, 'flags=0');

  const dc = es.subarray(5);
  assert.equal(dc[0], 0x04, 'tag=DecoderConfigDescrTag');
  assert.equal(dc[1], 17, '短长度 = 13 固定字段 + DSI(tag+len+2字节 ASC)');
  assert.equal(dc[2], 0x40, 'objectTypeIndication=MPEG-4 AAC');
  assert.equal(dc[3], 0x15, 'streamType(audio)<<2|up|reserved');
  assert.deepEqual([...dc.subarray(4, 7)], [0, 0, 0], 'bufferSizeDB');
  assert.deepEqual([...dc.subarray(7, 15)], new Array(8).fill(0), 'max/avgBitrate=0');

  const dsi = dc.subarray(15);
  assert.equal(dsi[0], 0x05, 'tag=DecSpecificInfoTag');
  assert.equal(dsi[1], asc.length, 'DSI 长度=ASC 字节数');
  assert.deepEqual([...dsi.subarray(2, 2 + asc.length)], [...asc], 'ASC 原样');
  // 若 ascend 存在则核对（本实现总是内嵌）
  const rest = dsi.subarray(2 + asc.length);
  if (rest.length > 0) {
    assert.equal(rest[0], 0x06, 'tag=SLConfigDescrTag');
    assert.equal(rest[1], 1);
    assert.equal(rest[2], 0x02, 'SL predefined=2');
  } else {
    assert.fail('缺少 SLConfigDescriptor');
  }
});

test('esdsBox：ASC ≥128 字节时描述符采用 4 字节 expandable 长度编码', () => {
  const asc = Uint8Array.from({ length: 200 }, (_, i) => i & 0x7f);
  const e = esdsBox(asc);
  // ES 描述符（tag 起，expandable 头共 5 字节）
  const es = e.subarray(12);
  assert.equal(es[0], 0x03);
  assert.deepEqual([...es.subarray(1, 5)], [0x80, 0x80, 0x81, 0x65], '229 = 0x81<<7 | 0x65');
  const esLen = ((es[1] & 0x7f) << 21) | ((es[2] & 0x7f) << 14) | ((es[3] & 0x7f) << 7) | (es[4] & 0x7f);
  assert.equal(esLen, es.length - 5, 'expandable 长度展开后等于载荷');

  // 跳过 ES_ID(2)+flags(1) 到 DC 描述符
  const dc = es.subarray(8);
  assert.equal(dc[0], 0x04);
  assert.deepEqual([...dc.subarray(1, 5)], [0x80, 0x80, 0x81, 0x5a], '218 = 0x81<<7 | 0x5a');
  const dcLen = ((dc[1] & 0x7f) << 21) | ((dc[2] & 0x7f) << 14) | ((dc[3] & 0x7f) << 7) | (dc[4] & 0x7f);
  assert.equal(dcLen, 13 + 5 + asc.length, 'DC 载荷 = 13 固定 + DSI(tag+4 长度字节+ASC)');

  // 跳过 tag+4 长度字节+13 固定字段到 DSI 描述符
  const dsi = dc.subarray(18);
  assert.equal(dsi[0], 0x05);
  assert.deepEqual([...dsi.subarray(1, 5)], [0x80, 0x80, 0x81, 0x48], '200 = 0x81<<7 | 0x48');
  const dsiLen = ((dsi[1] & 0x7f) << 21) | ((dsi[2] & 0x7f) << 14) | ((dsi[3] & 0x7f) << 7) | (dsi[4] & 0x7f);
  assert.equal(dsiLen, asc.length);
  assert.deepEqual([...dsi.subarray(5, 9)], [...asc.subarray(0, 4)], 'ASC 前 4 字节');
  // DSI 之后是 SLConfigDescriptor
  const sl = dsi.subarray(5 + asc.length);
  assert.equal(sl[0], 0x06);
  assert.equal(sl[1], 1);
  assert.equal(sl[2], 0x02, 'SL predefined=2');
});

/* --------------------------------- moof --------------------------------- */

function trunView(moof) {
  const trun = drill(moof, ['moof', 'traf', 'trun']);
  return new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
}

test('moofBox：非关键帧首样本 → trun flags=0x701、无 first_sample_flags', () => {
  const moof = moofBox({
    seqNo: 7,
    trackId: 1,
    baseDts: 1234,
    samples: [
      { duration: 33, size: 100, cts: 5, keyframe: false },
      { duration: 33, size: 120, cts: 0, keyframe: false },
    ],
  });
  const view = trunView(moof);
  const vAndF = view.getUint32(0);
  assert.equal((vAndF >>> 24) & 0xff, 1, 'trun version=1');
  assert.equal(vAndF & 0xffffff, 0x701, 'data-offset+duration+size+cts，无 first-sample-flags');
  assert.equal(view.getUint32(4), 2, 'sample_count=2');
  assert.equal(view.getUint32(8), 0, 'data_offset 占位为 0（remuxer 回填）');
  // 样本表从偏移 12 直接开始：duration,size,cts × 2
  assert.equal(view.getUint32(12), 33);
  assert.equal(view.getUint32(16), 100);
  assert.equal(view.getUint32(20), 5);
  assert.equal(view.getUint32(24), 33);
  assert.equal(view.getUint32(28), 120);
  assert.equal(view.getUint32(32), 0);
});

test('moofBox：关键帧首样本 → flags|0x004 且 first_sample_flags=0x02000000', () => {
  const moof = moofBox({
    seqNo: 1,
    trackId: 1,
    baseDts: 0,
    samples: [{ duration: 40, size: 50, keyframe: true }],
  });
  const view = trunView(moof);
  assert.equal(view.getUint32(0) & 0xffffff, 0x705, '0x701|0x004');
  assert.equal(view.getUint32(8), 0, 'data_offset 占位');
  assert.equal(view.getUint32(12), 0x02000000, 'first_sample_flags: depends_on=2');
  assert.equal(view.getUint32(16), 40, '首样本 duration');
  assert.equal(view.getUint32(20), 50, '首样本 size');
  assert.equal(view.getUint32(24), 0, 'cts 缺省 0');
});

test('moofBox：mfhd 序号、tfhd flags 与字段、tfdt v1 基准时间', () => {
  const moof = moofBox({
    seqNo: 42,
    trackId: 2,
    baseDts: 88200,
    samples: [{ duration: 1024, size: 10, keyframe: true }],
  });
  const mfhd = drill(moof, ['moof', 'mfhd']);
  const mfhdView = new DataView(mfhd.buffer, mfhd.byteOffset, mfhd.byteLength);
  assert.equal(mfhdView.getUint32(4), 42, 'sequence_number');

  const tfhd = drill(moof, ['moof', 'traf', 'tfhd']);
  const tfhdView = new DataView(tfhd.buffer, tfhd.byteOffset, tfhd.byteLength);
  assert.equal(tfhdView.getUint32(0) & 0xffffff, 0x020002, 'default-base-is-moof|sample-description-index');
  assert.equal(tfhdView.getUint32(4), 2, 'track_id');
  assert.equal(tfhdView.getUint32(8), 1, 'sample_description_index=1');

  const tfdt = drill(moof, ['moof', 'traf', 'tfdt']);
  const tfdtView = new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.byteLength);
  assert.equal((tfdtView.getUint32(0) >>> 24) & 0xff, 1, 'tfdt version=1');
  assert.equal(tfdtView.getUint32(4), 88200, 'baseMediaDecodeTime');

  // traf 子盒顺序固定：tfhd → tfdt → trun
  const trafBody = drill(moof, ['moof', 'traf']);
  assert.deepEqual(walk(trafBody).map((b) => b.type), ['tfhd', 'tfdt', 'trun']);
});

test('moofBox：cts 无符号化（>>>0）保持大值字节一致', () => {
  const moof = moofBox({
    seqNo: 1, trackId: 1, baseDts: 0,
    samples: [{ duration: 1, size: 1, cts: 0xffffff01, keyframe: false }],
  });
  const view = trunView(moof);
  assert.equal(view.getUint32(20), 0xffffff01 >>> 0, 'cts 按无符号 32 位写入');
});

/* --------------------------------- mdat --------------------------------- */

test('mdatBox：size=8+payload、payload 字节原样、空负载得 8 字节', () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  const m = mdatBox(payload);
  assert.equal(m.length, 13);
  assert.equal(asciiType(m), 'mdat');
  assert.deepEqual([...m.subarray(8)], [...payload]);

  const empty = mdatBox(new Uint8Array(0));
  assert.equal(empty.length, 8);
  assert.equal(new DataView(empty.buffer).getUint32(0), 8, 'size=8');
});

function asciiType(bytes) {
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
}

/* ---------------------------- 构造→解析 往返 ---------------------------- */

test('往返：moof+mdat 拼接后逐层解析，尺寸闭合、moof 长度即 data_offset 依据', () => {
  const samples = [
    { duration: 33, size: 10, cts: 0, keyframe: true },
    { duration: 34, size: 20, cts: 1, keyframe: false },
    { duration: 33, size: 30, cts: 2, keyframe: false },
  ];
  const payload = concatBytes(samples.map((s) => Uint8Array.from({ length: s.size }, (_, i) => i)));
  const moof = moofBox({ seqNo: 3, trackId: 1, baseDts: 66, samples });
  const mdat = mdatBox(payload);
  const seg = concatBytes([moof, mdat]);

  const top = walk(seg);
  assert.deepEqual(top.map((b) => b.type), ['moof', 'mdat']);
  assert.equal(top[0].size + top[1].size, seg.length, '顶层闭合');

  // mdat 账目：trun 各样本 size 之和 = mdat 负载
  const trun = drill(seg, ['moof', 'traf', 'trun']);
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const flags = view.getUint32(0) & 0xffffff;
  const count = view.getUint32(4);
  let off = (flags & 0x004) ? 16 : 12;   // 头 12 + data_offset 8 + first_flags?
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += view.getUint32(off + 4);
    off += 12;                            // duration+size+cts（flags=0x70x 恒含三字段）
  }
  assert.equal(total, 60, 'trun size 之和');
  assert.equal(top[1].size - 8, 60, 'mdat 负载长度');
  // remuxer 的回填公式：data_offset = moof.length + 8（mdat 头）
  assert.equal(top[0].size + 8, moof.length + 8);
  // seg 中 trun data_offset 占位仍为 0（由 patchDataOffset 回填）
  assert.equal(view.getUint32(8), 0);
});

test('moofBox：空样本数组抛出 TypeError（约束：cut() 已保证非空）', () => {
  assert.throws(() => moofBox({ seqNo: 1, trackId: 1, baseDts: 0, samples: [] }), TypeError);
});
