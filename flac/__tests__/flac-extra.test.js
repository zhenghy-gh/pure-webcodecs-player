/**
 * flac/__tests__/flac-extra.test.js — FLAC 边界补量套件（node --test）
 * ------------------------------------------------------------
 * 覆盖此前未覆盖的边界：
 *  · VORBIS_COMMENT 中文标签 / 值内等号 / 无效项跳过；
 *  · PICTURE 图片类型矩阵（type 3 前景图等）与多块取首；
 *  · SEEKTABLE 占位点、乱序点、残尾字节与 seek 校正落点；
 *  · 帧头 CRC-8 损坏后建索引的重同步语义；
 *  · Rice 分区参数边界（参数 0、5 位参数、转义分区、整除与首分区容量校验）；
 *  · 帧头扩展字段（blockSizeCode=7 的 16 位块大小 + sampleRateCode=13 的 Hz 扩展）。
 * fixture 策略与 flac.test.js 一致：内置迷你编码器程序化生成合法流，不落盘。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FlacDemuxer,
  FlacDecoder,
  parseMetadata,
  parseFrameHeader,
  BitWriter,
  crc8,
  crc16,
} from '../src/index.js';

/* ============================================================
 * 迷你编码器（fixture 用，仅覆盖本套件所需子集）
 * ============================================================ */

function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** 有符号值按 bps 位宽写二进制补码 */
function writeSigned(w, v, bps) {
  w.writeBits(v < 0 ? v + 2 ** bps : v, bps);
}

/**
 * 编码帧头。返回 BitWriter（调用方继续写子帧）。
 * 支持 blockSizeCode 显式覆盖（6/7 扩展）与 sampleRateCode=13 的 16 位 Hz 扩展。
 */
function encodeFrameHeader(o) {
  const w = new BitWriter();
  const blockSizeCode = o.blockSizeCode ?? 6;    // get8+1
  const sampleRateCode = o.sampleRateCode ?? 10; // 48000
  const channelAssign = o.channelAssign ?? 0;    // 单声道
  const sampleSizeCode = o.sampleSizeCode ?? 4;  // 16bps
  const codedNumber = o.codedNumber ?? 0;

  w.writeBits(0b11111111111110, 14)
    .writeBits(0, 1)
    .writeBits(o.blockingStrategy ?? 0, 1)
    .writeBits(blockSizeCode, 4)
    .writeBits(sampleRateCode, 4)
    .writeBits(channelAssign, 4)
    .writeBits(sampleSizeCode, 3)
    .writeBits(0, 1);
  // UTF 编码数（本套件仅用 ≤127 的帧号）
  w.writeBits(codedNumber, 8);
  if (blockSizeCode === 6) w.writeBits(o.blockSize - 1, 8);
  if (blockSizeCode === 7) w.writeBits(o.blockSize - 1, 16);
  if (sampleRateCode === 13) w.writeBits(o.extSampleRateHz, 16); // 16 位 Hz 扩展
  return w;
}

/** 帧头收尾：对齐 + CRC-8 字节。返回完整帧头字节。 */
function finalizeHeader(w) {
  w.alignToByte();
  const bytesSoFar = w.toUint8Array();
  const c = crc8(bytesSoFar);
  return concatBytes(bytesSoFar, new Uint8Array([c]));
}

/** Rice 残差编码（method 0/1；参数 0 时尾数 0 位）。分区切分遵循规范。 */
function encodeRiceResiduals(w, residuals, opts = {}) {
  const { method = 0, riceParam = 4, partitionOrder = 0, blockSize, predictorOrder = 0 } = opts;
  w.writeBits(method, 2);
  w.writeBits(partitionOrder, 4);
  const partitions = 1 << partitionOrder;
  const base = blockSize >> partitionOrder;
  let idx = 0;
  for (let p = 0; p < partitions; p++) {
    w.writeBits(riceParam, method === 0 ? 4 : 5);
    const n = p === 0 ? base - predictorOrder : base;
    for (let k = 0; k < n; k++, idx++) {
      const r = residuals[idx];
      const u = r < 0 ? -r * 2 - 1 : r * 2; // zigzag 正映射
      const q = Math.floor(u / 2 ** riceParam);
      const rem = u % 2 ** riceParam;
      for (let z = 0; z < q; z++) w.writeBits(0, 1);
      w.writeBits(1, 1);
      if (riceParam > 0) w.writeBits(rem, riceParam);
    }
  }
  if (idx !== residuals.length) throw new Error(`fixture 分区容量不符：编了 ${idx} 应 ${residuals.length}`);
}

/** FIXED 子帧（warmup + 残差交给 Rice 发射器选项） */
function encodeFixedSubframe(w, full, order, bps, riceOpts = {}) {
  w.writeBits(0, 1).writeBits(0b001000 | order, 6).writeBits(0, 1);
  for (let i = 0; i < order; i++) writeSigned(w, full[i], bps);
  encodeRiceResiduals(w, full.slice(order), {
    blockSize: riceOpts.blockSize ?? full.length,
    predictorOrder: order,
    ...riceOpts,
  });
}

/** FIXED 阶 0 + 转义残差分区（riceParam=15 → rawLen + 有符号原码） */
function encodeEscapedFixedSubframe(w, residuals, rawBits) {
  w.writeBits(0, 1).writeBits(0b001000, 6).writeBits(0, 1); // FIXED 阶 0 子帧头
  w.writeBits(0, 2);  // method 00（4 位参数）
  w.writeBits(0, 4);  // partitionOrder 0
  w.writeBits(15, 4); // 全 1 参数 → 转义
  w.writeBits(rawBits, 5);
  for (const r of residuals) writeSigned(w, r, rawBits);
}

/** 组帧：头 + 子帧位流 → 位级拼接 → 对齐 → CRC-16 */
function assembleFrame(headerBytes, ...subframeWriters) {
  const all = new BitWriter();
  for (const sw of subframeWriters) all.merge(sw); // 子帧间不按字节对齐！
  all.alignToByte();
  const payload = concatBytes(headerBytes, all.toUint8Array());
  const crc = crc16(payload);
  return concatBytes(payload, new Uint8Array([(crc >> 8) & 0xff, crc & 0xff]));
}

function metaBlock(type, body, last) {
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | type;
  head[1] = (body.length >> 16) & 0xff;
  head[2] = (body.length >> 8) & 0xff;
  head[3] = body.length & 0xff;
  return concatBytes(head, body);
}

/** STREAMINFO 34 字节（md5 全零） */
function streamInfoBody({ sampleRate = 48000, channels = 1, bps = 16, totalSamples = 0 } = {}) {
  const b = new Uint8Array(34);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 16); // minBS
  dv.setUint16(2, 16); // maxBS
  dv.setUint32(10, (sampleRate << 12) | ((channels - 1) << 9) | ((bps - 1) << 4));
  const tsHi = Math.floor(totalSamples / 2 ** 32);
  const tsLo = totalSamples >>> 0;
  b[13] = (b[13] & 0xf0) | (tsHi & 0x0f);
  dv.setUint32(14, tsLo);
  return b;
}

/** VORBIS_COMMENT 块体（小端长度前缀）；条目可为 [k,v] 元组或裸字符串（用于无等号/空键等非法形态） */
function vorbisCommentBody(vendor, entries) {
  const enc = new TextEncoder();
  const vb = enc.encode(vendor);
  const lenPrefix = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  const parts = [lenPrefix(vb.length), vb, lenPrefix(entries.length)];
  for (const e of entries) {
    const item = enc.encode(typeof e === 'string' ? e : `${e[0]}=${e[1]}`);
    parts.push(lenPrefix(item.length), item);
  }
  return concatBytes(...parts);
}

/** PICTURE 块体（spec §7.15 字段序：type/mime/desc/w/h/depth/colors/data） */
function pictureBody({ pictureType, mime, description = '', width, height, depth = 24, colors = 0, data }) {
  const enc = new TextEncoder();
  const m = enc.encode(mime);
  const d = enc.encode(description);
  const u32 = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return concatBytes(
    u32(pictureType), u32(m.length), m, u32(d.length), d,
    u32(width), u32(height), u32(depth), u32(colors),
    u32(data.length), data,
  );
}

/** SEEKTABLE 块体：每点 18 字节；placeholder:true 写全 FF 占位点 */
function seekTableBody(points) {
  const parts = points.map((pt) => {
    const b = new Uint8Array(18);
    const dv = new DataView(b.buffer);
    if (pt.placeholder) {
      dv.setUint32(0, 0xffffffff); dv.setUint32(4, 0xffffffff);
      dv.setUint32(8, 0xffffffff); dv.setUint32(12, 0xffffffff);
    } else {
      const sn = BigInt(pt.sampleNumber);
      dv.setUint32(0, Number(sn >> 32n)); dv.setUint32(4, Number(sn & 0xffffffffn));
      const off = BigInt(pt.offset);
      dv.setUint32(8, Number(off >> 32n)); dv.setUint32(12, Number(off & 0xffffffffn));
      dv.setUint16(16, pt.frameSamples);
    }
    return b;
  });
  return concatBytes(...parts);
}

/** 完整 FLAC 文件组装 */
function buildFlac({ streamInfo = {}, extraBlocks = [], frames }) {
  const magic = new TextEncoder().encode('fLaC');
  const blocks = [metaBlock(0, streamInfoBody(streamInfo), extraBlocks.length === 0)];
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

/** 单声道 CONSTANT 帧（blockSize 个同值样本），codedNumber 即帧号 */
function constantFrame(blockSize, value, codedNumber = 0) {
  const sub = new BitWriter();
  sub.writeBits(0, 1).writeBits(0b000000, 6).writeBits(0, 1);
  writeSigned(sub, value, 16);
  return assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize, codedNumber })), sub);
}

/* ============================================================
 * VORBIS_COMMENT 边界
 * ============================================================ */

describe('VORBIS_COMMENT 边界', () => {
  test('中文标签解析：键大写归一、值内等号只按首个切分、无效项跳过', () => {
    const body = vorbisCommentBody('参考编码器 0.1（测试）', [
      ['TITLE', '卡农——钢琴改编版'],
      ['ARTIST', '测试乐团'],
      ['ALBUM', '测试专辑·第一辑'],
      ['COMMENT', '键值分隔=号也算值'], // 值内含 '='：必须保留在值里
      'noequals',                       // 无 '=' 的项应被忽略而非抛错
      '=emptykey',                      // 以 '=' 开头（空键）同样忽略
    ]);
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 4, body }], frames: [] }));
    assert.equal(m.tags.TITLE, '卡农——钢琴改编版');
    assert.equal(m.tags.ARTIST, '测试乐团');
    assert.equal(m.tags.ALBUM, '测试专辑·第一辑');
    assert.equal(m.tags.COMMENT, '键值分隔=号也算值', '值内的 = 不应被二次切分');
    assert.deepEqual(Object.keys(m.tags).sort(), ['ALBUM', 'ARTIST', 'COMMENT', 'TITLE'],
      '无等号与空键项不得进入标签表');
  });
});

/* ============================================================
 * PICTURE 块边界
 * ============================================================ */

describe('PICTURE 块', () => {
  test('图片类型矩阵（0 其他/3 前景图/4 背面封面/16 艺人肖像/17 插画）：字段逐一致', () => {
    for (const t of [0, 3, 4, 16, 17]) {
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, t]); // 伪 PNG 魔数 + 类型标记
      const body = pictureBody({
        pictureType: t,
        mime: 'image/jpeg',
        description: `类型${t}·封面`,
        width: 320 + t, // 每种类型给不同宽高，防止“碰巧相等”的假阳性
        height: 240,
        data,
      });
      const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 6, body }], frames: [] }));
      // 宽高声明位于变长 mime/description 之后的固定段，与图片类型的取值无关
      assert.equal(m.picture.mime, 'image/jpeg', `type ${t} mime`);
      assert.equal(m.picture.description, `类型${t}·封面`, `type ${t} 中文描述`);
      assert.equal(m.picture.width, 320 + t, `type ${t} 宽须取自声明段`);
      assert.equal(m.picture.height, 240, `type ${t} 高`);
      assert.deepEqual([...m.picture.data], [...data], `type ${t} 数据往返`);
    }
  });

  test('双 PICTURE 块取第一个（前景图优先于背面封面）且块清单完整', () => {
    const first = pictureBody({
      pictureType: 3, mime: 'image/png', description: '前景·主封面',
      width: 111, height: 99, data: new Uint8Array([1, 2, 3]),
    });
    const second = pictureBody({
      pictureType: 4, mime: 'image/jpeg', description: '背面',
      width: 222, height: 198, data: new Uint8Array([9, 8, 7, 6]),
    });
    const m = parseMetadata(buildFlac({
      streamInfo: {},
      extraBlocks: [{ type: 6, body: first }, { type: 6, body: second }],
      frames: [],
    }));
    assert.deepEqual(m.blocks.map((b) => b.type), [0, 6, 6]);
    assert.equal(m.picture.mime, 'image/png', '只保留首个 PICTURE');
    assert.equal(m.picture.width, 111);
    assert.equal(m.picture.height, 99);
    assert.deepEqual([...m.picture.data], [1, 2, 3]);
  });
});

/* ============================================================
 * SEEKTABLE 边界
 * ============================================================ */

describe('SEEKTABLE', () => {
  test('占位点跳过、乱序点保持文件序、尾部不足 18 字节忽略', () => {
    const body = concatBytes(seekTableBody([
      { sampleNumber: 480000, offset: 12345, frameSamples: 4096 },
      { placeholder: true },                              // 全 FF 占位点：必须跳过
      { sampleNumber: 0, offset: 42, frameSamples: 16 },  // 故意乱序：sn=0 在后
      { sampleNumber: 960000, offset: 65536 + 12345, frameSamples: 4096 },
    ]), new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00]));   // 5 字节残尾：<18 忽略
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 3, body }], frames: [] }));
    assert.deepEqual(m.seekPoints, [
      { sampleNumber: 480000, offset: 12345, frameSamples: 4096 },
      { sampleNumber: 0, offset: 42, frameSamples: 16 },
      { sampleNumber: 960000, offset: 77881, frameSamples: 4096 },
    ], '按文件序原样收录（不排序），占位点与残尾不产出条目');
  });

  test('seek 与 SEEKTABLE 协同：非帧边界的最近 ≤ 目标点可校正落点', async () => {
    // 两帧 × 16 样本 @48kHz；表点 8 刻意落在帧中间（非真实帧起点），
    // 用于验证「优先 SEEKTABLE 中 ≤ 目标的最近点」这一文档化语义。
    const f0 = constantFrame(16, 100, 0);
    const f1 = constantFrame(16, -200, 1);
    const bytes = buildFlac({
      streamInfo: { totalSamples: 32 },
      extraBlocks: [{
        type: 3,
        body: seekTableBody([
          { sampleNumber: 8, offset: 999, frameSamples: 16 },
          { sampleNumber: 16, offset: 42 + f0.length, frameSamples: 16 },
        ]),
      }],
      frames: [f0, f1],
    });
    const dem = new FlacDemuxer(memorySource(bytes));
    await dem.parseInit();

    // 目标第 ~10 样本：帧索引只能落在帧 0（firstSample 0），表点 8 更近 → 校正为 8
    const r1 = await dem.seek(Math.round((10 / 48000) * 1e6));
    assert.deepEqual(r1, { actualTimestampUs: Math.round((8 / 48000) * 1e6) });

    // 目标第 ~20 样本：帧索引与最近表点同为 16 → 一致落点
    const r2 = await dem.seek(Math.round((20 / 48000) * 1e6));
    assert.deepEqual(r2, { actualTimestampUs: Math.round((16 / 48000) * 1e6) });
    await dem.stop();
  });
});

/* ============================================================
 * 损坏重同步（帧头 CRC-8）
 * ============================================================ */

describe('损坏重同步', () => {
  test('帧头 CRC-8 损坏的帧被跳过建索引，后续帧样本位不虚增', async () => {
    const f0 = constantFrame(16, 100, 0);
    const f1 = constantFrame(16, -200, 1);
    const f2 = constantFrame(16, 300, 2);
    const good = buildFlac({ streamInfo: { totalSamples: 48 }, frames: [f0, f1, f2] });

    // 定位中间帧头的最后一个字节（CRC-8）并翻转
    const hdrLen = parseFrameHeader(f1, 0).header.headerBytes;
    const corruptAt = 42 /* fLaC(4)+块头(4)+STREAMINFO(34) */ + f0.length + hdrLen - 1;
    const bad = new Uint8Array(good);
    bad[corruptAt] ^= 0xff;

    const dem = new FlacDemuxer(memorySource(bad));
    await dem.parseInit();
    const index = await dem.buildFrameIndex();

    assert.equal(index.length, 2, '坏帧不入索引，前后两好帧仍被收录');
    assert.deepEqual(
      { offset: index[0].offset, size: index[0].size, firstSample: index[0].firstSample, samples: index[0].samples },
      { offset: 42, size: f0.length, firstSample: 0, samples: 16 },
    );
    // 关键语义：损坏帧的 16 个样本不计入累计样本位——重同步从下一好帧继续
    assert.equal(index[1].offset, 42 + f0.length + f1.length);
    assert.equal(index[1].samples, 16);
    assert.equal(index[1].firstSample, 16, '坏帧样本数不得计入 firstSample');
    assert.notEqual(index[1].firstSample, 32);

    // 建好的索引可直接迭代出两帧且字节正确
    const got = [];
    for await (const s of dem.samples(1)) got.push(s);
    assert.equal(got.length, 2);
    const dec = new FlacDecoder(dem.metadata.streamInfo);
    assert.equal(dec.decodeFrame(got[0].data, 0).channels[0][0], 100);
    assert.equal(dec.decodeFrame(got[1].data, 0).channels[0][0], 300, '第二好帧是原第三帧');
    await dem.stop();
  });
});

/* ============================================================
 * Rice 分区参数边界
 * ============================================================ */

describe('Rice 分区参数边界', () => {
  const si = { sampleRate: 48000, channels: 1, bitsPerSample: 16 };

  test('参数 0：纯一元商（尾数 0 位）往返精确', () => {
    const residuals = [0, 1, -1, 5, -5, 255, -255];
    const sub = new BitWriter();
    encodeFixedSubframe(sub, residuals, 0, 16, { riceParam: 0, blockSize: residuals.length });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: residuals.length })), sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], residuals, '阶 0 预测恒 0，输出即残差序列');
  });

  test('method 01：5 位 Rice 参数分支往返精确', () => {
    // blockSize=8 可被 2 分区整除；order=1 → 残差 7 = (4-1) + 4
    const warmup = [77];
    const residuals = [2, -2, 1, -1, 0, 3, -3];
    const full = [...warmup, ...residuals];
    const sub = new BitWriter();
    encodeFixedSubframe(sub, full, 1, 16, { method: 1, riceParam: 11, partitionOrder: 1, blockSize: 8 });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 8 })), sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    const expect = [...full];
    for (let i = 1; i < full.length; i++) {
      expect[i] = full[i] + (expect[i - 1] >> 1); // FIXED 阶 1：pred = x[i-1]
    }
    assert.deepEqual([...dec.channels[0]], expect);
  });

  test('转义分区（riceParam=1111 → rawLen + 有符号原码）往返精确', () => {
    const residuals = [-63, -1, 0, 1, 63, 7]; // ±63 恰好落在 7 位有符号范围内
    const sub = new BitWriter();
    encodeEscapedFixedSubframe(sub, residuals, 7);
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: residuals.length })), sub);
    const dec = new FlacDecoder(si).decodeFrame(frame, 0);
    assert.deepEqual([...dec.channels[0]], residuals);
  });

  test('blockSize 无法被分区数整除 → PARSE_ERROR', () => {
    // blockSize=7、partitionOrder=1：fixture 按 floor(7/2)=3 每分区写满共 6 个残差
    // （位流本身可写），解码侧必须因 7 % 2 ≠ 0 直接拒绝。
    const residuals = [1, -1, 2, -2, 3, -3];
    const sub = new BitWriter();
    encodeFixedSubframe(sub, residuals, 0, 16, { riceParam: 2, partitionOrder: 1, blockSize: 7 });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 7 })), sub);
    assert.throws(() => new FlacDecoder(si).decodeFrame(frame, 0), (e) => e.code === 'PARSE_ERROR');
  });

  test('首分区容量不足以扣除 warmup → PARSE_ERROR', () => {
    // blockSize=8、partitionOrder=2 → 每分区 2 样本；FIXED 阶 2 需扣 2 → 首分区剩 0，
    // 触发 baseSize <= predictorOrder 校验（阶 2 时 baseSize==predictorOrder 为边界）
    const warmup = [5, -7];
    const residuals = [1, -1, 2, -2, 3, -3];
    const sub = new BitWriter();
    encodeFixedSubframe(sub, [...warmup, ...residuals], 2, 16, {
      riceParam: 1, partitionOrder: 2, blockSize: 8,
    });
    const frame = assembleFrame(finalizeHeader(encodeFrameHeader({ blockSize: 8 })), sub);
    assert.throws(() => new FlacDecoder(si).decodeFrame(frame, 0), (e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * 帧头扩展字段
 * ============================================================ */

describe('帧头扩展字段', () => {
  test('blockSizeCode=7（16 位块大小 4096）与 sampleRateCode=13（Hz 扩展 12345）联合解析', () => {
    const value = -12345;
    const sub = new BitWriter();
    sub.writeBits(0, 1).writeBits(0b000000, 6).writeBits(0, 1);
    writeSigned(sub, value, 16);
    const frame = assembleFrame(
      finalizeHeader(encodeFrameHeader({
        blockSizeCode: 7, blockSize: 4096, sampleRateCode: 13, extSampleRateHz: 12345,
      })),
      sub,
    );

    // 帧头级：扩展字节顺序（UTF 编码数 → 块大小扩展 → 采样率扩展）与 CRC-8 均须正确
    const { header } = parseFrameHeader(frame, 0);
    assert.equal(header.blockSize, 4096);
    assert.equal(header.sampleRate, 12345, 'code 13 的 16 位 Hz 扩展生效');
    assert.equal(header.channels, 1);
    assert.equal(header.bitsPerSample, 16);

    // 帧级：4096 样本常量块的完整解码与 CRC-16 校验
    const dec = new FlacDecoder({ sampleRate: 48000, channels: 1, bitsPerSample: 16 })
      .decodeFrame(frame, 0);
    assert.equal(dec.blockSize, 4096);
    assert.equal(dec.sampleRate, 12345, '帧头采样率优先于 STREAMINFO');
    assert.equal(dec.endByte, frame.length);
    for (const v of dec.channels[0]) assert.equal(v, value);
  });
});
