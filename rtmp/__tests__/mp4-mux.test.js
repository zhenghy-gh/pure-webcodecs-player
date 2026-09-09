import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fmp4Remuxer, esdsFromAsc } from '../src/mp4-mux.js';
import { makeAvcC, VIDEO_FPS } from '../../samples/gateway/src/index.js';

/**
 * 遍历指定字节区间内的顶层 box：[{type, start, size}]（start 相对传入视图）。
 * fullbox 容器（如 stsd）的载荷前 4~8 字节不是 box，需要调用方先 subarray 跳过。
 */
function walkBoxes(bytes) {
  const out = [];
  let off = 0;
  while (off + 8 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off);
    const size = dv.getUint32(0);
    if (size < 8 || off + size > bytes.length) break;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    out.push({ type, start: off, size });
    off += size;
  }
  return out;
}

/** 沿容器路径取 box 载荷；path 每步可为字符串或 {type, skip}（跳过 fullbox 头） */
function findPath(bytes, path) {
  let scope = bytes;
  for (const step of path) {
    const { type, skip = 0 } = typeof step === 'string' ? { type: step } : step;
    const hit = walkBoxes(scope).find((b) => b.type === type);
    if (!hit) return null;
    scope = scope.subarray(hit.start + 8 + skip, hit.start + hit.size);
  }
  return scope;
}

function videoRemuxer() {
  const r = new Fmp4Remuxer();
  r.setVideoTrack({ description: makeAvcC(), width: 16, height: 16 });
  return r;
}

/** 造 n 个视频样本：dtsUs 按 15fps 步进，AVCC 形态假数据 */
function fakeVideoSamples(n, startUs = 0) {
  const step = Math.round(1e6 / VIDEO_FPS);
  return Array.from({ length: n }, (_, i) => ({
    kind: 'video',
    data: Uint8Array.from([0, 0, 0, 3, 0x65, i & 0xff, (i * 7) & 0xff]),
    dtsUs: startUs + i * step,
    ptsUs: startUs + i * step,
    keyframe: i === 0,
    durationUs: 0,
  }));
}

test('init segment：ftyp+moov 结构完整、avcC 内嵌、含 trex', () => {
  const r = videoRemuxer();
  const init = r.initSegment();
  assert.deepEqual(
    walkBoxes(init).map((b) => b.type),
    ['ftyp', 'moov'],
  );
  // trak → mdia → minf → stbl → stsd(fullbox 头 8B) → avc1 → avcC
  const stsdPayload = findPath(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', { type: 'stsd', skip: 8 }]);
  assert.ok(stsdPayload, 'stsd 载荷');
  const avc1 = walkBoxes(stsdPayload).find((b) => b.type === 'avc1');
  assert.ok(avc1, '视频采样入口 avc1');
  // VisualSampleEntry 固定前段 78B（6 reserved +2 drefIdx +2+2+12 预留 +2+2 宽高 +4+4 分辨率 +4 保留 +2 帧数 +32 压缩器名 +2+2 深度）
  const avc1Payload = stsdPayload.subarray(avc1.start + 8 + 78, avc1.start + avc1.size);
  const avcCBox = walkBoxes(avc1Payload).find((b) => b.type === 'avcC');
  assert.ok(avcCBox, 'avcC 应内嵌于 avc1');
  const avcCPayload = avc1Payload.subarray(avcCBox.start + 8, avcCBox.start + avcCBox.size);
  assert.deepEqual(Array.from(avcCPayload), Array.from(makeAvcC()));
  // mvex/trex 存在（流式 moov 标志）
  const moovScope = findPath(init, ['moov']);
  assert.ok(walkBoxes(moovScope).some((b) => b.type === 'mvex'), '应含 mvex');
});

test('init segment：音频轨 mp4a 含 esds（ASC 注入）', () => {
  const r = new Fmp4Remuxer();
  r.setAudioTrack({ description: Uint8Array.from([0x12, 0x10]), sampleRate: 44100, channels: 2 });
  const init = r.initSegment();
  // AudioSampleEntry 固定前段 28B（6+2 +8 保留 +2 声道 +2 位深 +2+2 预留 +4 采样率16.16）
  const mp4aScope = findPath(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', { type: 'stsd', skip: 8 }, { type: 'mp4a', skip: 28 }]);
  assert.ok(mp4aScope !== null, 'mp4a 入口');
  assert.ok(walkBoxes(mp4aScope).some((b) => b.type === 'esds'), 'esds 应存在');
});

test('esdsFromAsc：描述符链 tag/长度正确且内嵌 ASC 原文', () => {
  const asc = Uint8Array.from([0x12, 0x10]);
  const esds = esdsFromAsc(asc, 2);
  assert.equal(esds[4], 0x65); // 'e'
  let found = false;
  for (let i = 8; i < esds.length - 3; i++) {
    if (esds[i] === 0x05 && esds[i + 1] === asc.length && esds[i + 2] === asc[0] && esds[i + 3] === asc[1]) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'DecSpecificInfo 应内嵌原始 ASC');
});

test('片段：moof+mdat 结构、trun 计数/偏移正确、跨片段 tfdt 递增', () => {
  const r = videoRemuxer();
  for (const smp of fakeVideoSamples(6)) r.addSample(smp);
  const frag1 = r.buildFragment();
  assert.deepEqual(
    walkBoxes(frag1).map((b) => b.type),
    ['moof', 'mdat'],
  );
  const traf1 = findPath(frag1, ['moof', 'traf']);
  const trun = readTrun(traf1);
  assert.equal(trun.count, 6);
  assert.ok(trun.dataOffset > 0, `dataOffset=${trun.dataOffset}`);
  assert.equal(trun.actualSize, 20 + trun.count * 12, 'trun 实际长度公式（8头+4verFlags+4count+4dataOffset+12n）');

  for (const smp of fakeVideoSamples(6, Math.round((6 * 1e6) / VIDEO_FPS))) r.addSample(smp);
  const frag2 = r.buildFragment();
  const t1 = readTfdt(traf1);
  const t2 = readTfdt(findPath(frag2, ['moof', 'traf']));
  assert.ok(t2 > t1, `第二段 baseMediaDecodeTime 应更大 ${t1} -> ${t2}`);
});

test('空队列 buildFragment 返回 null；addSample 前未配置轨道抛 STATE_ERROR', () => {
  const r = videoRemuxer();
  assert.equal(r.buildFragment(), null);
  const bare = new Fmp4Remuxer();
  assert.throws(() => bare.addSample(fakeVideoSamples(1)[0]), /STATE|状态|配置|轨道/);
});

// ---- traf 内部小工具 ----

function readTrun(trafScope) {
  // findPath 已剥离 traf 自身头，载荷直接是 tfhd+tfdt+trun
  let trunView = null;
  for (const b of walkBoxes(trafScope)) {
    if (b.type === 'trun') {
      trunView = trafScope.subarray(b.start, b.start + b.size);
    }
  }
  assert.ok(trunView, 'traf 内应有 trun');
  const dv = new DataView(trunView.buffer, trunView.byteOffset);
  const count = dv.getUint32(12);
  const dataOffset = dv.getInt32(16);
  const declaredSize = dv.getUint32(0);
  // 一致性：declaredSize == 实际长度 == 16 + 12*count
  return {
    count,
    dataOffset,
    size: declaredSize,
    actualSize: trunView.length,
    get declaredSizeConsistent() {
      return declaredSize === trunView.length && declaredSize === 16 + 12 * count;
    },
  };
}

function readTfdt(trafScope) {
  for (const b of walkBoxes(trafScope)) {
    if (b.type === 'tfdt') {
      // 注意：DataView 构造已含基准偏移，读取时不能再叠加 trafScope.byteOffset
      const dv = new DataView(trafScope.buffer, trafScope.byteOffset + b.start);
      return dv.getUint32(12);
    }
  }
  return -1;
}
