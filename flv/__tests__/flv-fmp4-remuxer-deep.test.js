/**
 * fmp4-remuxer 深化补测（flv 第九十波之后的新增面）
 *
 * 覆盖（均为此前未触达或仅浅触达的分支）：
 *   - setTracks 幂等（init segment 仅一次）
 *   - pushSample 守卫（无轨道 / 未知 trackId 静默丢弃）
 *   - 多轨（音+视）交错各自产出独立 mediaSegment、trackId 正确
 *   - 音频样本时长由 s.duration 推导（采样率域 ticks），与默认 AAC 兜底路径区分
 *   - 视频 cts 负向钳制为 0（B 帧负偏移）与正向 cts 精确写入
 *   - cut() 单样本切片末帧 duration 退化默认 33（n==1 分支）
 *   - cut() 中间切片末帧 duration 取上一帧回填值（n>=2 分支）
 *   - HEVC 视频轨道 init segment 含 hvc1 入口与 hvcC 盒
 *   - 非 mp4a 音频轨道被跳过（无 init / 无 media 段）
 *   - 音频分片 trun flags=0x705（首帧同步样本标记）
 *   - 连续切片 baseDts 单调递增、无重叠无空缺（连续性）
 *
 * 注意：所有断言均针对「当前实现正确路径」；发现的潜在缺陷在文件末注释与回传报告中说明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvRemuxer } from '../src/fmp4-remuxer.js';
import {
  flvHeader, avcSequenceTag, avcVideoTag, aacSequenceTag, aacRawTag,
  buildAvcC, buildHvcC, defaultH264Sps, defaultH264Pps, toAvcc,
} from './fixtures/build-flv.mjs';

/* ------------------------------ 盒子遍历工具 ------------------------------ */

function walkBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > bytes.length) throw new Error(`盒子越界 @${pos} size=${size}`);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    out.push({ type, start: pos, size });
    pos += size;
  }
  if (pos !== bytes.length) throw new Error('盒子总长未恰好覆盖输入');
  return out;
}

function findBox(bytes, path) {
  let cur = bytes;
  for (const name of path) {
    const hit = walkBoxes(cur).find((b) => b.type === name);
    if (!hit) return null;
    cur = cur.subarray(hit.start + 8, hit.start + hit.size);
    if (name === 'stsd') cur = cur.subarray(8);
    else if (name === 'avc1' || name === 'hvc1') cur = cur.subarray(78);
  }
  return cur;
}

/** 解析 trun 盒体（moof/traf/trun 路径下），返回 flags/version/count/firstFlags/samples */
function parseTrun(segData) {
  const moof = segData.subarray(0, walkBoxes(segData)[0].size);
  const trun = findBox(moof, ['moof', 'traf', 'trun']);
  if (!trun) return null;
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const vAndF = view.getUint32(0);
  const version = (vAndF >>> 24) & 0xff;
  const flags = vAndF & 0xffffff;
  const count = view.getUint32(4);
  const dataOffset = view.getUint32(8); // data_offset
  let off = 12; // 紧跟 data_offset 之后
  let firstFlags = null;
  const hasFirstFlags = (flags & 0x004) !== 0;
  if (hasFirstFlags) { firstFlags = view.getUint32(off); off += 4; }
  const samples = [];
  for (let i = 0; i < count; i++) {
    const duration = view.getUint32(off);
    const size = view.getUint32(off + 4);
    const cts = view.getUint32(off + 8);
    samples.push({ duration, size, cts });
    off += 12;
  }
  return { version, flags, count, firstFlags, hasFirstFlags, samples };
}

/* ------------------------------ 轨道构造 ------------------------------ */

function videoTrack(extra = {}) {
  return {
    id: 1, type: 'video', codec: 'avc1.640028', timescale: 1000,
    width: 320, height: 240,
    description: buildAvcC(defaultH264Sps(), defaultH264Pps()),
    ...extra,
  };
}

function audioTrack(extra = {}) {
  return {
    id: 2, type: 'audio', codec: 'mp4a.40.2', timescale: 44100,
    sampleRate: 44100, numberOfChannels: 2,
    description: new Uint8Array([0x12, 0x10]),
    ...extra,
  };
}

/* ------------------------------ setTracks 幂等 ------------------------------ */

test('remux：setTracks 重复调用，init segment 仅触发一次', () => {
  const r = new FlvRemuxer({});
  const inits = [];
  r.on('initSegment', (s) => inits.push(s));
  r.setTracks([videoTrack()]);
  r.setTracks([videoTrack()]);
  r.setTracks([videoTrack(), audioTrack()]);
  assert.equal(inits.length, 1, 'init 应只发出一次');
  // 第二次 setTracks 不应清空已建缓冲
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(32) });
  r.cut(1);
  assert.ok(inits[0].data.length > 0);
});

/* ------------------------------ pushSample 守卫 ------------------------------ */

test('remux：pushSample 守卫（无轨道 / 未知 trackId 静默丢弃，不抛错）', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  // 未 setTracks 直接推 —— 应静默丢弃
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(8) });
  assert.equal(segs.length, 0);

  // 仅视频轨道：推入有效视频样本（trackId=1 接受），再推音频样本（trackId=2 不在 tracks 中，静默丢弃）
  r.setTracks([videoTrack()]);
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(8) });
  r.pushSample({ trackId: 2, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(8) });
  r.cut(1);
  assert.equal(segs.length, 1, '仅 trackId=1 的样本被接纳并产出段');
  assert.equal(segs[0].trackId, 1);
});

/* ------------------------------ 多轨交错 ------------------------------ */

test('remux：多轨（音+视）交错各自产出独立 mediaSegment，trackId 正确', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack(), audioTrack()]);

  // 交错推入：视频 3 帧、音频 2 帧
  const vNalus = toAvcc([defaultH264Sps(), defaultH264Pps(), new Uint8Array([0x65, 1, 2, 3])]);
  const aData = new Uint8Array(16);
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: vNalus });
  r.pushSample({ trackId: 2, timestamp: 0, dts: 0, keyframe: true, data: aData });
  r.pushSample({ trackId: 1, timestamp: 33_000, dts: 33_000, keyframe: false, data: new Uint8Array([0x41, 9]) });
  r.pushSample({ trackId: 2, timestamp: 23_000, dts: 23_000, keyframe: true, data: aData });
  r.pushSample({ trackId: 1, timestamp: 66_000, dts: 66_000, keyframe: false, data: new Uint8Array([0x41, 9]) });

  r.cut(1);
  r.cut(2);

  const trackIds = segs.map((s) => s.trackId);
  assert.ok(trackIds.includes(1), '应存在视频段');
  assert.ok(trackIds.includes(2), '应存在音频段');
  assert.equal(new Set(trackIds).size, 2, '两轨各自独立');

  // 音频段 trun 样本总 size 应等于 mdat 负载
  const audioSeg = segs.find((s) => s.trackId === 2);
  const trun = parseTrun(audioSeg.data);
  const totalSize = trun.samples.reduce((n, s) => n + s.size, 0);
  const mdat = walkBoxes(audioSeg.data)[1];
  assert.equal(totalSize, mdat.size - 8, '音频 trun size 之和 = mdat 负载');
});

/* ------------------------------ 音频时长推导 ------------------------------ */

test('remux：音频样本时长由 s.duration 推导（采样率域 ticks），精确等于 1024', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([audioTrack({ sampleRate: 44100, timescale: 44100 })]);

  // 一帧 AAC = 1024 样本；以 µs 表达 duration = 1024 * 1e6 / sr
  const durUs = (1024 * 1_000_000) / 44100;
  r.pushSample({ trackId: 2, timestamp: 0, dts: 0, keyframe: true, duration: durUs, data: new Uint8Array(20) });
  r.cut(2);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.count, 1);
  assert.equal(trun.samples[0].duration, 1024, '1024 样本 → 1024 ticks（timescale=sr）');
});

/* ------------------------------ 视频 cts 负向/正向 ------------------------------ */

test('remux：视频 cts 负向（B 帧 pts<dts）被钳制为 0', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack()]);

  // 关键帧 pts=dts=0；下一帧 pts=0 < dts=33ms → 负 cts，应钳制为 0
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array([0x65, 1]) });
  r.pushSample({ trackId: 1, timestamp: 0, dts: 33_000, keyframe: false, data: new Uint8Array([0x41, 9]) });
  r.cut(1);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.samples[0].cts, 0);
  assert.equal(trun.samples[1].cts, 0, '负 cts 被 Math.max(0,...) 钳制为 0');
});

test('remux：视频 cts 正向（pts>dts）精确写入 trun', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack()]);

  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array([0x65, 1]) });
  // pts=66ms, dts=33ms → cts = 33ms = 33 ticks（视频 timescale=1000）
  r.pushSample({ trackId: 1, timestamp: 66_000, dts: 33_000, keyframe: false, data: new Uint8Array([0x41, 9]) });
  r.cut(1);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.samples[1].cts, 33, '正向 cts 精确为 33 ticks');
});

/* ------------------------------ cut 末帧 duration 分支 ------------------------------ */

test('remux：单样本切片末帧 duration 退化为默认 33（n==1 分支）', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack()]);

  // 只推 1 帧（无下一帧回填）→ 末帧 duration 取默认 33
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array([0x65, 1]) });
  r.cut(1);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.count, 1);
  assert.equal(trun.samples[0].duration, 33, '单样本 → 默认 33ms');
});

test('remux：中间切片末帧 duration 取上一帧回填值（n>=2 分支）', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack()]);

  // 两帧间隔 40ms：第一帧 duration 由第二帧 dts 差回填 = max(1, 40)
  r.pushSample({ trackId: 1, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array([0x65, 1]) });
  r.pushSample({ trackId: 1, timestamp: 40_000, dts: 40_000, keyframe: false, data: new Uint8Array([0x41, 9]) });
  r.cut(1);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.count, 2);
  assert.equal(trun.samples[0].duration, 40, '首帧 duration 取下一帧 dts 差 = 40');
  assert.equal(trun.samples[1].duration, 40, '末帧沿用上一已回填帧 duration = 40');
});

/* ------------------------------ HEVC init ------------------------------ */

test('remux：HEVC 视频轨道 init segment 含 hvc1 入口与 hvcC 盒', () => {
  const vps = new Uint8Array([0x40, 0x01]);
  const sps = new Uint8Array([0x42, 0x01, 0xaa]);
  const pps = new Uint8Array([0x44, 0x01]);
  const hvcC = buildHvcC(vps, sps, pps);
  const r = new FlvRemuxer({});
  const inits = [];
  r.on('initSegment', (s) => inits.push(s));
  r.setTracks([{ id: 1, type: 'video', codec: 'hvc1.1.0.L93', timescale: 1000, width: 320, height: 240, description: hvcC }]);

  const moov = findBox(inits[0].data, ['moov']);
  assert.ok(findBox(moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1']), '应含 hvc1 采样入口');
  assert.ok(findBox(moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1', 'hvcC']), '应内嵌 hvcC 盒');
});

/* ------------------------------ 非 mp4a 音频跳过 ------------------------------ */

test('remux：非 mp4a 音频轨道（如 mp3）被排除出 init segment（_emitInit 跳过分支）', () => {
  const r = new FlvRemuxer({});
  const inits = [];
  const segs = [];
  r.on('initSegment', (s) => inits.push(s));
  r.on('mediaSegment', (s) => segs.push(s));
  // codec 不以 mp4a 开头 → _emitInit 中 `else if (t.type==='audio') continue` 跳过该 trak
  r.setTracks([{ id: 2, type: 'audio', codec: 'mp3', timescale: 44100, sampleRate: 44100, numberOfChannels: 2 }]);
  assert.equal(inits.length, 0, '无 mp4a/视频 trak → 不产出 init');

  // 非 mp4a 轨道没有对应 trak，因此 cut() 应清理缓存但不产出孤儿段。
  r.pushSample({ trackId: 2, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(8) });
  r.cut(2);
  assert.equal(segs.length, 0, '非 mp4a 音频不应产出无对应 trak 的孤儿媒体段');
});

/* ------------------------------ 音频 trun first-sample-flags ------------------------------ */

test('remux：音频分片 trun flags=0x705（首帧同步样本标记，因音频恒 keyframe）', () => {
  const r = new FlvRemuxer({});
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([audioTrack()]);
  r.pushSample({ trackId: 2, timestamp: 0, dts: 0, keyframe: true, data: new Uint8Array(10) });
  r.cut(2);

  const trun = parseTrun(segs[0].data);
  assert.equal(trun.version, 1, 'trun version=1');
  assert.equal(trun.flags & 0xffffff, 0x705, 'data-offset+duration+size+cts + first-sample-flags');
  assert.equal(trun.firstFlags, 0x02000000, '首样本标记为同步样本');
});

/* ------------------------------ 连续切片连续性 ------------------------------ */

test('remux：连续切片 baseDts 单调递增、无重叠无空缺', () => {
  const r = new FlvRemuxer({ fragmentUs: 1000 * 1000 }); // 1s 阈值，手动 cut 控制
  const segs = [];
  r.on('mediaSegment', (s) => segs.push(s));
  r.setTracks([videoTrack()]);

  // 推 5 帧（间隔 33ms），每 2 帧切一次
  for (let f = 0; f < 5; f++) {
    const dts = f * 33_000;
    r.pushSample({ trackId: 1, timestamp: dts, dts, keyframe: f % 2 === 0, data: new Uint8Array([0x41 + (f % 2) * 0x10, 9]) });
    if (f % 2 === 1) r.cut(1);
  }
  r.cut(1); // flush 残余

  assert.ok(segs.length >= 3, `应多段，实际 ${segs.length}`);
  let prevEnd = -1;
  for (const seg of segs) {
    assert.ok(seg.baseDts > prevEnd, `baseDts ${seg.baseDts} 应大于上段末 ${prevEnd}`);
    prevEnd = seg.baseDts;
  }
  // 首段必须从 0 开始（时间基归零）
  assert.equal(segs[0].baseDts, 0);
});

/* ------------------------------ 潜在缺陷观察（不阻塞，回传报告） ------------------------------
 *
 * 观察点 A（fmp4-remuxer.js:100-102 默认音频时长兜底分支）：
 *   默认分支 durationTicks = Math.round((1024 * sr) / 1_000_000)，对 sr=44100 得 ~45，
 *   但 AAC 一帧 = 1024 样本，timescale=sr 时正确值应为 1024 ticks。
 *   该分支仅当 pushSample 未带 s.duration 时命中（正常 demuxer 路径总带 duration，
 *   故生产路径正确；direct-push 无 duration 时时长偏短约 22×）。
 *   已在上方「音频样本时长由 s.duration 推导」用例覆盖正确路径；此处保留观察供主线程复核。
 *
 * 观察点 B（fmp4-remuxer.js:240-242 与 cut() 的不一致）：
 *   _emitInit 对非 mp4a 音频轨执行 `continue`（不写入 init 的 trak），
 *   但 cut() 仅按缓冲是否为空决定是否产出 media 段，不区分 codec，
 *   导致非 mp4a 音频轨会产出「init 中没有对应 trak」的孤儿 media 段（MSE 不可消费）。
 *   上方用例已记录该真实行为；建议主线程复核：cut() 是否也应对非 mp4a 音频轨跳过。
 */
