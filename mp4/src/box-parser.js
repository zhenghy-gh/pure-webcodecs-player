/**
 * ISO-BMFF box 解析器。
 *
 * 两层 API：
 *  - iterateBoxes(bytes, start, end, visit)：通用顶层/容器遍历（含 largesize、size=0）；
 *  - parseXxx 系列：具体 box → 纯数据对象；parseMoov 汇总为结构树。
 *
 * 解析失败统一抛 PlayerError(PARSE_ERROR)，携带 box 类型与偏移便于定位。
 */
import { ByteStream } from '../../core/src/index.js';
import { parseError } from '../../core/src/errors.js';

/** @typedef {{type:string, size:number, start:number, contentStart:number, end:number}} BoxHeader */

/**
 * 遍历 [start, end) 区间内的顶层 box。visit 返回 false 可提前终止。
 * @param {Uint8Array} bytes
 * @param {(header: BoxHeader) => boolean|void} visit
 */
export function iterateBoxes(bytes, start, end, visit) {
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) {
      if (end - pos > 0 && !isPadding(bytes, pos, end)) {
        throw parseError(`truncated box header at ${pos}`);
      }
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, Math.min(8, end - pos));
    let size = view.getUint32(0, false);
    const type = fourccAt(bytes, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      if (end - pos < 16) throw parseError(`largesize truncated at ${pos}`);
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 16);
      const big = dv.getBigUint64(8, false);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw parseError(`box too large at ${pos}: ${big}`);
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos; // 到父容器末尾
    }
    if (size < headerSize || pos + size > end) {
      throw parseError(`invalid box size ${size} for '${type}' at ${pos} (limit ${end})`);
    }
    const keepGoing = visit({ type, size, start: pos, contentStart: pos + headerSize, end: pos + size });
    if (keepGoing === false) return;
    pos += size;
  }
}

function isPadding(bytes, pos, end) {
  for (let i = pos; i < end; i++) if (bytes[i] !== 0) return false;
  return true;
}

function fourccAt(bytes, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

/* ------------------------------ 基础 fullbox 读法 ------------------------------ */

function readVersionFlags(s) {
  const version = s.readU8();
  const flags = s.readU24();
  return { version, flags };
}

export function parseFtyp(s) {
  return {
    majorBrand: s.readFourCC(),
    minorVersion: s.readU32(),
    compatible: (() => {
      const list = [];
      while (s.remaining >= 4) list.push(s.readFourCC());
      return list;
    })(),
  };
}

export function parseMvhd(s) {
  const { version } = readVersionFlags(s);
  if (version === 1) {
    return {
      creationTime: s.readU64Number(),
      modificationTime: s.readU64Number(),
      timescale: s.readU32(),
      duration: s.readU64Number(),
      rate: s.readFixed16_16(),
      volume: s.readU16() / 256,
    };
  }
  return {
    creationTime: s.readU32(),
    modificationTime: s.readU32(),
    timescale: s.readU32(),
    duration: s.readU32(),
    rate: s.readFixed16_16(),
    volume: s.readU16() / 256,
  };
}

export function parseTkhd(s) {
  const { version, flags } = readVersionFlags(s);
  let out = { enabled: (flags & 1) !== 0 };
  if (version === 1) {
    out.creationTime = s.readU64Number();
    out.modificationTime = s.readU64Number();
    out.trackId = s.readU32();
    s.skip(4);
    out.duration = s.readU64Number();
  } else {
    out.creationTime = s.readU32();
    out.modificationTime = s.readU32();
    out.trackId = s.readU32();
    s.skip(4);
    out.duration = s.readU32();
  }
  s.skip(8); // reserved[2]
  // ISO/IEC 14496-12 tkhd: layer(2) → alternate_group(2) → volume(2) → reserved(2) → matrix(36)
  // 漏读 layer 会让后续字段整体错位 2 字节，最终 width/height 读到矩阵尾部垃圾值（历史实现曾因此恒为 0）
  out.layer = s.readU16();
  out.alternateGroup = s.readU16();
  out.volume = s.readU16() / 256;
  s.skip(2);
  // unity matrix 36 字节
  s.skip(36);
  out.width = Math.round(s.readFixed16_16());
  out.height = Math.round(s.readFixed16_16());
  return out;
}

export function parseMdhd(s) {
  const { version, flags } = readVersionFlags(s);
  void flags;
  let timescale;
  let duration;
  if (version === 1) {
    s.readU64Number();
    s.readU64Number();
    timescale = s.readU32();
    duration = s.readU64Number();
  } else {
    s.readU32();
    s.readU32();
    timescale = s.readU32();
    duration = s.readU32();
  }
  const langRaw = s.readU16();
  const language = String.fromCharCode(
    ((langRaw >> 10) & 0x1f) + 96,
    ((langRaw >> 5) & 0x1f) + 96,
    (langRaw & 0x1f) + 96,
  );
  return { timescale, duration, language };
}

export function parseHdlr(s) {
  const { version, flags } = readVersionFlags(s);
  void version; void flags;
  s.skip(4); // pre_defined
  const handlerType = s.readFourCC();
  s.skip(12); // reserved
  const name = s.remaining > 0 ? s.readCString() : '';
  return { handlerType, name };
}

export function parseElst(s) {
  const { version } = readVersionFlags(s);
  const count = s.readU32();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      entries.push({
        segmentDuration: s.readU64Number(),
        mediaTime: Number(s.readI64()),
        mediaRateInteger: s.readU16(),
        mediaRateFraction: s.readU16(),
      });
    } else {
      entries.push({
        segmentDuration: s.readU32(),
        mediaTime: s.readI32(),
        mediaRateInteger: s.readU16(),
        mediaRateFraction: s.readU16(),
      });
    }
  }
  return { entries };
}

/* ------------------------------ stbl 采样表 ------------------------------ */

export function parseStts(s) {
  readVersionFlags(s);
  const count = s.readU32();
  const runs = [];
  for (let i = 0; i < count; i++) {
    runs.push({ count: s.readU32(), delta: s.readU32() });
  }
  return { runs };
}

export function parseCtts(s) {
  const { version } = readVersionFlags(s);
  const count = s.readU32();
  const runs = [];
  for (let i = 0; i < count; i++) {
    const c = s.readU32();
    const off = version === 0 ? s.readU32() : s.readI32();
    runs.push({ count: c, offset: off });
  }
  return { version, runs };
}

export function parseStss(s) {
  readVersionFlags(s);
  const count = s.readU32();
  const indices = [];
  for (let i = 0; i < count; i++) indices.push(s.readU32() - 1);
  return { indices };
}

export function parseStsc(s) {
  readVersionFlags(s);
  const count = s.readU32();
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      firstChunk: s.readU32() - 1,
      samplesPerChunk: s.readU32(),
      sampleDescriptionIndex: s.readU32(),
    });
  }
  return { entries };
}

export function parseStsz(s) {
  readVersionFlags(s);
  const defaultSize = s.readU32();
  const count = s.readU32();
  if (defaultSize !== 0) return { defaultSize, sizes: null, sampleCount: count };
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = s.readU32();
  return { defaultSize, sizes, sampleCount: count };
}

/**
 * stz2（compact sample size box）：
 *   reserved(3 字节) + field_size(1 字节，4/8/16) + sample_count(4) + 打包尺寸表。
 * 布局与 stsz 不同，不能复用 parseStsz（此前把 field_size 当 defaultSize、
 * 把打包表当 u32 数组读，field_size<32 时静默错解）。返回形状与 parseStsz 一致。
 */
export function parseStz2(s) {
  readVersionFlags(s);
  s.readU24();                    // reserved
  const fieldSize = s.readU8();
  const count = s.readU32();
  const sizes = new Array(count);
  if (fieldSize === 16) {
    for (let i = 0; i < count; i++) sizes[i] = s.readU16();
  } else if (fieldSize === 8) {
    for (let i = 0; i < count; i++) sizes[i] = s.readU8();
  } else if (fieldSize === 4) {
    // 每字节打包 2 个 4 位尺寸，高半字节在前；奇数 count 时末字节低半字节为 padding
    for (let i = 0; i < count; i += 2) {
      const b = s.readU8();
      sizes[i] = (b >> 4) & 0x0f;
      if (i + 1 < count) sizes[i + 1] = b & 0x0f;
    }
  } else {
    throw parseError(`stz2 field_size=${fieldSize} 不支持（仅 4/8/16）`);
  }
  return { defaultSize: 0, sizes, sampleCount: count };
}

export function parseStco(s, isCo64 = false) {
  readVersionFlags(s);
  const count = s.readU32();
  const offsets = new Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = isCo64 ? s.readU64Number() : s.readU32();
  }
  return { offsets, isCo64 };
}

/* ------------------------ sample description 与解码配置 ------------------------ */

/** VisualSampleEntry 公共字段之后的子 box 集合 */
function parseVisualEntry(s) {
  s.skip(6 + 2); // SampleEntry 头
  s.skip(2 + 2 + 12); // pre_defined/reserved
  const width = s.readU16();
  const height = s.readU16();
  s.skip(4 + 4 + 4); // hres/vres/reserved
  s.skip(2); // frame_count
  s.skip(32); // compressorname
  s.skip(2 + 2); // depth(u16) + pre_defined(int16)，共 4 字节
  const children = collectChildren(s);
  return { width, height, children };
}

function parseAudioEntry(s) {
  s.skip(6 + 2); // SampleEntry 头
  const version = s.readU16();
  const revision = s.readU16();
  const vendor = s.readFourCC();
  let channelCount;
  let sampleSize;
  let sampleRate;
  if (version === 0) {
    channelCount = s.readU16();
    sampleSize = s.readU16();
    s.skip(2 + 2); // pre_defined/reserved
    sampleRate = s.readFixed16_16();
  } else if (version === 1) {
    channelCount = s.readU16();
    sampleSize = s.readU16();
    s.skip(2 + 2);
    sampleRate = s.readFixed16_16();
    // v1 扩展段固定 16 字节：
    // samples_per_packet(4)/bytes_per_packet(4)/bytes_per_frame(4)/bytes_per_sample(4)
    s.skip(16);
  } else {
    // version 2：QuickTime 扩展
    s.skip(4 + 4); // reserved[2]
    const rateF64 = s.readF64();
    channelCount = s.readU32();
    sampleSize = s.readU32();
    s.skip(4); // format flags
    s.skip(4); // reserved
    sampleRate = Math.round(rateF64);
  }
  const children = collectChildren(s);
  return { version, revision, vendor, channelCount, sampleSize, sampleRate, children };
}

function collectChildren(s) {
  const children = {};
  const start = s.position;
  const end = start + s.remaining;
  try {
    iterateBoxes(s.bytes, s.position, end, (h) => {
      children[h.type] = parseBoxByType(new ByteStream(s.bytes, h.contentStart, h.end - h.contentStart), h.type);
    });
  } catch (err) {
    // 尾部垃圾（QuickTime wave 等非规范数据）可容忍；但一个子 box 都没解析到时
    // 说明偏移错了，必须暴露问题而不是静默吞掉。
    if (Object.keys(children).length === 0) throw err;
  }
  return children;
}

/** esds → AudioSpecificConfig 等（MPEG-4 descriptor 链：0x03 > 0x04 > 0x05） */
export function parseEsds(s) {
  readVersionFlags(s);
  const bytes = s.bytes.subarray(s.position);
  const out = {
    audioSpecificConfig: null,
    objectTypeIndication: null,
    streamType: null,
    maxBitrate: 0,
    avgBitrate: 0,
  };
  walkDescriptors(bytes, 0, bytes.length, (tag, ps, pe) => {
    if (tag !== 0x03) return; // ES_Descriptor
    // ES_ID(2) + flags(1)
    const innerStart = ps + 3;
    walkDescriptors(bytes, innerStart, pe, (t2, ps2, pe2) => {
      if (t2 !== 0x04) return; // DecoderConfigDescriptor
      const dv = new DataView(bytes.buffer, bytes.byteOffset + ps2, pe2 - ps2);
      out.objectTypeIndication = dv.getUint8(0);       // [0]
      out.streamType = dv.getUint8(1) >> 2;            // [1] 高 6 位
      // DCD 固定头 13 字节布局：
      //   oti(1)+streamType(1)+bufferSizeDB(3)+maxBitrate(4)+avgBitrate(4)
      out.maxBitrate = dv.getUint32(5, false);         // [5..8]
      out.avgBitrate = dv.getUint32(9, false);         // [9..12]
      // DCD 固定头：oti(1)+streamType(1)+bufferSizeDB(3)+maxBitrate(4)+avgBitrate(4) = 13 字节
      walkDescriptors(bytes, ps2 + 13, pe2, (t3, ps3, pe3) => {
        if (t3 === 0x05) {
          // decSpecificInfo → AudioSpecificConfig 原始字节
          out.audioSpecificConfig = bytes.slice(ps3, pe3);
        }
      });
    });
  });
  return out;
}

function walkDescriptors(bytes, pos, end, cb) {
  while (pos + 2 <= end) {
    const tag = bytes[pos];
    let len = 0;
    let p = pos + 1;
    let b;
    do {
      if (p >= end) return;
      b = bytes[p++];
      len = (len << 7) | (b & 0x7f);
    } while (b & 0x80);
    cb(tag, p, p + len);
    pos = p + len;
  }
}

const VISUAL_ENTRIES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'encv', 's263', 'mp4v', 'jpeg', 'png ', 'apcn', 'apch']);
const AUDIO_ENTRIES = new Set(['mp4a', 'enca', 'samr', 'sawb', 'ac-3', 'ec-3', 'alac']);

/** 按 fourcc 分派的 sample entry 解析（含解码配置提取） */
export function parseSampleEntry(type, s) {
  if (VISUAL_ENTRIES.has(type)) {
    const e = parseVisualEntry(s);
    return finalizeEntry(type, e, e.children);
  }
  if (AUDIO_ENTRIES.has(type)) {
    const e = parseAudioEntry(s);
    return finalizeEntry(type, e, e.children);
  }
  // 未识别类型：只记录类型与原始字节
  return { type, raw: true, children: {} };
}

function finalizeEntry(type, entry, children) {
  entry.type = type;
  entry.avcC = children.avcC ?? null;
  entry.hvcC = children.hvcC ?? null;
  entry.esds = children.esds ?? null;
  entry.btrt = children.btrt ?? null;
  entry.pasp = children.pasp ?? null;
  entry.chan = children.chan ?? null;
  entry.wave = children.wave ?? null;
  return entry;
}

export function parseAvcC(s) {
  return { bytes: s.readBytes(s.remaining) };
}
export function parseHvcC(s) {
  return { bytes: s.readBytes(s.remaining) };
}

/* --------------------------------- fMP4 分片侧 --------------------------------- */

export function parseTfhd(s) {
  const { flags } = readVersionFlags(s);
  const out = {};
  out.trackId = s.readU32();
  if (flags & 0x000001) out.baseDataOffset = s.readU64Number();
  if (flags & 0x000002) out.sampleDescriptionIndex = s.readU32();
  if (flags & 0x000008) out.defaultSampleDuration = s.readU32();
  if (flags & 0x000010) out.defaultSampleSize = s.readU32();
  if (flags & 0x000020) out.defaultSampleFlags = s.readU32();
  out.defaultBaseIsMoof = (flags & 0x020000) !== 0;
  return out;
}

export function parseTfdt(s) {
  const { version } = readVersionFlags(s);
  return { baseMediaDecodeTime: version === 1 ? s.readU64Number() : s.readU32(), version };
}

export function parseTrun(s) {
  const { version, flags } = readVersionFlags(s);
  const sampleCount = s.readU32();
  const out = { sampleCount, dataOffset: null, firstSampleFlags: null, samples: [] };
  if (flags & 0x000001) out.dataOffset = s.readI32();
  if (flags & 0x000004) out.firstSampleFlags = s.readU32();
  for (let i = 0; i < sampleCount; i++) {
    const rec = {};
    rec.duration = flags & 0x000100 ? s.readU32() : undefined;
    rec.size = flags & 0x000200 ? s.readU32() : undefined;
    rec.flags = flags & 0x000400 ? s.readU32() : undefined;
    rec.cts =
      flags & 0x000800 ? (version === 0 ? s.readU32() : s.readI32()) : 0;
    out.samples.push(rec);
  }
  out.hasPerSampleDuration = (flags & 0x000100) !== 0;
  out.hasPerSampleSize = (flags & 0x000200) !== 0;
  return out;
}

export function parseMvex(s) {
  const trexByTrack = {};
  let mehd = null;
  iterateBoxes(s.bytes, s.position, s.position + s.remaining, (h) => {
    const sub = new ByteStream(s.bytes, h.contentStart, h.end - h.contentStart);
    if (h.type === 'trex') {
      readVersionFlags(sub);
      trexByTrack[sub.readU32()] = {
        defaultSampleDescriptionIndex: sub.readU32(),
        defaultSampleDuration: sub.readU32(),
        defaultSampleSize: sub.readU32(),
        defaultSampleFlags: sub.readU32(),
      };
    } else if (h.type === 'mehd') {
      const { version } = readVersionFlags(sub);
      mehd = { fragmentDuration: version === 1 ? sub.readU64Number() : sub.readU32() };
    }
  });
  return { trexByTrack, mehd };
}

/** 按 box 类型分派到具体解析器（未知类型返回 null） */
export function parseBoxByType(s, type) {
  switch (type) {
    case 'ftyp': return parseFtyp(s);
    case 'mvhd': return parseMvhd(s);
    case 'tkhd': return parseTkhd(s);
    case 'mdhd': return parseMdhd(s);
    case 'hdlr': return parseHdlr(s);
    case 'elst': return parseElst(s);
    case 'stts': return parseStts(s);
    case 'ctts': return parseCtts(s);
    case 'stss': return parseStss(s);
    case 'stsc': return parseStsc(s);
    case 'stsz': return parseStsz(s);
    case 'stz2': return parseStz2(s);
    case 'stco': return parseStco(s, false);
    case 'co64': return parseStco(s, true);
    case 'esds': return parseEsds(s);
    case 'avcC': return parseAvcC(s);
    case 'hvcC': return parseHvcC(s);
    case 'tfhd': return parseTfhd(s);
    case 'tfdt': return parseTfdt(s);
    case 'trun': return parseTrun(s);
    case 'mvex': return parseMvex(s);
    default:
      if (VISUAL_ENTRIES.has(type) || AUDIO_ENTRIES.has(type)) {
        return parseSampleEntry(type, s);
      }
      return null;
  }
}

/** moov 结构树汇总（trak 数组内含采样表与 sample entry）。
 *  兼容两种入参：含 moov 头的完整 box（自动剥离）或纯内容字节。 */
export function parseMoov(moovBytes) {
  const result = { mvhd: null, traks: [], mvex: null };
  let start = 0;
  let end = moovBytes.byteLength;
  // 若传入的是完整 moov box（偏移 4 处为 'moov'），跳过头部进入内容区
  if (
    moovBytes.byteLength >= 8 &&
    String.fromCharCode(moovBytes[4], moovBytes[5], moovBytes[6], moovBytes[7]) === 'moov'
  ) {
    const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, Math.min(16, moovBytes.byteLength));
    let size = dv.getUint32(0, false);
    let headerSize = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(8, false));
      headerSize = 16;
    } else if (size === 0) {
      size = moovBytes.byteLength;
    }
    start = headerSize;
    end = Math.min(size, moovBytes.byteLength);
  }
  iterateBoxes(moovBytes, start, end, (h) => {
    const s = new ByteStream(moovBytes, h.contentStart, h.end - h.contentStart);
    if (h.type === 'mvhd') result.mvhd = parseMvhd(s);
    else if (h.type === 'trak') result.traks.push(parseTrak(moovBytes.subarray(h.start, h.end)));
    else if (h.type === 'mvex') result.mvex = parseMvex(s);
  });
  if (!result.mvhd) throw parseError('moov missing mvhd');
  return result;
}

export function parseTrak(trakBytes) {
  const trak = { tkhd: null, mdhd: null, hdlr: null, elst: null, sampleEntry: null, stbl: {} };
  // 兼容传入完整 trak box（含头部）或纯内容：探测偏移 4 处的 fourcc
  let start = 0;
  let end = trakBytes.byteLength;
  if (
    trakBytes.byteLength >= 8 &&
    String.fromCharCode(trakBytes[4], trakBytes[5], trakBytes[6], trakBytes[7]) === 'trak'
  ) {
    const dv = new DataView(trakBytes.buffer, trakBytes.byteOffset, Math.min(16, trakBytes.byteLength));
    start = 8;
    end = Math.min(dv.getUint32(0, false) || trakBytes.byteLength, trakBytes.byteLength);
  }
  iterateBoxes(trakBytes, start, end, (h) => {
    if (h.type === 'tkhd') trak.tkhd = parseTkhd(new ByteStream(trakBytes, h.contentStart, h.end - h.contentStart));
    else if (h.type === 'edts') {
      iterateBoxes(trakBytes, h.contentStart, h.end, (eh) => {
        if (eh.type === 'elst') trak.elst = parseElst(new ByteStream(trakBytes, eh.contentStart, eh.end - eh.contentStart));
      });
    } else if (h.type === 'mdia') {
      iterateBoxes(trakBytes, h.contentStart, h.end, (mh) => {
        const ms = new ByteStream(trakBytes, mh.contentStart, mh.end - mh.contentStart);
        if (mh.type === 'mdhd') trak.mdhd = parseMdhd(ms);
        else if (mh.type === 'hdlr') trak.hdlr = parseHdlr(ms);
        else if (mh.type === 'minf') {
          iterateBoxes(trakBytes, mh.contentStart, mh.end, (ih) => {
            if (ih.type !== 'stbl') return;
            iterateBoxes(trakBytes, ih.contentStart, ih.end, (sh) => {
              const ss = new ByteStream(trakBytes, sh.contentStart, sh.end - sh.contentStart);
              if (sh.type === 'stsd') {
                trak.stbl.stsd = parseStsd(ss);
                trak.sampleEntry = trak.stbl.stsd.entries[0] ?? null;
              } else if (sh.type in TABLE_PARSERS) {
                trak.stbl[sh.type] = TABLE_PARSERS[sh.type](ss);
              }
            });
          });
        }
      });
    }
  });
  return trak;
}

const TABLE_PARSERS = {
  stts: parseStts,
  ctts: parseCtts,
  stss: parseStss,
  stsc: parseStsc,
  stsz: parseStsz,
  stz2: parseStz2,
  stco: (s) => parseStco(s, false),
  co64: (s) => parseStco(s, true),
};

export function parseStsd(s) {
  readVersionFlags(s);
  const count = s.readU32();
  const entries = [];
  iterateBoxes(s.bytes, s.position, s.position + s.remaining, (h) => {
    if (entries.length >= count) return false;
    const entryBytes = s.bytes.subarray(h.start, h.end);
    // 契约：parseXxx 一律从 box 内容区开始（跳过 8 字节头）
    entries.push(parseSampleEntry(h.type, new ByteStream(entryBytes, 8)));
  });
  return { entries };
}
