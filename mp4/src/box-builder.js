/**
 * ISO-BMFF box 构造器：程序化拼装 MP4/fMP4 结构。
 *
 * 双重用途：
 * 1. Fmp4Remuxer 产出 init segment / media segment；
 * 2. __tests__ 程序化生成 fixture（不依赖真实大文件）。
 *
 * 全部基于 core 的 ByteWriter，大端、无第三方依赖。
 */
import { ByteWriter } from '../../core/src/index.js';
import { notSupported, parseError } from '../../core/src/errors.js';

/** 包一层 box 头（size 自动回填，支持 >4GB 用 largesize）；导出供 remuxer 组合容器 box */
export function box(type, buildBody) {
  const w = new ByteWriter(256);
  const sizePos = w.length;
  w.writeU32(0).writeFourCC(type);
  const before = w.length;
  buildBody(w);
  const bodyLen = w.length - before;
  if (bodyLen <= 0xffffffff - 8) {
    w.patchU32(sizePos, 8 + bodyLen);
  } else {
    // largesize：size=1，真实长度写在类型之后
    const out = new Uint8Array(16 + bodyLen);
    const head = new ByteWriter(16);
    head.writeU32(1).writeFourCC(type).writeU64(BigInt(16 + bodyLen));
    out.set(head.toUint8Array(), 0);
    out.set(w.toUint8Array().subarray(8), 16);
    return out;
  }
  return w.toUint8Array();
}

/** fullbox：version + flags 前缀（导出供测试与扩展容器拼装） */
export function fullBox(type, version, flags, buildBody) {
  return box(type, (w) => {
    w.writeU8(version).writeU24(flags);
    buildBody(w);
  });
}

export function buildFtyp({ majorBrand = 'isom', minorVersion = 512, compatible = ['isom', 'iso2', 'avc1', 'mp41'] } = {}) {
  return box('ftyp', (w) => {
    w.writeFourCC(majorBrand).writeU32(minorVersion);
    for (const b of compatible) w.writeFourCC(b);
  });
}

export function buildFree(size = 8) {
  return box('free', (w) => {
    for (let i = 8; i < size; i += 4) w.writeU32(0);
  });
}

/** mdat：payload 直接拼接（可传数组避免大拷贝） */
export function buildMdat(payloadChunks) {
  let total = 0;
  const chunks = payloadChunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  for (const c of chunks) total += c.byteLength;
  const head = new ByteWriter(8);
  head.writeU32(total + 8).writeFourCC('mdat');
  const out = new Uint8Array(total + 8);
  out.set(head.toUint8Array(), 0);
  let pos = 8;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/**
 * mvhd（movie header）。duration=0 表示未知（直播/渐进）。
 */
export function buildMvhd({ timescale = 1000, duration = 0, nextTrackId = 3, creationTime = 0, modificationTime = 0 } = {}) {
  return fullBox('mvhd', 0, 0, (w) => {
    w.writeU32(creationTime).writeU32(modificationTime);
    w.writeU32(timescale).writeU32(duration);
    w.writeFixed16_16(0x00010000); // rate 1.0
    w.writeU16(0x0100); // volume 1.0
    w.writeU16(0).writeU32(0).writeU32(0); // reserved
    w.writeMatrix(); // unity matrix
    for (let i = 0; i < 6; i++) w.writeU32(0); // pre_defined
    w.writeU32(nextTrackId);
  });
}

/**
 * tkhd。video: width/height 为 16.16 定点；audio: 音量 1.0、宽高 0。
 */
export function buildTkhd({ trackId, duration = 0, isVideo = false, isAudio = false, width = 0, height = 0, volume = undefined, alternateGroup = 0 } = {}) {
  const flags = 0x000003; // enabled | in_movie
  return fullBox('tkhd', 0, flags, (w) => {
    w.writeU32(0).writeU32(0); // creation/modification
    w.writeU32(trackId).writeU32(0); // track_id / reserved
    w.writeU32(duration);
    w.writeU32(0).writeU32(0); // reserved[2]
    w.writeU16(0); // layer（ISO 标准字段，缺失会让 alternateGroup/volume/矩阵整体错位）
    w.writeU16(alternateGroup);
    const vol = volume !== undefined ? volume : isAudio ? 0x0100 : 0;
    w.writeU16(vol);
    w.writeU16(0); // reserved
    w.writeMatrix();
    w.writeFixed16_16(isVideo ? width : 0);
    w.writeFixed16_16(isVideo ? height : 0);
  });
}

/** edts/elst：编辑列表（QuickTime 空编辑 media_time=-1 也走这里） */
export function buildEdts({ entries = [] } = {}) {
  if (entries.length === 0) return null;
  const elst = fullBox('elst', 0, 0, (w) => {
    w.writeU32(entries.length);
    for (const e of entries) {
      w.writeU32(e.segmentDuration ?? 0);
      w.writeI32(e.mediaTime ?? 0);
      w.writeU16(e.mediaRateInteger ?? 1).writeU16(0);
    }
  });
  return box('edts', (w) => w.writeRaw(elst));
}

export function buildMdhd({ timescale, duration = 0, language = 'und' } = {}) {
  // language: 3 字符 × 5bit 打包（首字符在最高位），ISO-639-2/T
  const lang = (language || 'und').padEnd(3, 'u').slice(0, 3)
    .toLowerCase()
    .split('')
    .reduce((acc, ch, i) => acc | ((ch.charCodeAt(0) - 96) << ((2 - i) * 5)), 0);
  return fullBox('mdhd', 0, 0, (w) => {
    w.writeU32(0).writeU32(0);
    w.writeU32(timescale).writeU32(duration);
    w.writeU16(lang).writeU16(0);
  });
}

/** hdlr：handler_type 'vide'|'soun'，name 以 \0 结尾 */
export function buildHdlr({ handlerType, name = '' } = {}) {
  return fullBox('hdlr', 0, 0, (w) => {
    w.writeU32(0); // pre_defined
    w.writeFourCC(handlerType);
    w.writeU32(0).writeU32(0).writeU32(0); // reserved
    w.writeUtf8(name).writeU8(0);
  });
}

export function buildVmhd() {
  return fullBox('vmhd', 0, 1, (w) => {
    w.writeU16(0).writeU16(0).writeU16(0).writeU16(0); // graphicsmode/opcolor
  });
}

export function buildSmhd() {
  return fullBox('smhd', 0, 0, (w) => {
    w.writeU16(0); // balance
    w.writeU16(0); // reserved
  });
}

export function buildDinf() {
  return box('dinf', (w) => {
    w.writeRaw(
      fullBox('dref', 0, 0, (dw) => {
        dw.writeU32(1);
        dw.writeRaw(fullBox('url ', 0, 1, () => {})); // self-contained
      }),
    );
  });
}

/** avcC 直接透传解码私有配置字节 */
export function buildAvcC(bytes) {
  return box('avcC', (w) => w.writeRaw(bytes));
}

export function buildHvcC(bytes) {
  return box('hvcC', (w) => w.writeRaw(bytes));
}

/**
 * esds：包装 AudioSpecificConfig（AAC 必需）。
 * 构造 DecoderConfigDescriptor(0x04) + SLError? 正确 tag 链：
 *   ES_Descriptor(0x03) > DecoderConfigDescriptor(0x04) > decSpecificInfo(0x05)
 */
export function buildEsds(audioSpecificConfig, { objectTypeIndication = 0x40, streamType = 5 /* audio */, bufferSizeDb = 0, maxBitrate = 0, avgBitrate = 0 } = {}) {
  const asc = audioSpecificConfig instanceof Uint8Array ? audioSpecificConfig : new Uint8Array(audioSpecificConfig);
  // decSpecificInfo (tag 0x05)
  const dsi = writeDescriptor(0x05, asc);
  // DecoderConfigDescriptor (tag 0x04): oti(1) streamType/upStream/reserved(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4) + dsi
  const dcdBody = new ByteWriter(64);
  dcdBody.writeU8(objectTypeIndication);
  dcdBody.writeU8((streamType << 2) | 1);
  dcdBody.writeU24(bufferSizeDb);
  dcdBody.writeU32(maxBitrate);
  dcdBody.writeU32(avgBitrate);
  dcdBody.writeRaw(dsi);
  const dcd = writeDescriptor(0x04, dcdBody.toUint8Array());
  // ES_Descriptor (tag 0x03): ES_ID(2) flags(1) + dcd（flags=0 无 FMO 等）
  const esBody = new ByteWriter(16);
  esBody.writeU16(1); // ES_ID
  esBody.writeU8(0); // flags
  esBody.writeRaw(dcd);
  const es = writeDescriptor(0x03, esBody.toUint8Array());
  return fullBox('esds', 0, 0, (w) => w.writeRaw(es));
}

/** MPEG-4 descriptor：tag + 变长长度（128 系） */
function writeDescriptor(tag, payload) {
  const w = new ByteWriter(payload.byteLength + 6);
  w.writeU8(tag);
  let len = payload.byteLength;
  const bytes = [];
  do {
    bytes.unshift(len & 0x7f);
    len >>>= 7;
  } while (len > 0);
  for (let i = 0; i < bytes.length; i++) {
    w.writeU8((i < bytes.length - 1 ? 0x80 : 0x00) | bytes[i]);
  }
  w.writeRaw(payload);
  return w.toUint8Array();
}

/** btrt（码率信息，可选增强） */
export function buildBtrt({ bufferSizeDb = 0, maxBitrate = 0, avgBitrate = 0 } = {}) {
  return box('btrt', (w) => {
    w.writeU32(bufferSizeDb).writeU32(maxBitrate).writeU32(avgBitrate);
  });
}

/** 视觉 sample entry 公共体（avc1/hev1/hvc1...） */
function visualSampleEntry(fourcc, { width, height }, children) {
  return box(fourcc, (w) => {
    // SampleEntry: reserved[6] + data_reference_index
    for (let i = 0; i < 6; i++) w.writeU8(0);
    w.writeU16(1);
    // VisualSampleEntry
    w.writeU16(0).writeU16(0); // pre_defined / reserved
    for (let i = 0; i < 3; i++) w.writeU32(0); // pre_defined[3]
    w.writeU16(width & 0xffff).writeU16(height & 0xffff);
    w.writeU32(0x00480000).writeU32(0x00480000); // 72dpi
    w.writeU32(0);
    w.writeU16(1); // frame_count
    // compressorname: 长度前缀字符串（≤31），全零 32 字节即可
    w.writeU8(0);
    for (let i = 0; i < 31; i++) w.writeU8(0);
    w.writeU16(0x0018); // depth 24bit
    w.writeU16(0xffff); // pre_defined = -1（规范为 int16）
    for (const c of children) w.writeRaw(c);
  });
}

/** 音频 sample entry（mp4a） */
function audioSampleEntry(fourcc, { channelCount = 2, sampleSize = 16, sampleRate = 44100 }, children) {
  return box(fourcc, (w) => {
    for (let i = 0; i < 6; i++) w.writeU8(0);
    w.writeU16(1);
    // AudioSampleEntry v0
    for (let i = 0; i < 2; i++) w.writeU32(0); // reserved[2]
    w.writeU16(channelCount).writeU16(sampleSize);
    w.writeU16(0).writeU16(0); // pre_defined / reserved
    w.writeU32(Math.round(sampleRate * 65536)); // 16.16
    for (const c of children) w.writeRaw(c);
  });
}

/** stsd：单条 sample description + 解码配置 */
export function buildStsd(track) {
  const entry = (() => {
    switch (track.sampleEntryType) {
      case 'avc1':
      case 'avc2':
      case 'avc3':
      case 'avc4': {
        const children = [buildAvcC(track.codecPrivate)];
        return visualSampleEntry(track.sampleEntryType, track, children);
      }
      case 'hvc1':
      case 'hev1': {
        const children = [buildHvcC(track.codecPrivate)];
        return visualSampleEntry(track.sampleEntryType, track, children);
      }
      case 'mp4a':
      case 'enca': {
        const children = [buildEsds(track.codecPrivate)];
        return audioSampleEntry(track.sampleEntryType, track, children);
      }
      default:
        throw notSupported(`unsupported sample entry: ${track.sampleEntryType}`);
    }
  })();
  return fullBox('stsd', 0, 0, (w) => {
    w.writeU32(1);
    w.writeRaw(entry);
  });
}

/** stts：[(count, delta)] 游程 */
export function buildStts(runs) {
  return fullBox('stts', 0, 0, (w) => {
    w.writeU32(runs.length);
    for (const r of runs) w.writeU32(r.count).writeU32(r.delta);
  });
}

/** ctts：version 1（有符号偏移） */
export function buildCtts(offsets) {
  if (!offsets || offsets.length === 0) return null;
  return fullBox('ctts', 1, 0, (w) => {
    w.writeU32(offsets.length);
    for (const o of offsets) {
      w.writeU32(o.count).writeI32(o.offset);
    }
  });
}

export function buildStss(indices) {
  if (!indices || indices.length === 0) return null;
  return fullBox('stss', 0, 0, (w) => {
    w.writeU32(indices.length);
    for (const i of indices) w.writeU32(i + 1); // 1-based
  });
}

/** stsc：[(firstChunk, samplesPerChunk, sampleDescIndex)] */
export function buildStsc(entries) {
  return fullBox('stsc', 0, 0, (w) => {
    w.writeU32(entries.length);
    for (const e of entries) {
      w.writeU32(e.firstChunk + 1); // 1-based
      w.writeU32(e.samplesPerChunk);
      w.writeU32(e.sampleDescriptionIndex ?? 1);
    }
  });
}

/** stsz：定长或变长 */
export function buildStsz(sizes, defaultSize = 0) {
  return fullBox('stsz', 0, 0, (w) => {
    w.writeU32(defaultSize).writeU32(defaultSize === 0 ? sizes.length : 0);
    if (defaultSize === 0) for (const s of sizes) w.writeU32(s);
  });
}

/** stco：32 位 chunk offset（>4GB 才用 co64） */
export function buildStco(offsets) {
  return fullBox('stco', 0, 0, (w) => {
    w.writeU32(offsets.length);
    for (const o of offsets) w.writeU32(o);
  });
}

/**
 * 组装一个完整 trak 的 moov（progressive MP4 用）。
 * @param {{
 *   tracks: Array<{track: object, sizes:number[], keyframeIndices?:number[], chunkOffsets:number[], samplesPerChunk:number, sttsRuns:Array, cttsOffsets?:Array}>,
 *   timescale?: number, duration?: number
 * }} spec
 */
export function buildMoov(spec) {
  const timescale = spec.timescale ?? 1000;
  let nextTrackId = 1;
  const traks = spec.tracks.map(({ track, ...tables }) => {
    nextTrackId = Math.max(nextTrackId, track.id + 1);
    const isVideo = track.type === 'video';
    const isAudio = track.type === 'audio';
    return box('trak', (w) => {
      w.writeRaw(buildTkhd({
        trackId: track.id,
        duration: track.duration,
        isVideo,
        isAudio,
        width: track.width,
        height: track.height,
      }));
      w.writeRaw(
        box('mdia', (mw) => {
          mw.writeRaw(buildMdhd({ timescale: track.timescale, duration: track.duration, language: track.language }));
          mw.writeRaw(buildHdlr({ handlerType: isVideo ? 'vide' : isAudio ? 'soun' : 'meta', name: `${track.sampleEntryType} handler` }));
          mw.writeRaw(
            box('minf', (iw) => {
              iw.writeRaw(isVideo ? buildVmhd() : isAudio ? buildSmhd() : fullBox('nmhd', 0, 0, () => {}));
              iw.writeRaw(buildDinf());
              iw.writeRaw(
                box('stbl', (sw) => {
                  sw.writeRaw(buildStsd(track));
                  sw.writeRaw(buildStts(tables.sttsRuns ?? [{ count: tables.sizes.length, delta: 1000 }]));
                  const ctts = buildCtts(tables.cttsOffsets);
                  if (ctts) sw.writeRaw(ctts);
                  const stss = buildStss(tables.keyframeIndices);
                  if (stss) sw.writeRaw(stss);
                  sw.writeRaw(buildStsc([{ firstChunk: 0, samplesPerChunk: tables.samplesPerChunk ?? 1 }]));
                  sw.writeRaw(buildStsz(tables.sizes));
                  sw.writeRaw(buildStco(tables.chunkOffsets));
                }),
              );
            }),
          );
        }),
      );
    });
  });

  return box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale, duration: spec.duration ?? 0, nextTrackId }));
    for (const t of traks) w.writeRaw(t);
  });
}

/* ============================ fMP4 分片侧 ============================ */

export function buildTrex({ trackId, defaultSampleDescriptionIndex = 1, defaultSampleDuration = 1024, defaultSampleSize = 0, defaultSampleFlags = 0 } = {}) {
  return fullBox('trex', 0, 0, (w) => {
    w.writeU32(trackId);
    w.writeU32(defaultSampleDescriptionIndex);
    w.writeU32(defaultSampleDuration);
    w.writeU32(defaultSampleSize);
    w.writeU32(defaultSampleFlags);
  });
}

/** moov 里的 mvex（fMP4 标志） */
export function buildMvex(trackIds, defaults = undefined) {
  return box('mvex', (w) => {
    for (const id of trackIds) {
      w.writeRaw(buildTrex({ trackId: id, ...(defaults?.[id] ?? {}) }));
    }
  });
}

export function buildMfhd(sequenceNumber) {
  return fullBox('mfhd', 0, 0, (w) => w.writeU32(sequenceNumber));
}

/**
 * tfhd：引用 trex 默认值 + base-data-is-moof。
 */
export function buildTfhd({ trackId, defaultSampleDuration = 0, defaultSampleSize = 0, defaultSampleFlags = 0 }) {
  const flags =
    0x020000 | // default-base-is-moof
    0x000020 |
    0x000010 |
    0x000008; // defaults present
  return fullBox('tfhd', 0, flags, (w) => {
    w.writeU32(trackId);
    w.writeU32(defaultSampleDuration);
    w.writeU32(defaultSampleSize);
    w.writeU32(defaultSampleFlags);
  });
}

export function buildTfdt(baseMediaDecodeTime, version = 1) {
  return fullBox('tfdt', version, 0, (w) => {
    if (version === 1) w.writeU64(BigInt(baseMediaDecodeTime));
    else w.writeU32(baseMediaDecodeTime);
  });
}

/** sample flags：关键帧 0x02000000，非关键帧 0x01010000 */
export function sampleFlagsFor(isKeyframe) {
  return isKeyframe ? 0x02000000 : 0x01010000;
}

/**
 * trun（version 1，带符号 cts）。dataOffset 先写 0，由 createMediaSegment 回填。
 */
export function buildTrun(samples, dataOffsetPlaceholder = true) {
  const flags =
    0x000001 | // data-offset present
    0x000100 | // per-sample duration
    0x000200 | // per-sample size
    0x000400 | // per-sample flags
    0x000800; // per-sample composition time offset (signed, v1)
  return fullBox('trun', 1, flags, (w) => {
    const dataOffsetPos = w.length;
    w.writeU32(samples.length);
    w.writeI32(dataOffsetPlaceholder ? 0 : 0); // patch later
    for (const s of samples) {
      w.writeU32(s.duration);
      w.writeU32(s.size);
      w.writeU32(sampleFlagsFor(s.keyframe));
      w.writeI32(s.cts ?? s.pts - s.dts ?? 0);
    }
    void dataOffsetPos;
  });
}

/**
 * 组装 moof+mdat media segment，返回 {data, dataOffset}。
 * dataOffset = moof 长度 + 8（mdat 头），即第一个样本在段内的偏移。
 */
export function buildMoofMdat({ sequenceNumber, trackId, baseMediaDecodeTime, samples }) {
  const payloads = samples.map((s) => s.data);
  const mdat = buildMdat(payloads);

  // 先拼 moof（trun 的 data_offset 需要 moof 总长，先按占位算）
  const moofW = new ByteWriter(mdat.byteLength + 512);
  const moofSizePos = moofW.length;
  moofW.writeU32(0).writeFourCC('moof');
  const bodyStart = moofW.length;
  moofW.writeRaw(buildMfhd(sequenceNumber));
  moofW.writeRaw(
    box('traf', (tw) => {
      tw.writeRaw(buildTfhd({ trackId }));
      tw.writeRaw(buildTfdt(baseMediaDecodeTime));
      tw.writeRaw(buildTrun(samples, true));
    }),
  );
  const moofLen = 8 + (moofW.length - bodyStart);
  moofW.patchU32(moofSizePos, moofLen);
  const moof = moofW.toUint8Array();

  // data_offset：样本数据相对 moof 起点的偏移 = moof 长度 + mdat 头 8 字节
  const dataOffset = moof.byteLength + 8;

  // 重写 trun 内的 data_offset：定位 trun 的 sample_count 前 4 字节
  // （buildTrun 里 sample_count 位于 trun 内容第 4..8 字节处）
  const trunDataOffsetAbs = findTrunDataOffset(moof);
  const patched = moof.slice();
  new DataView(patched.buffer).setInt32(trunDataOffsetAbs, dataOffset, false);

  const out = new Uint8Array(moof.byteLength + mdat.byteLength);
  out.set(patched, 0);
  out.set(mdat, moof.byteLength);
  return { data: out, dataOffset };
}

/** 在 moof 中定位 trun 的 data_offset 字段绝对位置 */
function findTrunDataOffset(moof) {
  // 扫描 fourcc 'trun'，其后 version+flags(4) + sample_count(4) 即 data_offset
  for (let i = 0; i + 4 <= moof.byteLength; i++) {
    if (
      moof[i] === 0x74 && moof[i + 1] === 0x72 && // 'tr'
      moof[i + 2] === 0x75 && moof[i + 3] === 0x6e // 'un'
    ) {
      return i + 4 + 4 + 4;
    }
  }
  throw parseError('trun not found in moof');
}
