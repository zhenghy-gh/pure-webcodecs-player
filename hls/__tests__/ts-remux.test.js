/**
 * TS → fMP4 转封装单测
 *
 * 两层验证：
 *  1) 纯结构层：用合成样本直接驱动内部 box 构造器（不依赖 ts/ 模块，恒可运行）；
 *  2) 集成层：真实经 TsDemuxer 走全链路。ts/ 模块由 media-dev 并行开发中，
 *     若其尚未产出样本则跳过集成断言（模块就绪后自动恢复完整校验）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTS } from '../../samples/fixtures/ts.js';
import { assembleTs } from '../../ts/__tests__/fixtures/build-ts.mjs';
import { TsToFmp4Transmuxer, sniffContainer } from '../src/transmuxer.js';
import { _internalForTest } from '../src/fmp4-muxer.js';
import { Fmp4Remuxer } from '../../mp4/src/remuxer.js';

/* ---------- 测试用最小 box 遍历器 ---------- */

function readBoxType(buf, off) {
  return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
}
function topLevelBoxes(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let off = 0;
  while (off < buf.length) {
    let size = dv.getUint32(off);
    if (size === 0) size = buf.length - off;
    assert.ok(size >= 8, `box 尺寸非法: ${size}@${off}`);
    out.push({ type: readBoxType(buf, off), size, offset: off });
    off += size;
  }
  return out;
}

/** 在字节流中查找四字符 tag（box 类型）出现的绝对偏移 */
function findTag(buf, tag) {
  const t = [...tag].map((c) => c.charCodeAt(0));
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === t[0] && buf[i + 1] === t[1] && buf[i + 2] === t[2] && buf[i + 3] === t[3]) {
      return i;
    }
  }
  return -1;
}

const CONTAINER = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'mvex', 'traf', 'edts', 'udta']);

/** 递归查找首个指定 type 的 box 尺寸（用于对齐 mp4 标准产物） */
function findBoxSize(buf, tag) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  function walk(off, end) {
    let p = off;
    while (p + 8 <= end) {
      const size = dv.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      if (type === tag) return size;
      if (size < 8) break;
      if (CONTAINER.has(type)) { const r = walk(p + 8, p + size); if (r) return r; }
      p += size;
    }
    return 0;
  }
  return walk(0, buf.length);
}

/** 解析 media segment：累加 trun 声明的样本 size，对比 mdat 实际数据长度 */
function analyzeMedia(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = topLevelBoxes(buf);
  const mdat = top.find((b) => b.type === 'mdat');
  const moof = top.find((b) => b.type === 'moof');
  assert.ok(mdat, 'media 段应含顶层 mdat');
  assert.ok(moof, 'media 段应含顶层 moof');
  const mdatPayload = mdat.size - 8; // 顶层 box 精确定位，避免视频数据区内巧合匹配 'mdat'
  // trun 位于 moof 范围内（数据区不会误匹配）
  let trunPos = -1;
  for (let i = moof.offset; i + 4 <= moof.offset + moof.size; i++) {
    if (buf[i] === 0x74 && buf[i + 1] === 0x72 && buf[i + 2] === 0x75 && buf[i + 3] === 0x6e) { trunPos = i; break; }
  }
  assert.ok(trunPos > 0, 'moof 内应含 trun');
  const sampleCount = dv.getUint32(trunPos + 8);
  let sum = 0;
  for (let k = 0; k < sampleCount; k++) {
    sum += dv.getUint32(trunPos + 16 + k * 16 + 4); // row: dur(4)+size(4)+flags(4)+cts(4)
  }
  return { sumSize: sum, mdatPayload };
}

/* ================================================================== */
/* 1) 纯结构层：合成样本（H.264 假 SPS + 帧数据）                        */
/* ================================================================== */

const FAKE_AVC_C = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50,
  0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
]);

function videoTrak() {
  return {
    id: 1,
    type: 'video',
    codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: FAKE_AVC_C },
    width: 320,
    height: 240,
    timescale: 90000,
  };
}

test('结构层：init segment = ftyp + moov(mvex/trex/stsd)', () => {
  const init = _internalForTest.buildInit([videoTrak()]);
  assert.equal(sniffContainer(init), 'fmp4');
  const top = topLevelBoxes(init);
  assert.deepEqual(
    top.map((b) => b.type),
    ['ftyp', 'moov']
  );
  for (const tag of ['mvhd', 'trak', 'mvex', 'trex', 'stsd', 'avc1', 'avcC']) {
    assert.ok(findTag(init, tag) > 0, `init 中应含 ${tag}`);
  }
});

test('结构层：视频分片 = styp + moof(mfhd/traf/tfhd/tfdt/trun) + mdat 且 dataOffset 精确', () => {
  const frames = [
    { dts: 0, pts: 0, duration: 3000, keyframe: true, data: new Uint8Array(64).fill(1) },
    { dts: 3000, pts: 3000, duration: 3000, keyframe: false, data: new Uint8Array(40).fill(2) },
    { dts: 6000, pts: 6000, duration: 3000, keyframe: false, data: new Uint8Array(52).fill(3) },
  ];
  const frag = _internalForTest.buildFragment({ trackId: 1, samples: frames, hasCts: true });
  assert.equal(sniffContainer(frag), 'fmp4');
  const top = topLevelBoxes(frag);
  assert.deepEqual(
    top.map((b) => b.type),
    ['styp', 'moof', 'mdat']
  );
  for (const tag of ['mfhd', 'traf', 'tfhd', 'tfdt', 'trun']) {
    assert.ok(findTag(frag, tag) > 0, `分片中应含 ${tag}`);
  }

  // trun.dataOffset 必须精确指向 mdat 数据起点相对 moof 的偏移
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  const moofStart = top[1].offset;
  const mdatStart = top[2].offset;
  const trunTagPos = findTag(frag, 'trun'); // 指向 type 字段
  const trunHead = trunTagPos - 4; // fullbox 的 version+flags 在 type 前 4 字节
  void trunHead;
  // trun: [size][type][verFlags][sampleCount][dataOffset][rows...]
  const sampleCount = dv.getUint32(trunTagPos + 8); // 越过 version/flags(4)
  const dataOffset = dv.getUint32(trunTagPos + 12);
  assert.equal(sampleCount, 3);
  assert.equal(dataOffset, mdatStart + 8 - moofStart, 'dataOffset 应等于 mdat 数据区相对 moof 起点偏移');

  // mdat 数据长度 == 样本字节和
  const mdatDataLen = top[2].size - 8;
  assert.equal(mdatDataLen, 64 + 40 + 52);

  // tfdt v1 baseMediaDecodeTime == 首 DTS
  const tfdtPos = findTag(frag, 'tfdt');
  const baseTime = Number(dv.getBigUint64(tfdtPos + 8)); // 越过 version/flags
  assert.equal(baseTime, 0);
});

test('结构层：音频分片无 cts 字段且 esds init 可构造', () => {
  const { buildEsds, buildInit, buildAudioFragment } = _internalForTest;
  const asc = new Uint8Array([0x12, 0x10]); // AOT=2 LC, 44.1kHz 双声道典型值
  const esds = buildEsds(asc);
  assert.equal(String.fromCharCode(esds[4], esds[5], esds[6], esds[7]), 'esds');

  const init = buildInit([
    {
      id: 2,
      type: 'audio',
      codec: 'mp4a.40.2',
      description: { tag: 'esds', bytes: asc },
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    },
  ]);
  assert.ok(findTag(init, 'mp4a') > 0);

  const frames = [
    { dts: 0, pts: 0, duration: 1024, keyframe: true, data: new Uint8Array(16).fill(7) },
    { dts: 1024, pts: 1024, duration: 1024, keyframe: true, data: new Uint8Array(16).fill(8) },
  ];
  const frag = buildAudioFragment(2, 44100, frames);
  const top = topLevelBoxes(frag);
  assert.deepEqual(
    top.map((b) => b.type),
    ['styp', 'moof', 'mdat']
  );
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  const dataOffset = dv.getUint32(findTag(frag, 'trun') + 12); // 越过 version/flags
  assert.equal(dataOffset, top[2].offset + 8 - top[1].offset);
});

/* ================================================================== */
/* 1b) 防回归：对齐 mp4 标准产物的精确不变量（I 系列收尾根因）          */
/* ================================================================== */

test('结构层：init 的 stsd 与 mp4 Fmp4Remuxer 标准等长（VisualSampleEntry 头不漏 pre_defined[3]）', () => {
  const init = _internalForTest.buildInit([videoTrak()]);
  // mp4 标准 init 作为对照（M44 真机验证通过）
  const mp4Init = new Fmp4Remuxer().createInitSegment({
    ...videoTrak(),
    sampleEntryType: 'avc1',
    description: videoTrak().description.bytes,
  });
  const hlsStsd = findBoxSize(init, 'stsd');
  const mp4Stsd = findBoxSize(mp4Init, 'stsd');
  assert.ok(hlsStsd > 0 && mp4Stsd > 0, 'stsd 应存在');
  assert.equal(
    hlsStsd,
    mp4Stsd,
    `hls init 的 stsd(${hlsStsd}) 必须与 mp4 标准 init 的 stsd(${mp4Stsd}) 等长；` +
      'VisualSampleEntry 头部漏写 pre_defined[3]（8 字节）会导致 avc1 错位、Chrome 拒收 init'
  );
});

test('集成：remux 视频分片 Σ trun sample size == mdat 实际数据长度', async (t) => {
  const bytes = assembleTs({ video: { codec: 'h264', width: 320, height: 240, frames: 6, gopSize: 3 } });
  const out = await remuxOrSkip(t, bytes);
  if (!out) return;

  const m = out.video.mediaSegment;
  const { sumSize, mdatPayload } = analyzeMedia(m);
  assert.equal(
    sumSize,
    mdatPayload,
    `trun 声明的样本大小之和(${sumSize})必须等于 mdat 实际数据长度(${mdatPayload})；` +
      '否则 Chrome 会以 size 不匹配拒收整段 media segment（avcc 转换后长度必须回填给 size）'
  );
});

/* ================================================================== */
/* 2) 集成层：TsDemuxer 全链路（ts/ 就绪前自动跳过）                     */
/* ================================================================== */

/** ts/ 模块当前是否已能产出样本（未就绪则跳过集成断言） */
async function remuxOrSkip(t, tsBytes) {
  const muxer = new TsToFmp4Transmuxer();
  const out = await muxer.remux(tsBytes);
  if (!out.video && !out.audio) {
    t.skip('ts/ 模块 TsDemuxer 尚未产出样本（media-dev 开发中），集成断言延后');
    return null;
  }
  return out;
}

test('集成：sniffContainer 识别生成的 TS 流', (t) => {
  const { bytes } = makeTS({ auCount: 2 });
  assert.equal(sniffContainer(bytes), 'ts');
  void remuxOrSkip; // 引用保持；实际使用在下方异步测试
});

test('集成：remux 产出视频 init+fragment', async (t) => {
  // assembleTs 含真实 SPS/PPS 参数集（makeTS 的哑 NALU 无法产出 avcC）
  const bytes = assembleTs({ video: { codec: 'h264', width: 320, height: 240, frames: 6, gopSize: 3 } });
  const out = await remuxOrSkip(t, bytes);
  if (!out) return;

  assert.match(out.codecs.video, /^avc1\.[0-9a-fA-F]{6}$/);
  assert.ok(out.video.initSegment, '首分片必须带 initSegment');
  assert.ok(topLevelBoxes(out.video.mediaSegment).every((b) => b.size >= 8));

  // AVCC 化：mdat 数据不应以 AnnexB 起始码开头
  const frag = out.video.mediaSegment;
  const mdatTop = topLevelBoxes(frag).pop();
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  const firstNaluLen = dv.getUint32(mdatTop.offset + 8);
  assert.ok(firstNaluLen < mdatTop.size, '首 NALU 长度前缀应合理（AVCC 形态）');
});

test('集成：AAC 音轨独立产出且编码串来自 ASC AOT', async (t) => {
  const bytes = assembleTs({
    video: { codec: 'h264', width: 320, height: 240, frames: 4, gopSize: 2 },
    audio: { mode: 'adts', count: 4 },
  });
  const out = await remuxOrSkip(t, bytes);
  if (!out) return;

  assert.ok(out.audio, '应有音频轨输出');
  assert.match(out.codecs.audio, /^mp4a\.40\.\d+$/);
  assert.ok(out.audio.initSegment);
  assert.ok(findTag(out.audio.initSegment, 'esds') > 0);
});

test('集成：跨分片 tfdt 不倒退 & init 只出一次', async (t) => {
  const seg1bytes = assembleTs({ video: { codec: 'h264', width: 320, height: 240, frames: 6, gopSize: 3 } });
  const seg2bytes = assembleTs({ video: { codec: 'h264', width: 320, height: 240, frames: 6, gopSize: 3 } });
  const muxer = new TsToFmp4Transmuxer();
  const out1 = await muxer.remux(seg1bytes);
  const out2 = await muxer.remux(seg2bytes);
  if (!out1.video || !out2.video) {
    t.skip('ts/ 模块 TsDemuxer 尚未产出样本（media-dev 开发中），集成断言延后');
    return;
  }
  assert.ok(out1.video.initSegment);
  assert.equal(out2.video.initSegment, null, '配置未变化时不再重复 init');

  const dv = new DataView(out2.video.mediaSegment.buffer, out2.video.mediaSegment.byteOffset, out2.video.mediaSegment.byteLength);
  const base2 = Number(dv.getBigUint64(findTag(out2.video.mediaSegment, 'tfdt') + 8));
  const dv1 = new DataView(out1.video.mediaSegment.buffer, out1.video.mediaSegment.byteOffset, out1.video.mediaSegment.byteLength);
  const base1 = Number(dv1.getBigUint64(findTag(out1.video.mediaSegment, 'tfdt') + 8));
  assert.ok(base2 >= base1, 'tfdt 不允许倒退');
});
