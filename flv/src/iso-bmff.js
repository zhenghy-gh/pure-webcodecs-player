/**
 * iso-bmff.js —— ISO-BMFF(fMP4) 盒子构造器
 *
 * 只写不读，输出 Uint8Array。覆盖 MSE 所需的最小集合：
 *   ftyp / moov(mvhd, trak(tkhd, mdia(mdhd, hdlr, minf(vmhd|smhd, dinf(dref(url)),
 *   stbl(stsd(avc1|hvc1|mp4a(esds)), stts, stsc, stsz, stco)))), mvex(trex))
 *   moof(mfhd, traf(tfhd, tfdt, trun)) / mdat
 */

const textEncoder = new TextEncoder();

/** 拼接若干 Uint8Array */
export function concatBytes(list) {
  if (list.length === 1) return list[0];
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/** 四字符码 → 字节 */
function fourcc(str) {
  return textEncoder.encode(str);
}

/** 基础盒子：size(4) + type(4) + payload */
export function box(type, ...payloads) {
  const body = concatBytes(payloads);
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(fourcc(type), 4);
  out.set(body, 8);
  return out;
}

/** fullBox：size + type + version(1) + flags(3) + payload */
export function fullBox(type, version, flags, ...payloads) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, head, ...payloads);
}

// ---------- 各盒子 ----------

export function ftypBox() {
  return box('ftyp',
    fourcc('isom'),            // major brand
    u32(512),                  // minor version
    fourcc('isom'),
    fourcc('iso6'),
    fourcc('avc1'),
    fourcc('mp41'),
  );
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function u16(v) {
  const b = new Uint8Array(2);
  b[0] = (v >> 8) & 0xff;
  b[1] = v & 0xff;
  return b;
}

export function mvhdBox(timescale) {
  return fullBox('mvhd', 0, 0,
    u32(0), u32(0),                       // creation/modification
    u32(timescale),
    u32(0),                               // duration（流式未知）
    u32(0x00010000),                      // rate
    u16(0x0100),                          // volume
    u16(0), u32(0), u32(0),               // reserved
    matrixUnity(),                        // unity matrix
    new Uint8Array(24),                   // pre_defined[6]
    u32(2),                               // next_track_id
  );
}

function matrixUnity() {
  const m = new Uint8Array(36);
  const v = new DataView(m.buffer);
  v.setUint32(0, 0x00010000);           // a
  v.setUint32(16, 0x00010000);          // d
  v.setUint32(28, 0x40000000);          // w
  return m;
}

export function trakBox(...children) {
  return box('trak', ...children);
}

export function tkhdBox({ trackId, width = 0, height = 0 }) {
  return fullBox('tkhd', 0, 7,        // flags: enabled+in_movie+in_preview
    u32(0), u32(0),                     // creation/modification
    u32(trackId),
    u32(0),                             // reserved
    u32(0),                             // duration
    u32(0), u32(0),                     // reserved[2]
    u16(0),                             // layer
    u16(0),                             // alternate_group
    // 音轨 volume=0x0100；视频 width/height 高 16 位
    u16(0),
    u16(0),                             // 视频时 rotation 用不到，置 0
    matrixUnity(),
    u32(Math.round(width * 65536)),
    u32(Math.round(height * 65536)),
  );
}

export function mdiaBox(...children) {
  return box('mdia', ...children);
}

export function mdhdBox(timescale) {
  return fullBox('mdhd', 0, 0,
    u32(0), u32(0),
    u32(timescale),
    u32(0),
    u16(0x55c4),                        // language 'und'
    u16(0),
  );
}

export function hdlrBox(kind) {
  const handler = kind === 'video' ? 'vide' : 'soun';
  const name = kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0';
  return fullBox('hdlr', 0, 0,
    u32(0),
    fourcc(handler),
    u32(0), u32(0), u32(0),
    textEncoder.encode(name),
  );
}

export function minfBox(...children) {
  return box('minf', ...children);
}

export function vmhdBox() {
  return fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
}

export function smhdBox() {
  return fullBox('smhd', 0, 0, u16(0), u16(0));
}

export function dinfBox() {
  return box('dinf',
    fullBox('dref', 0, 0,
      u32(1),
      fullBox('url ', 0, 1),            // self-contained
    ),
  );
}

/** avc1/hvc1 采样描述 */
export function videoSampleEntry(entryType, { width, height }, configBox) {
  const body = new Uint8Array(78);
  const view = new DataView(body.buffer);
  body.set(new Uint8Array(6), 0);       // reserved
  view.setUint16(6, 1);                 // data_reference_index
  view.setUint16(8, 0);                 // pre_defined
  view.setUint16(10, 0);                // reserved
  view.setUint32(12, 0);                // pre_defined[3]
  for (let i = 12; i < 24; i++) body[i] = 0;
  view.setUint16(24, width);
  view.setUint16(26, height);
  view.setUint32(28, 0x00480000);       // hres 72dpi
  view.setUint32(32, 0x00480000);       // vres
  view.setUint32(36, 0);                // reserved
  view.setUint16(40, 1);                // frame_count
  // compressorname: 32 字节（首字节长度），置空
  view.setUint16(74, 0x0018);           // depth = 24
  view.setUint16(76, 0xffff);           // pre_defined -1
  return box(entryType, body, configBox);
}

/** mp4a 采样描述（含 esds） */
export function audioSampleEntry(sampleRate, channels, asc) {
  const body = new Uint8Array(28);
  const view = new DataView(body.buffer);
  body.set(new Uint8Array(6), 0);
  view.setUint16(6, 1);                 // data_reference_index
  view.setUint16(8, 0);                 // version
  view.setUint16(10, 0);                // revision
  view.setUint32(12, 0);                // vendor
  view.setUint16(16, channels);
  view.setUint16(18, 16);               // sample_size
  view.setUint16(20, 0);                // compression_id
  view.setUint16(22, 0);                // packet_size
  view.setUint32(24, (sampleRate << 16) >>> 0); // 16.16 定点采样率
  return box('mp4a', body, esdsBox(asc));
}

/** ES_Descriptor 封装 ASC */
export function esdsBox(asc) {
  const decoderSpecific = descriptor(0x05, asc);
  const decoderConfig = descriptor(0x04, concatBytes([
    Uint8Array.from([0x40]),            // objectTypeIndication: MPEG-4 AAC
    Uint8Array.from([0x15]),            // streamType(audio)<<2 | up(1) | reserved(1)
    Uint8Array.from([0, 0, 0]),         // bufferSizeDB
    u32(0), u32(0),                     // maxBitrate / avgBitrate
    decoderSpecific,
  ]));
  const slConfig = descriptor(0x06, Uint8Array.from([0x02]));
  const esDescriptor = descriptor(0x03, concatBytes([
    u16(1),                             // ES_ID
    Uint8Array.from([0x00]),            // flags
    decoderConfig,
    slConfig,
  ]));
  return fullBox('esds', 0, 0, esDescriptor);
}

function descriptor(tag, payload) {
  if (payload.length < 128) {
    return concatBytes([Uint8Array.from([tag, payload.length]), payload]);
  }
  // expandable 形式：高位置 0 表示最后一字节
  const n = payload.length;
  const lenBytes = [
    0x80 | ((n >> 21) & 0x7f),
    0x80 | ((n >> 14) & 0x7f),
    0x80 | ((n >> 7) & 0x7f),
    n & 0x7f,
  ];
  return concatBytes([Uint8Array.from([tag, ...lenBytes]), payload]);
}

export function stblBox(...children) {
  return box('stbl', ...children);
}

/** 流式 stbl：各表留空，实际样本走 moof/trun */
export function emptyStblBoxes(sampleEntry) {
  return [
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
    fullBox('stsd', 0, 0, u32(1), sampleEntry),   // entry_count + 采样描述
  ];
}

export function mvexBox(tracks) {
  const trexs = tracks.map((t) => fullBox('trex', 0, 0,
    u32(t.trackId),
    u32(1),             // default_sample_description_index
    u32(t.defaultDuration ?? 0),
    u32(t.defaultSize ?? 0),
    u32(t.defaultFlags ?? 0),
  ));
  return box('mvex', ...trexs);
}

// ---------- 媒体分片 ----------

export function moofBox({ seqNo, trackId, baseDts, samples }) {
  const tfFlags = 0x020000 | 0x02;      // default-base-is-moof | sample-description-index

  // trun v1：data-offset(0x001)+duration(0x100)+size(0x200)+cts(0x400)
  // 首样本为关键帧时再加 first-sample-flags(0x004)，把首帧标记为同步样本
  const firstIsSync = !!samples[0].keyframe;
  const trunFlags = 0x701 | (firstIsSync ? 0x004 : 0);
  const firstFlags = 0x02000000;        // depends_on=2(I) 且为同步样本

  const trunPayloads = [];
  trunPayloads.push(u32(samples.length));
  trunPayloads.push(u32(0));            // data_offset 占位，remuxer 回填真实偏移
  if (firstIsSync) trunPayloads.push(u32(firstFlags));
  for (const s of samples) {
    trunPayloads.push(u32(s.duration));
    trunPayloads.push(u32(s.size));
    trunPayloads.push(u32((s.cts ?? 0) >>> 0));   // unsigned composition time
  }
  const trun = fullBox('trun', 1, trunFlags, ...trunPayloads);

  const tfdt = fullBox('tfdt', 1, 0, u32(baseDts >>> 0));
  const tfhd = fullBox('tfhd', 0, tfFlags, u32(trackId), u32(1));
  const traf = box('traf', tfhd, tfdt, trun);
  const mfhd = fullBox('mfhd', 0, 0, u32(seqNo));
  return box('moof', mfhd, traf);
}

export function mdatBox(payload) {
  return box('mdat', payload);
}
