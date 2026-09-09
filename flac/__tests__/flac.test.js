/**
 * flac/__tests__/flac.test.js — FLAC 解析与解码核心单测（node --test）
 * ------------------------------------------------------------
 * fixture 策略：测试内实现一个**迷你 FLAC 编码器**（仅覆盖测试所需子集），
 * 程序化生成合法流；解码结果与编码输入做精确往返断言。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FlacDemuxer,
  FlacDecoder,
  parseMetadata,
  parseFrameHeader,
  findSync,
  BitWriter,
  crc8,
  crc16,
  createFlacPlayer,
  isFlacPlaybackSupported,
} from '../src/index.js';

/* ============================================================
 * 迷你编码器（fixture 用）
 * ============================================================ */

/** UTF-8 式编码数写入（spec §9.1.6，fixture 只需 1~3 字节场景） */
function writeUtfCodedNumber(w, v) {
  if (v < 0x80) {
    w.writeBits(v, 8);
  } else if (v < 0x800) {
    w.writeBits(0xc0 | (v >> 6), 8);
    w.writeBits(0x80 | (v & 0x3f), 8);
  } else if (v < 0x10000) {
    w.writeBits(0xe0 | (v >> 12), 8);
    w.writeBits(0x80 | ((v >> 6) & 0x3f), 8);
    w.writeBits(0x80 | (v & 0x3f), 8);
  } else {
    throw new Error('fixture 编码器只支持 ≤ 2 字节的编码数');
  }
}

/**
 * 编码帧头。返回 BitWriter（调用方继续写子帧）。
 * @param {{blockSize:number, blockingStrategy?:number, sampleRateCode?:number,
 *          channelAssign?:number, sampleSizeCode?:number, codedNumber?:number}} o
 */
function encodeFrameHeader(o) {
  const w = new BitWriter();
  const blockSizeCode = o.blockSizeCode ?? 6;      // get8+1
  const sampleRateCode = o.sampleRateCode ?? 10;   // 48000
  const channelAssign = o.channelAssign ?? 0;      // 单声道
  const sampleSizeCode = o.sampleSizeCode ?? 4;    // 16bps
  const codedNumber = o.codedNumber ?? 0;

  w.writeBits(0b11111111111110, 14)
    .writeBits(0, 1)
    .writeBits(o.blockingStrategy ?? 0, 1)
    .writeBits(blockSizeCode, 4)
    .writeBits(sampleRateCode, 4)
    .writeBits(channelAssign, 4)
    .writeBits(sampleSizeCode, 3)
    .writeBits(0, 1);
  writeUtfCodedNumber(w, codedNumber);
  if (blockSizeCode === 6) w.writeBits(o.blockSize - 1, 8);
  if (blockSizeCode === 7) w.writeBits(o.blockSize - 1, 16);
  return w;
}

/** 帧头收尾：对齐 + CRC-8 字节。返回当前已写字节快照。 */
function finalizeHeader(w) {
  w.alignToByte();
  const bytesSoFar = w.toUint8Array();
  const c = crc8(bytesSoFar);
  const w2 = new BitWriter();
  w2.writeBits(c, 8).alignToByte();
  return { headerBytes: concatBytes(bytesSoFar, w2.toUint8Array()) };
}

/** 残差编码：method 0（4 位参数）。分区按规范切分：blockSize>>order，
 *  第 0 分区扣除 predictorOrder 个 warmup。 */
function encodeResiduals(w, residuals, riceParam = 4, { partitionOrder = 0, blockSize, predictorOrder = 0 } = {}) {
  w.writeBits(0, 2);                 // method 00
  w.writeBits(partitionOrder, 4);
  const base = (blockSize ?? residuals.length) >> partitionOrder;
  let idx = 0;
  for (let p = 0; p < (1 << partitionOrder); p++) {
    w.writeBits(riceParam, 4);
    const n = p === 0 ? base - predictorOrder : base;
    for (let k = 0; k < n; k++, idx++) {
      if (riceParam === 15) {
        // 转义路径在 fixture 中未使用；保留占位说明
        throw new Error('fixture 编码器未实现转义残差');
      }
      const r = residuals[idx];
      const u = r < 0 ? -r * 2 - 1 : r * 2; // zigzag 正映射
      const q = Math.floor(u / (2 ** riceParam));
      const rem = u % (2 ** riceParam);
      for (let z = 0; z < q; z++) w.writeBits(0, 1);
      w.writeBits(1, 1);
      if (riceParam > 0) w.writeBits(rem, riceParam);
    }
  }
}

/** CONSTANT 子帧 */
function encodeConstantSubframe(w, value, bps, blockSize) {
  w.writeBits(0, 1).writeBits(0b000000, 6).writeBits(0, 1);
  w.writeBits(value < 0 ? value + (1 << bps) : value, bps);
  void blockSize;
}

/** VERBATIM 子帧；wasted>0 时样本须可被 2^wasted 整除，编码右移值 */
function encodeVerbatimSubframe(w, samples, bps, wasted = 0) {
  w.writeBits(0, 1).writeBits(0b000001, 6);
  if (wasted > 0) {
    w.writeBits(1, 1);
    for (let i = 0; i < wasted; i++) w.writeBits(0, 1);
    w.writeBits(1, 1);
  } else {
    w.writeBits(0, 1);
  }
  const effBps = bps - wasted;
  for (const s of samples) {
    const v = s / (2 ** wasted) | 0;
    w.writeBits(v < 0 ? v + (1 << effBps) : v, effBps);
  }
}

/** FIXED 预测子帧（warmup + 残差由外部给定） */
function encodeFixedSubframe(w, warmupAndRest, order, bps, riceOpt = {}) {
  w.writeBits(0, 1).writeBits(0b001000 | order, 6).writeBits(0, 1);
  for (let i = 0; i < order; i++) {
    const v = warmupAndRest[i];
    w.writeBits(v < 0 ? v + (1 << bps) : v, bps);
  }
  encodeResiduals(w, warmupAndRest.slice(order), riceOpt.riceParam ?? 4,
    { partitionOrder: riceOpt.partitionOrder ?? 0, blockSize: riceOpt.blockSize ?? warmupAndRest.length, predictorOrder: order });
}

/** LPC 子帧 */
function encodeLpcSubframe(w, samples, order, bps, precision, shift, coeffs, riceOpt = {}) {
  w.writeBits(0, 1).writeBits(0b100000 | (order - 1), 6).writeBits(0, 1);
  for (let i = 0; i < order; i++) {
    const v = samples[i];
    w.writeBits(v < 0 ? v + (1 << bps) : v, bps);
  }
  w.writeBits(precision - 1, 4);
  w.writeBits(shift, 5);
  for (const cf of coeffs.slice(0, order)) {
    w.writeBits(cf < 0 ? cf + (1 << precision) : cf, precision);
  }
  encodeResiduals(w, samples.slice(order), riceOpt.riceParam ?? 4,
    { partitionOrder: riceOpt.partitionOrder ?? 0, blockSize: riceOpt.blockSize ?? samples.length, predictorOrder: order });
}

/** 组帧：头 + 子帧位流 → 位级拼接 → 对齐 → CRC-16 */
function assembleFrame(headerBytes, ...subframeWriters) {
  const all = new BitWriter();
  for (const sw of subframeWriters) all.merge(sw); // 子帧间不按字节对齐！
  all.alignToByte();
  const payload = concatBytes(headerBytes, all.toUint8Array());
  const crc = crc16(payload);
  const tail = new Uint8Array([(crc >> 8) & 0xff, crc & 0xff]);
  return concatBytes(payload, tail);
}

function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** METADATA 块封装 */
function metaBlock(type, body, last) {
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | type;
  head[1] = (body.length >> 16) & 0xff;
  head[2] = (body.length >> 8) & 0xff;
  head[3] = body.length & 0xff;
  return concatBytes(head, body);
}

/** STREAMINFO 34 字节 */
function streamInfoBody({ minBS = 16, maxBS = 16, minFS = 0, maxFS = 0,
                          sampleRate = 48000, channels = 1, bps = 16, totalSamples = 0 }) {
  const b = new Uint8Array(34);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, minBS);
  dv.setUint16(2, maxBS);
  b[4] = (minFS >> 16) & 0xff; b[5] = (minFS >> 8) & 0xff; b[6] = minFS & 0xff;
  b[7] = (maxFS >> 16) & 0xff; b[8] = (maxFS >> 8) & 0xff; b[9] = maxFS & 0xff;
  // 字节 10..13 位打包（spec §8.2）：sampleRate(20) | channels-1(3) | bps-1(5)
  // 以字节 10 的 MSB 为起点 → u32 = SR<<12 | ch<<9 | bd<<4
  dv.setUint32(10, (sampleRate << 12) | ((channels - 1) << 9) | ((bps - 1) << 4));
  const tsHi = Math.floor(totalSamples / 2 ** 32);
  const tsLo = totalSamples >>> 0;
  b[13] = (b[13] & 0xf0) | (tsHi & 0x0f);   // 低 4 位为总样本数高位片段
  dv.setUint32(14, tsLo);
  // md5 全零
  return b;
}

/** VORBIS_COMMENT 块体 */
function vorbisCommentBody(vendor, entries) {
  const enc = new TextEncoder();
  const vb = enc.encode(vendor);
  /** @type {Uint8Array[]} */
  const parts = [];
  const lenPrefix = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  parts.push(lenPrefix(vb.length), vb, lenPrefix(entries.length));
  for (const [k, v] of entries) {
    const item = enc.encode(`${k}=${v}`);
    parts.push(lenPrefix(item.length), item);
  }
  return concatBytes(...parts);
}

/** 完整 FLAC 文件组装 */
function buildFlac({ streamInfo, extraBlocks = [], frames }) {
  const magic = new TextEncoder().encode('fLaC');
  const si = streamInfoBody(streamInfo);
  const blocks = [metaBlock(0, si, extraBlocks.length === 0)];
  extraBlocks.forEach((blk, i) => {
    blocks.push(metaBlock(blk.type, blk.body, i === extraBlocks.length - 1));
  });
  return concatBytes(magic, ...blocks, ...frames);
}

function memorySource(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) { return bytes.subarray(offset, offset + length); },
    async close() {},
  };
}

/* ============================================================
 * probe 与元数据解析
 * ============================================================ */

describe('FlacDemuxer.probe', () => {
  test('fLaC 魔数命中', () => {
    const r = FlacDemuxer.probe(buildFlac({ streamInfo: {}, frames: [] }));
    assert.ok(r && r.container === 'flac' && r.confidence >= 0.8);
  });
  test('非 FLAC 返回 null 不抛异常', () => {
    assert.equal(FlacDemuxer.probe(new TextEncoder().encode('RIFF____WAVE')), null);
    assert.equal(FlacDemuxer.probe(new Uint8Array(0)), null);
  });
});

describe('parseMetadata', () => {
  test('STREAMINFO 各字段正确还原', () => {
    const bytes = buildFlac({
      streamInfo: { sampleRate: 44100, channels: 2, bps: 24, totalSamples: 12345678 },
      frames: [],
    });
    const m = parseMetadata(bytes);
    assert.equal(m.streamInfo.sampleRate, 44100);
    assert.equal(m.streamInfo.channels, 2);
    assert.equal(m.streamInfo.bitsPerSample, 24);
    assert.equal(m.streamInfo.totalSamples, 12345678);
    assert.equal(m.blocks.length, 1);
    assert.equal(m.audioOffset, 4 + 4 + 34); // 魔数 + 块头 + SI
  });

  test('VORBIS_COMMENT 标签提取且块序正确（last-flag）', () => {
    const bytes = buildFlac({
      streamInfo: {},
      extraBlocks: [{ type: 4, body: vorbisCommentBody('test-vendor', [['TITLE', '无损测试'], ['ARTIST', 'ox']]) }],
      frames: [],
    });
    const m = parseMetadata(bytes);
    assert.equal(m.tags.TITLE, '无损测试');
    assert.equal(m.tags.ARTIST, 'ox');
    assert.deepEqual(m.blocks.map((b) => b.type), [0, 4]);
  });

  test('缺少 fLaC 魔数抛 PARSE_ERROR', () => {
    assert.throws(() => parseMetadata(new TextEncoder().encode('OggS')),(e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * 帧头
 * ============================================================ */

describe('frame-header', () => {
  test('同步码扫描命中真实帧位置', () => {
    const sub = new BitWriter();
    encodeVerbatimSubframe(sub, [1, -2, 3], 16);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 3 })).headerBytes, sub);
    const blob = concatBytes(new TextEncoder().encode('fLaC'), frame);
    assert.equal(findSync(blob, 0), 4);
    const { header } = parseFrameHeader(blob, 4);
    assert.equal(header.blockSize, 3);
    assert.equal(header.channels, 1);
    assert.equal(header.bitsPerSample, 16);
    assert.equal(header.sampleRate, 48000);
  });

  test('双字节 UTF-8 编码数（帧号 > 127）', () => {
    const sub = new BitWriter();
    encodeConstantSubframe(sub, 5, 16, 4);
    const frame = assembleFrame(
      finalizeHeader(encodeFrameHeader({ blockSize: 4, codedNumber: 300 })).headerBytes, sub);
    const blob = concatBytes(new TextEncoder().encode('fLaC'), frame);
    const syncAt = findSync(blob, 0);
    const { header } = parseFrameHeader(blob, syncAt);
    assert.equal(header.codedNumber, 300);
  });

  test('CRC-8 被篡改时报 PARSE_ERROR', () => {
    const sub = new BitWriter();
    encodeConstantSubframe(sub, 5, 16, 4);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 4 })).headerBytes, sub);
    const blob = new Uint8Array(concatBytes(new TextEncoder().encode('fLaC'), frame));
    const syncAt = findSync(blob, 0);
    // 找到帧头最后一个字节（CRC-8）：帧头长度未知前先正常解析一次
    const good = parseFrameHeader(blob, syncAt);
    blob[syncAt + good.header.headerBytes - 1] ^= 0xff;
    assert.throws(() => parseFrameHeader(blob, syncAt), (e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * 解码核心：CONSTANT / VERBATIM / FIXED / LPC / 立体声
 * ============================================================ */

describe('FlacDecoder.decodeFrame', () => {
  const si = { sampleRate: 48000, channels: 1, bitsPerSample: 16 };

  test('CONSTANT 子帧全块还原同一值', () => {
    const sub = new BitWriter();
    encodeConstantSubframe(sub, -777, 16, 16);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 16 })).headerBytes, sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    assert.equal(dec.blockSize, 16);
    for (const v of dec.channels[0]) assert.equal(v, -777);
  });

  test('VERBATIM 子帧逐样本精确还原', () => {
    const samples = [0, 1, -1, 32767, -32768, 255, -255, 12345];
    const sub = new BitWriter();
    encodeVerbatimSubframe(sub, samples, 16);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: samples.length })).headerBytes, sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], samples);
  });

  const fixedCases = [
    { order: 0, desc: '阶 0' },
    { order: 1, desc: '阶 1' },
    { order: 2, desc: '阶 2' },
    { order: 4, desc: '阶 4' },
  ];
  for (const { order, desc } of fixedCases) {
    test(`FIXED ${desc} + Rice 往返精确`, () => {
      // 构造残差序列并直接给定 warmup；解码输出 = warmup 展开 + 残差累加预测
      const residuals = [3, -1, 7, 0, -128, 42];
      const warmup = [10, -5, 33, 7].slice(0, order);
      const full = [...warmup, ...residuals];

      const sub = new BitWriter();
      encodeFixedSubframe(sub, full, order, 16, { riceParam: 2 });
      const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: full.length })).headerBytes, sub);

      const COEFFS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][order];
      const expect = [...full];
      for (let i = order; i < full.length; i++) {
        let pred = 0;
        for (let j = 0; j < order; j++) pred += COEFFS[j] * expect[i - 1 - j];
        expect[i] = full[i] + (pred >> order);
      }
      const dec = new FlacDecoder(si).decodeFrame(frame, 0);
      assert.deepEqual([...dec.channels[0]], expect);
    });
  }

  test('Rice 多分区（partitionOrder=1）往返', () => {
    // blockSize=16 可被 2 个分区整除；order=1 → 残差 15 = (8-1) + 8
    const residuals = Array.from({ length: 15 }, (_, i) => (i % 2 ? -i : i));
    const warmup = [1];
    const full = [...warmup, ...residuals]; // 总样本 16
    const sub = new BitWriter();
    encodeFixedSubframe(sub, full, 1, 16, { riceParam: 3, partitionOrder: 1, blockSize: 16 });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 16 })).headerBytes, sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    const COEFFS = [1];
    const expect = [...full];
    for (let i = 1; i < full.length; i++) {
      const pred = COEFFS[0] * expect[i - 1];
      expect[i] = full[i] + (pred >> 1);
    }
    assert.deepEqual([...dec.channels[0]], expect);
  });

  test('LPC 一阶系数往返精确', () => {
    // 手工设定：order=1, precision=15, shift=1, coeff=2 → pred = 2*x>>1 = x
    const residuals = [0, 0, 5, -5, 12];
    const warmup = [100];
    const full = [...warmup, ...residuals];
    const sub = new BitWriter();
    encodeLpcSubframe(sub, full, 1, 16, 15, 1, [2], { riceParam: 1 });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: full.length })).headerBytes, sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    // pred_i = (2*s[i-1])>>1 = s[i-1]，故期望输出 = warmup + warmup 末值 + 残差累积
    const expect = [100];
    for (let i = 1; i < full.length; i++) expect.push(expect[i - 1] + residuals[i - 1]);
    assert.deepEqual([...dec.channels[0]], expect);
  });

  test('浪费位（wasted bits）左移还原', () => {
    const originals = [256, -512, 1024, 0, 384];
    const sub = new BitWriter();
    encodeVerbatimSubframe(sub, originals, 16, /* wasted */ 2);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: originals.length })).headerBytes, sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], originals);
  });

  test('整帧 CRC-16 数据损坏检测', () => {
    const sub = new BitWriter();
    encodeVerbatimSubframe(sub, [100, -100, 250, -250], 16);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 4 })).headerBytes, sub);
    const corrupt = new Uint8Array(frame);
    corrupt[Math.floor(frame.length / 2)] ^= 0x55;
    assert.throws(() => new FlacDecoder(si).decodeFrame(corrupt, 0), (e) => e.code === 'PARSE_ERROR');
  });
});

describe('立体声去相关', () => {
  const si2 = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

  function stereoFrame(chA, chB, channelAssign) {
    const s0 = new BitWriter();
    const s1 = new BitWriter();
    encodeVerbatimSubframe(s0, chA, 16);
    encodeVerbatimSubframe(s1, chB, 16);
    return assembleFrame(
      finalizeHeader(encodeFrameHeader({ blockSize: chA.length, channelAssign })).headerBytes,
      s0, s1);
  }

  test('left_side 还原 L / R', () => {
    const L = [100, -200, 333];
    const R = [50, -150, 303];
    const side = L.map((l, i) => l - R[i]);
    const frame = stereoFrame(L, side, 8); // 1000 left/side
    const dec = new FlacDecoder(si2).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], L);
    assert.deepEqual([...dec.channels[1]], R);
  });

  test('right_side 还原 L / R（差异通道恒存 left−right）', () => {
    const L = [100, -200, 333];
    const R = [50, -150, 303];
    const side = L.map((l, i) => l - R[i]);   // 规范：差异通道 = 左 − 右
    const frame = stereoFrame(side, R, 9); // 1001 right/side
    const dec = new FlacDecoder(si2).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], L);
    assert.deepEqual([...dec.channels[1]], R);
  });

  test('mid_side 还原 L / R（偶数和）', () => {
    const L = [100, -200, 333, -44];
    const R = [50, -150, 301, -44];
    const mid = L.map((l, i) => (l + R[i]) >> 1);
    const side = L.map((l, i) => l - R[i]);
    const frame = stereoFrame(mid, side, 10); // 1010 mid/side
    const dec = new FlacDecoder(si2).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], L);
    assert.deepEqual([...dec.channels[1]], R);
  });
});

/* ============================================================
 * Demuxer：MediaInfo / samples / seek
 * ============================================================ */

describe('FlacDemuxer.parseInit/samples/seek', () => {
  function buildTwoFrameFile() {
    const mkFrame = (codedNumber, baseVal) => {
      const sub = new BitWriter();
      encodeConstantSubframe(sub, baseVal, 16, 16);
      return assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 16, codedNumber })).headerBytes, sub);
    };
    return buildFlac({
      streamInfo: { sampleRate: 48000, channels: 1, bps: 16, totalSamples: 32 },
      frames: [mkFrame(0, 100), mkFrame(1, -200)],
    });
  }

  test('parseInit 产出 MediaInfo，description 为 STREAMINFO 原始字节', async () => {
    const dem = new FlacDemuxer(memorySource(buildTwoFrameFile()));
    const mi = await dem.parseInit();
    assert.equal(mi.container, 'flac');
    assert.equal(mi.tracks[0].codec, 'flac');
    assert.ok(mi.tracks[0].description instanceof Uint8Array);
    assert.equal(mi.tracks[0].description.length, 34);
    assert.equal(mi.durationUs, Math.round((32 / 48000) * 1e6));
    await dem.stop();
  });

  test('samples 迭代产出两帧，µs 时间戳正确', async () => {
    const dem = new FlacDemuxer(memorySource(buildTwoFrameFile()));
    await dem.parseInit();
    /** @type {any[]} */
    const got = [];
    for await (const s of dem.samples(1)) got.push(s);
    assert.equal(got.length, 2);
    assert.equal(got[0].codec, 'flac');
    assert.equal(got[0].timestamp, 0);
    assert.equal(got[1].timestamp, Math.round(16 / 48000 * 1e6));
    // 帧数据可直接被解码器消费
    const dec = new FlacDecoder(dem.metadata.streamInfo);
    const f1 = dec.decodeFrame(got[0].data, 0);
    assert.equal(f1.channels[0][0], 100);
    const f2 = dec.decodeFrame(got[1].data, 0);
    assert.equal(f2.channels[0][0], -200);
    await dem.stop();
  });

  test('seek 落点到最近帧起点并影响后续迭代', async () => {
    const dem = new FlacDemuxer(memorySource(buildTwoFrameFile()));
    await dem.parseInit();
    const r = await dem.seek(Math.round((20 / 48000) * 1e6)); // 第 20 样本 → 第二帧
    assert.equal(r.actualTimestampUs, Math.round(16 / 48000 * 1e6));
    const it = dem.samples(1)[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value.timestamp, Math.round(16 / 48000 * 1e6));
    await dem.stop();
  });

  test('非法状态迁移抛 STATE_ERROR', async () => {
    const dem = new FlacDemuxer(memorySource(buildTwoFrameFile()));
    assert.throws(() => dem.samples(1), (e) => e.code === 'STATE_ERROR');
    await assert.rejects(() => dem.seek(0), (e) => e.code === 'STATE_ERROR');
  });
});

/* ============================================================
 * 播放层守卫（Node 下返回 null，不抛异常）
 * ============================================================ */

describe('播放层环境守卫', () => {
  test('Node 下 isFlacPlaybackSupported=false 且工厂返回 null', () => {
    assert.equal(isFlacPlaybackSupported(), false);
    assert.equal(createFlacPlayer(), null);
  });
});
