/**
 * samples/fixtures/mp4.js —— makeMinimalMP4()：程序化生成结构合法的最小 MP4。
 *
 * 结构（moov 前置，便于流式解析测试）：
 *   ftyp
 *   moov
 *     mvhd                    （movie timescale = 1000）
 *     trak
 *       tkhd                  （track_ID=1，宽高 16.16 定点）
 *       mdia
 *         mdhd / hdlr(vide) / minf
 *           vmhd / dinf(dref→url self) / stbl
 *             stsd(avc1→avcC)  stts  stss  stsc  stsz(表)  stco(回填 mdat 偏移)
 *   mdat                       （AVCC 格式伪样本：4 字节长度前缀 + NAL）
 *
 * 约定：样本数据可伪造，但 box 层级、字段宽度、长度自洽全部符合 ISO-BMFF 规范。
 */

import { u8, concat, ascii, u16be, u32be } from './bytes.js';
import { buildAvcC, makeAvcSample } from './codecs.js';

/** 普通 box：4 字节大端 size + type + 载荷 */
export function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  out[0] = (out.length >>> 24) & 0xff;
  out[1] = (out.length >>> 16) & 0xff;
  out[2] = (out.length >>> 8) & 0xff;
  out[3] = out.length & 0xff;
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

/** fullBox：box + version(1B) + flags(3B) */
export function fullBox(type, version, flags, ...parts) {
  const vf = new Uint8Array(4);
  vf[0] = version;
  vf[1] = (flags >>> 16) & 0xff;
  vf[2] = (flags >>> 8) & 0xff;
  vf[3] = flags & 0xff;
  return box(type, vf, ...parts);
}

/** 视频合成矩阵（unity）的 36 字节 */
function unityMatrix() {
  return concat([
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
  ]);
}

const MOVIE_TIMESCALE_DEFAULT = 1000;

/**
 * @param {object} [opts]
 * @param {number} [opts.width=320]      宽
 * @param {number} [opts.height=240]     高
 * @param {number} [opts.sampleCount=4]  样本数
 * @param {number} [opts.timescale=1000] 时间基（每样本 delta=1000 tick ⇒ 每样本 1s，便于心算）
 * @returns {{bytes: Uint8Array, meta: object}} bytes=完整文件字节；meta=供断言用的元信息
 */
export function makeMinimalMP4(opts = {}) {
  const {
    width = 320,
    height = 240,
    sampleCount = 4,
    timescale = MOVIE_TIMESCALE_DEFAULT,
  } = opts;

  /* ---------- 样本表 ---------- */
  const samples = [];
  for (let i = 0; i < sampleCount; i++) samples.push(makeAvcSample(i));
  const sizes = samples.map((s) => s.length);

  /* ---------- ftyp ---------- */
  const ftyp = box('ftyp',
    ascii('isom'), // major brand
    u32be(512), // minor version
    ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'),
  );

  /* ---------- moov ---------- */
  const durationTicks = sampleCount * timescale; // 每样本固定 delta

  // mvhd（version 0）：创建/修改时间用 0，保证输出确定性
  const mvhd = fullBox('mvhd', 0, 0,
    u32be(0), u32be(0), // creation / modification
    u32be(timescale),
    u32be(durationTicks),
    u32be(0x00010000), // rate 1.0
    u16be(0x0100), // volume 1.0
    new Uint8Array(10), // reserved
    unityMatrix(),
    new Uint8Array(24), // pre_defined
    u32be(2), // next_track_ID
  );

  // tkhd（version 0, flags=3 enabled|in_movie）；时长为 movie timescale 单位
  const tkhd = fullBox('tkhd', 0, 3,
    u32be(0), u32be(0), // creation / modification
    u32be(1), // track_ID
    u32be(0), // reserved
    u32be(durationTicks),
    new Uint8Array(8), // reserved
    u16be(0), // layer
    u16be(0), // alternate_group
    u16be(0), // volume（视频轨为 0）
    u16be(0), // reserved
    unityMatrix(),
    u32be(width << 16), // width 16.16 定点
    u32be(height << 16),
  );

  const mdhd = fullBox('mdhd', 0, 0,
    u32be(0), u32be(0), // creation / modification
    u32be(timescale),
    u32be(durationTicks),
    u16be(0x55c4), // language 'und' 的 5-5-5 位打包
    u16be(0), // pre_defined
  );

  const hdlr = fullBox('hdlr', 0, 0,
    u32be(0), // pre_defined
    ascii('vide'), // handler_type
    new Uint8Array(12), // reserved
    ascii('VideoHandler\0'),
  );

  const vmhd = fullBox('vmhd', 0, 1, u16be(0), u16be(0), u16be(0), u16be(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32be(1), fullBox('url ', 0, 1)));

  // stsd → avc1 → avcC
  const avcC = buildAvcC();
  const avc1 = box('avc1',
    new Uint8Array(6), u16be(1), // SampleEntry: reserved + data_reference_index
    u16be(0), u16be(0), u32be(0), u32be(0), u32be(0), // VisualSampleEntry 预留段
    u16be(width), u16be(height),
    u32be(0x00480000), u32be(0x00480000), // horiz/vert resolution 72dpi
    u32be(0),
    u16be(1), // frame_count
    new Uint8Array(32), // compressorname（首字节长度的 Pascal 串，空串=全 0）
    u16be(0x0018), // depth 24bit
    u16be(0xffff), // pre_defined = -1
    box('avcC', avcC), // avcC 记录需再套一层 box 头（FLV/CodecPrivate 中才是裸记录）
  );
  const stsd = fullBox('stsd', 0, 0, u32be(1), avc1);

  const stts = fullBox('stts', 0, 0, u32be(1), u32be(sampleCount), u32be(timescale));
  const stss = fullBox('stss', 0, 0, u32be(1), u32be(1)); // 第 1 个样本为关键帧
  const stsc = fullBox('stsc', 0, 0, u32be(1), u32be(1), u32be(sampleCount), u32be(1));

  const stszParts = [u32be(0), u32be(sampleCount)]; // sample_size=0 ⇒ 逐项查表
  for (const s of sizes) stszParts.push(u32be(s));
  const stsz = fullBox('stsz', 0, 0, ...stszParts);

  function buildStco(chunkOffset) {
    return fullBox('stco', 0, 0, u32be(1), u32be(chunkOffset));
  }
  function buildStbl(chunkOffset) {
    return box('stbl', stsd, stts, stss, stsc, stsz, buildStco(chunkOffset));
  }

  function buildMinf(chunkOffset) {
    return box('minf', vmhd, dinf, buildStbl(chunkOffset));
  }
  function buildMdia(chunkOffset) {
    return box('mdia', mdhd, hdlr, buildMinf(chunkOffset));
  }
  function buildTrak(chunkOffset) {
    return box('trak', tkhd, buildMdia(chunkOffset));
  }
  function buildMoov(chunkOffset) {
    return box('moov', mvhd, buildTrak(chunkOffset));
  }

  /* ---------- 两遍装配：先算 moov 尺寸，再回填 stco 的 mdat 数据起始偏移 ---------- */
  const placeholderMoov = buildMoov(0);
  // stco 字段宽度固定，替换偏移值不会改变任何 box 尺寸
  const mdatDataStart = ftyp.length + placeholderMoov.length + 8; // 跳过 mdat 头部 8 字节
  const moov = buildMoov(mdatDataStart);

  const mdat = box('mdat', ...samples);

  return {
    bytes: concat([ftyp, moov, mdat]),
    meta: {
      width, height, timescale, durationTicks, sampleCount,
      sizes,
      chunkOffsets: [mdatDataStart],
      keyframeSamples: [1],
      brand: 'isom',
    },
  };
}
