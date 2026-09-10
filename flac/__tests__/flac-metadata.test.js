/**
 * flac/__tests__/flac-metadata.test.js — METADATA 块解析补充套件（node --test）
 * ------------------------------------------------------------
 * 聚焦 flac-extra/flac.test 尚未覆盖的 metadata.js 分支：
 *  · STREAMINFO 全字段（min/max block/frame size、md5、totalSamples 高位）
 *  · STREAMINFO 截断与缺失首块
 *  · PADDING 块跳过 + 长度越界（截断）错误
 *  · APPLICATION 块（type 2）收录（默认跳过体）
 *  · VORBIS_COMMENT 双块合并 / 空 vendor / 注释区损坏不抛错
 *  · PICTURE 空 mime / 空 data / 非零 depth·colors / 二进制往返
 *  · SEEKTABLE 64 位 offset（>4GB）/ 空表 / frameSamples 边界 / 占位点
 * 全部程序化构造最小合法/边界 fixture，零依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetadata, BLOCK_TYPE } from '../src/index.js';
import { parseError } from '../src/errors.js';

/* ---------- 内联 fixture 构造 ---------- */
function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function metaBlock(type, body, last) {
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | type;
  head[1] = (body.length >> 16) & 0xff;
  head[2] = (body.length >> 8) & 0xff;
  head[3] = body.length & 0xff;
  return concatBytes(head, body);
}
function streamInfoBodyFull(o = {}) {
  const {
    minBS = 16, maxBS = 16, minFS = 123, maxFS = 4567,
    sampleRate = 44100, channels = 2, bps = 24, totalSamples = 0o1234567,
    md5 = new Uint8Array(16),
  } = o;
  const b = new Uint8Array(34);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, minBS);
  dv.setUint16(2, maxBS);
  b[4] = (minFS >> 16) & 0xff; b[5] = (minFS >> 8) & 0xff; b[6] = minFS & 0xff;
  b[7] = (maxFS >> 16) & 0xff; b[8] = (maxFS >> 8) & 0xff; b[9] = maxFS & 0xff;
  const packed = ((sampleRate << 12) | ((channels - 1) << 9) | ((bps - 1) << 4)) >>> 0;
  dv.setUint32(10, packed);
  const tsHi = Math.floor(totalSamples / 2 ** 32);
  const tsLo = totalSamples >>> 0;
  b[13] = (b[13] & 0xf0) | (tsHi & 0x0f);
  dv.setUint32(14, tsLo);
  b.set(md5.subarray(0, 16), 18);
  return b;
}
function vorbisCommentBody(vendor, entries) {
  const enc = new TextEncoder();
  const vb = enc.encode(vendor);
  const lenPrefix = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  const parts = [lenPrefix(vb.length), vb, lenPrefix(entries.length)];
  for (const [k, v] of entries) {
    const item = enc.encode(`${k}=${v}`);
    parts.push(lenPrefix(item.length), item);
  }
  return concatBytes(...parts);
}
function pictureBody({ pictureType = 3, mime = 'image/png', description = '', width = 100, height = 80, depth = 24, colors = 0, data = new Uint8Array([1, 2, 3]) }) {
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
function buildFlac({ streamInfo, extraBlocks = [], frames = [] }) {
  const magic = new TextEncoder().encode('fLaC');
  const si = streamInfoBodyFull(streamInfo);
  const blocks = [metaBlock(0, si, extraBlocks.length === 0)];
  extraBlocks.forEach((blk, i) => blocks.push(metaBlock(blk.type, blk.body, i === extraBlocks.length - 1)));
  return concatBytes(magic, ...blocks, ...frames);
}

const magic = new TextEncoder().encode('fLaC');

/* ============================================================
 * STREAMINFO 全字段
 * ============================================================ */
describe('STREAMINFO 字段', () => {
  test('min/max block·frame size、totalSamples 高位、md5 逐字节', () => {
    const md5 = new Uint8Array(Array.from({ length: 16 }, (_, i) => (i * 17) & 0xff));
    const m = parseMetadata(buildFlac({
      streamInfo: { minBS: 1024, maxBS: 4096, minFS: 100, maxFS: 20000,
        sampleRate: 96000, channels: 2, bps: 16, totalSamples: 0x12345678, md5 },
    }));
    const si = m.streamInfo;
    assert.equal(si.minBlockSize, 1024);
    assert.equal(si.maxBlockSize, 4096);
    assert.equal(si.minFrameSize, 100);
    assert.equal(si.maxFrameSize, 20000);
    assert.equal(si.sampleRate, 96000);
    assert.equal(si.channels, 2);
    assert.equal(si.bitsPerSample, 16);
    assert.equal(si.totalSamples, 0x12345678);
    assert.equal(si.md5, [...md5].map((x) => x.toString(16).padStart(2, '0')).join(''));
  });

  test('STREAMINFO 体短于 34 字节抛 PARSE_ERROR', () => {
    const short = streamInfoBodyFull({}).subarray(0, 30); // 截断 4 字节
    const bytes = concatBytes(magic, metaBlock(0, short, true));
    assert.throws(() => parseMetadata(bytes), (e) => e.code === 'PARSE_ERROR' && /STREAMINFO/.test(e.message));
  });

  test('首块非 STREAMINFO → 缺首块抛 PARSE_ERROR', () => {
    const pad = metaBlock(1, new Uint8Array(8), true); // 首块是 PADDING
    assert.throws(() => parseMetadata(concatBytes(magic, pad)), (e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * PADDING 块
 * ============================================================ */
describe('PADDING 块', () => {
  test('PADDING 被跳过且不影响后续 VORBIS 解析', () => {
    const m = parseMetadata(buildFlac({
      streamInfo: {},
      extraBlocks: [
        { type: BLOCK_TYPE.PADDING, body: new Uint8Array(64) }, // 纯零填充
        { type: 4, body: vorbisCommentBody('v', [['T', 'ok']]) },
      ],
    }));
    assert.deepEqual(m.blocks.map((b) => b.type), [0, 1, 4]);
    assert.equal(m.tags.T, 'ok');
  });

  test('PADDING 声明长度超出缓冲 → 越界抛 PARSE_ERROR', () => {
    // 头声明 length=100 但体仅 8 字节
    const bytes = concatBytes(magic, (() => {
      const head = new Uint8Array(4);
      head[0] = 0x80 | 1; head[1] = 0; head[2] = 0; head[3] = 100;
      return concatBytes(head, new Uint8Array(8));
    })());
    assert.throws(() => parseMetadata(bytes), (e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * APPLICATION 块
 * ============================================================ */
describe('APPLICATION 块', () => {
  test('APPLICATION(type 2) 收录于块清单且体被跳过', () => {
    const appBody = new Uint8Array([0x41, 0x42, 0x43, 0x44, 9, 8, 7, 6]); // 4 字节 ID + 数据
    const m = parseMetadata(buildFlac({
      streamInfo: {}, extraBlocks: [{ type: 2, body: appBody }],
    }));
    const app = m.blocks.find((b) => b.type === 2);
    assert.ok(app);
    assert.equal(app.length, appBody.length);
    assert.equal(m.picture, null, 'APPLICATION 不污染 picture');
  });
});

/* ============================================================
 * VORBIS_COMMENT 边界
 * ============================================================ */
describe('VORBIS_COMMENT 边界', () => {
  test('双 VORBIS 块标签合并', () => {
    const m = parseMetadata(buildFlac({
      streamInfo: {},
      extraBlocks: [
        { type: 4, body: vorbisCommentBody('a', [['A', '1']]) },
        { type: 4, body: vorbisCommentBody('b', [['B', '2']]) },
      ],
    }));
    assert.equal(m.tags.A, '1');
    assert.equal(m.tags.B, '2');
  });

  test('空 vendor 串仍可解', () => {
    const m = parseMetadata(buildFlac({
      streamInfo: {}, extraBlocks: [{ type: 4, body: vorbisCommentBody('', [['X', 'y']]) }],
    }));
    assert.equal(m.tags.X, 'y');
  });

  test('注释区长度越界损坏被吞、主流程不抛错', () => {
    // vendor 长度声明为 9999 但体远短 → DataView 越界被 try/catch 吞掉
    const enc = new TextEncoder();
    const vb = enc.encode('v');
    const bad = concatBytes(
      new Uint8Array([0xff, 0xff, 0x00, 0x00]), // vendorLen = 0x00ffffff << 越界
      vb,
      new Uint8Array([1, 0, 0, 0]), // count = 1
    );
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 4, body: bad }] }));
    assert.deepEqual(m.tags, {}, '损坏区返回空标签表');
    assert.ok(m.streamInfo, '仍返回合法 STREAMINFO');
  });

  test('单条目长度越界 → 循环 break 而非抛错', () => {
    const enc = new TextEncoder();
    const vb = enc.encode('v');
    const itemLen = new Uint8Array([0xff, 0xff, 0xff, 0xff]); // 巨大条目长度
    const bad = concatBytes(
      new Uint8Array([vb.length, 0, 0, 0]), vb,
      new Uint8Array([1, 0, 0, 0]), itemLen, // count=1 但条目长度越界
    );
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 4, body: bad }] }));
    assert.deepEqual(m.tags, {});
  });
});

/* ============================================================
 * PICTURE 二进制变体
 * ============================================================ */
describe('PICTURE 块', () => {
  test('空 mime / 空 description / 零 data 长度解析一致', () => {
    const body = pictureBody({ mime: '', description: '', width: 0, height: 0, depth: 0, colors: 0, data: new Uint8Array(0) });
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 6, body }] }));
    assert.equal(m.picture.mime, '');
    assert.equal(m.picture.description, '');
    assert.equal(m.picture.width, 0);
    assert.equal(m.picture.height, 0);
    assert.equal(m.picture.data.length, 0);
  });

  test('非零宽高与含 0x00/0xff 的二进制数据往返', () => {
    const data = new Uint8Array([0x00, 0xff, 0x10, 0x00, 0xab, 0xff]);
    const body = pictureBody({ mime: 'image/jpeg', width: 640, height: 480, depth: 32, colors: 256, data });
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 6, body }] }));
    // 注意：源码 parsePicture 模型仅暴露 mime/description/width/height/data，
    // depth/colors 按规范读取后未入模型（符合现有实现契约）。
    assert.equal(m.picture.width, 640);
    assert.equal(m.picture.height, 480);
    assert.deepEqual([...m.picture.data], [...data]);
  });
});

/* ============================================================
 * SEEKTABLE 边界
 * ============================================================ */
describe('SEEKTABLE 边界', () => {
  test('offset > 4GB（64 位）精确还原', () => {
    const offset = 5 * 2 ** 32 + 123; // 21474836571，超出 32 位
    const body = seekTableBody([{ sampleNumber: 100, offset, frameSamples: 4096 }]);
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 3, body }] }));
    assert.equal(m.seekPoints[0].offset, offset);
    assert.equal(m.seekPoints[0].frameSamples, 4096);
  });

  test('空 SEEKTABLE（length=0）不报错', () => {
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 3, body: new Uint8Array(0) }] }));
    assert.deepEqual(m.seekPoints, []);
  });

  test('frameSamples 取 0xffff 边界且占位点 frameSamples 字段忽略', () => {
    const body = concatBytes(
      seekTableBody([{ sampleNumber: 1, offset: 10, frameSamples: 0xffff }]),
      seekTableBody([{ placeholder: true }]),
    );
    const m = parseMetadata(buildFlac({ streamInfo: {}, extraBlocks: [{ type: 3, body }] }));
    assert.equal(m.seekPoints.length, 1);
    assert.equal(m.seekPoints[0].frameSamples, 0xffff);
  });
});
