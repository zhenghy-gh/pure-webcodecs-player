/**
 * fixtures/build-ts.mjs —— 程序化生成最小合法 MPEG-TS 字节序列
 *
 * 仅服务于单测：按 ISO 13818-1 语法逐字段构造 TS 包 / PSI / PES / ADTS / LATM，
 * 不依赖任何外部样例文件。所有“写入”与 src 的“读取”一一对应，形成闭环验证。
 */

import { BitWriter } from '../../src/bits.js';

// ---------- 基础 TS 包 ----------

let globalCc = new Map();

/** 重置连续计数器（每个测试文件组装前调用） */
export function resetCc() {
  globalCc = new Map();
}

/**
 * 构造单个 188 字节 TS 包。
 * @param {number} pid
 * @param {Uint8Array} payload 有效载荷（调用方保证 ≤184）
 * @param {{ pusi?:boolean, stuffing?:boolean }} [opts]
 */
export function tsPacket(pid, payload, opts = {}) {
  const pkt = new Uint8Array(188);
  pkt[0] = 0x47;
  const cc = (globalCc.get(pid) ?? 0) & 0x0f;
  globalCc.set(pid, (cc + 1) & 0x0f);

  pkt[1] = (opts.pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;

  const pad = 184 - payload.length;
  if (pad === 0) {
    pkt[3] = 0x10 | cc; // 无 AF
    pkt.set(payload.subarray(0, 184), 4);
  } else {
    // 自适应域填充：length(+flags)+stuff；afLen 可为 0（仅长度字节）
    const afLen = pad - 1;
    pkt[3] = 0x30 | cc; // AF + payload
    pkt[4] = afLen;
    if (afLen > 0) {
      pkt[5] = 0x00;                       // flags
      for (let i = 6; i < 5 + afLen; i++) pkt[i] = 0xff;
    }
    pkt.set(payload, 4 + 1 + afLen);
  }
  return pkt;
}

/** 把任意长数据切进多个 TS 包（首个含 PUSI），返回包数组 */
export function dataToPackets(pid, data, opts = {}) {
  const out = [];
  let pos = 0;
  let first = true;
  while (pos < data.length) {
    const chunk = data.subarray(pos, Math.min(pos + 184, data.length));
    pos += chunk.length;
    out.push(tsPacket(pid, chunk, { ...opts, pusi: first && (opts.pusi ?? true) }));
    first = false;
  }
  return out;
}

// ---------- PSI ----------

function crc32Mpeg(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/**
 * 构造完整 PSI section（table_id + 头 + body + CRC32）。
 */
export function buildSection(tableId, bodyBytes, extra = {}) {
  // section_length 统计“长度字段之后”的字节：
  //   transport_stream_id(2)+version(1)+section_number(1)+last_section(1) + body + CRC(4)
  const bodyLength = bodyBytes.length + 9;
  const head = new Uint8Array(8);
  head[0] = tableId;
  head[1] = 0xb0 | ((bodyLength >> 8) & 0x0f);   // section_syntax=1 '0' reserved
  head[2] = bodyLength & 0xff;
  head[3] = (extra.streamIdHi ?? 0x00);
  head[4] = (extra.streamIdLo ?? 0x01);
  head[5] = 0xc1 | ((extra.version ?? 0) << 1);   // reserved+version+current_next
  head[6] = extra.sectionNumber ?? 0;
  head[7] = extra.lastSectionNumber ?? 0;

  const noCrc = new Uint8Array(head.length + bodyBytes.length);
  noCrc.set(head);
  noCrc.set(bodyBytes, head.length);
  const crc = crc32Mpeg(noCrc);
  const section = new Uint8Array(noCrc.length + 4);
  section.set(noCrc);
  section[noCrc.length] = (crc >>> 24) & 0xff;
  section[noCrc.length + 1] = (crc >>> 16) & 0xff;
  section[noCrc.length + 2] = (crc >>> 8) & 0xff;
  section[noCrc.length + 3] = crc & 0xff;
  return section;
}

/** PAT：programs=[{number,pid}]（number 0 会作为 NIT 被解析端跳过） */
export function buildPAT(programs, version = 0) {
  const w = new BitWriter();
  for (const p of programs) {
    w.writeBits(p.number, 16);
    w.writeBits(0xe000 | p.pid, 16);
  }
  return buildSection(0x00, w.finish(), { streamIdHi: 0x00, streamIdLo: 0x01, version });
}

/** PMT：streams=[{streamType,pid}] */
export function buildPMT({ pcrPid = 0x1000, streams }, version = 0) {
  const w = new BitWriter();
  w.writeBits(0xe000 | pcrPid, 16);
  w.writeBits(0xf000, 16);                       // program_info_length=0
  for (const s of streams) {
    w.writeBits(s.streamType, 8);
    w.writeBits(0xe000 | s.pid, 16);
    w.writeBits(0xf000, 16);                     // ES_info_length=0
  }
  return buildSection(0x02, w.finish(), { version });
}

/** 将一个 section 封装进 TS 包序列（pointer_field=0；跨包自动续） */
export function sectionToPackets(pid, section) {
  return dataToPackets(pid, concatBytes([new Uint8Array([0]), section]));
}

// ---------- PES ----------

import { encodeTimestamp5 } from '../../src/pes.js';

/**
 * 构造完整 PES。
 * @param {number} streamId 0xE0 视频 / 0xC0 音频
 * @param {Uint8Array} esPayload ES 数据
 * @param {{ pts?:number, dts?:number }} ts 90kHz tick
 */
export function buildPes(streamId, esPayload, { pts, dts } = {}) {
  const hasPts = pts != null;
  const hasDts = dts != null;
  const flags1 = hasPts ? (hasDts ? 0xc0 : 0x80) : 0x00;
  const headerParts = [];
  if (hasPts) headerParts.push(encodeTimestamp5(pts, hasDts ? 0b0011 : 0b0010));
  if (hasDts) headerParts.push(encodeTimestamp5(dts, 0b0001));
  const headerData = concatBytes(headerParts);

  const bodyLen = 3 + headerData.length + esPayload.length;
  // 视频在 TS 中允许 declaredLength=0（不限长）；能放下时尽量写真实值
  const declaredLen = bodyLen <= 0xffff ? bodyLen : 0;

  const head = new Uint8Array(9);
  head.set([0, 0, 1, streamId, (declaredLen >> 8) & 0xff, declaredLen & 0xff, 0x80, flags1, headerData.length]);
  return concatBytes([head, headerData, esPayload]);
}

// ---------- H.264 ----------

/**
 * 构造 H.264 SPS（Baseline，pic_order_cnt_type=2）。
 * 宽高不必为 16 倍数：不足处自动写入 frame_cropping（裁剪量记在右/下侧）。
 */
export function h264Sps(width = 320, height = 240) {
  const widthMbs = Math.ceil(width / 16);
  const heightMapUnits = Math.ceil(height / 16);
  const cropHTotal = (widthMbs * 16 - width) / 2;   // 水平裁剪总量（CropUnitX=2）
  const cropVTotal = (heightMapUnits * 16 - height) / 2; // CropUnitY=2

  const w = new BitWriter();
  w.writeBits(0x67, 8);            // nal_ref_idc=3 type=7
  w.writeBits(66, 8);              // profile_idc = Baseline
  w.writeBits(0xc0, 8);            // constraint flags
  w.writeBits(30, 8);              // level_idc
  w.writeUE(0);                    // seq_parameter_set_id
  w.writeUE(4);                    // log2_max_frame_num_minus4
  w.writeUE(2);                    // pic_order_cnt_type = 2
  w.writeUE(1);                    // max_num_ref_frames
  w.writeBits(0, 1);               // gaps_in_frame_num_value_allowed
  w.writeUE(widthMbs - 1);         // pic_width_in_mbs_minus1
  w.writeUE(heightMapUnits - 1);   // pic_height_in_map_units_minus1
  w.writeBits(1, 1);               // frame_mbs_only_flag
  w.writeBits(1, 1);               // direct_8x8_inference_flag
  if (cropHTotal > 0 || cropVTotal > 0) {
    w.writeBits(1, 1);             // frame_cropping_flag
    w.writeUE(0);                  // frame_crop_left_offset
    w.writeUE(cropHTotal);         // frame_crop_right_offset
    w.writeUE(0);                  // frame_crop_top_offset
    w.writeUE(cropVTotal);         // frame_crop_bottom_offset
  } else {
    w.writeBits(0, 1);
  }
  w.writeBits(0, 1);               // vui_parameters_present_flag
  rbspTrailing(w);
  return w.finish();
}

/** 最小合法 PPS */
export function h264Pps() {
  const w = new BitWriter();
  w.writeBits(0x68, 8);            // type=8
  w.writeUE(0);                    // pic_parameter_set_id
  w.writeUE(0);                    // seq_parameter_set_id
  w.writeBits(0, 1);               // entropy_coding_mode (CAVLC)
  w.writeBits(0, 1);               // bottom_field_pic_order
  w.writeUE(0);                    // num_slice_groups_minus1
  w.writeUE(0);                    // num_ref_idx_l0_minus1
  w.writeUE(0);                    // num_ref_idx_l1_minus1
  w.writeBits(0, 1);               // weighted_pred
  w.writeBits(0, 2);               // weighted_bipred_idc
  w.writeSE(0);                    // pic_init_qp_minus26
  w.writeSE(0);                    // pic_init_qs_minus26
  w.writeSE(0);                    // chroma_qp_index_offset
  w.writeBits(0, 1);               // deblocking_filter_control_present
  w.writeBits(0, 1);               // constrained_intra_pred
  w.writeBits(0, 1);               // redundant_pic_cnt_present
  rbspTrailing(w);
  return w.finish();
}

/** 填充型 IDR 切片（解析层只做 NALU 分类，不需要真实宏块数据） */
export function h264IdrSlice(size = 64) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x65;                 // ref_idc=3 type=5
  for (let i = 1; i < size; i++) bytes[i] = 0xaa | (i & 0x07); // 避免伪起始码
  return bytes;
}

/** 非 IDR 切片 */
export function h264NonIdrSlice(size = 48) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x41;                 // ref_idc=2 type=1
  for (let i = 1; i < size; i++) bytes[i] = 0x55 | (i & 0x07);
  return bytes;
}

export function annexb(...nalus) {
  const parts = [];
  for (const nalu of nalus) {
    parts.push(new Uint8Array([0, 0, 0, 1]));
    parts.push(nalu);
  }
  return concatBytes(parts);
}

// ---------- H.265 ----------

/** HEVC NAL 头两字节：type 高位在前，layer/tid 固定为 0x01 */
function hevcNalHeader(type) {
  return [(type << 1) & 0x7e, 0x01];
}

export function hevcVps() {
  const w = new BitWriter();
  const [b0] = hevcNalHeader(32);
  w.writeBits(b0, 8);
  w.writeBits(0x01, 8);
  // 简化 VPS：解析层只做 NALU 分类，内容不追求完整语法
  for (let i = 0; i < 8; i++) w.writeBits(0xa0 | (i & 0x07), 8);
  rbspTrailing(w);
  return w.finish();
}

/**
 * @param {number} width
 * @param {number} height
 * @param {{chromaFormatIdc?:number, bitDepthLumaMinus8?:number, bitDepthChromaMinus8?:number, temporalIdNesting?:number}} [opts]
 *   chromaFormatIdc：1=4:2:0 / 2=4:2:2 / 3=4:4:4；bitDepth*=2 即 main10。
 */
export function hevcSps(width = 256, height = 144, opts = {}) {
  const {
    chromaFormatIdc = 1,
    bitDepthLumaMinus8 = 0,
    bitDepthChromaMinus8 = 0,
    temporalIdNesting = 1,
  } = opts;
  const w = new BitWriter();
  w.writeBits(hevcNalHeader(33)[0], 8);   // SPS
  w.writeBits(0x01, 8);                   // layer/tid
  w.writeBits(0, 4);                      // sps_video_parameter_set_id
  w.writeBits(0, 3);                      // sps_max_sub_layers_minus1
  w.writeBits(temporalIdNesting ? 1 : 0, 1); // temporal_id_nesting
  // profile_tier_level(1, 0)：96 bits
  w.writeBits(0, 2);                      // profile_space
  w.writeBits(0, 1);                      // tier
  w.writeBits(1, 5);                      // profile_idc = Main
  w.writeBits(0x40000000, 32);            // compat flag bit1（Main）
  for (let i = 0; i < 48; i++) w.writeBits(0, 1);  // constraint flags
  w.writeBits(93, 8);                     // level_idc (L3.1)
  w.writeUE(0);                           // sps_seq_parameter_set_id
  w.writeUE(chromaFormatIdc);             // chroma_format_idc
  w.writeUE(width);                       // pic_width_in_luma_samples
  w.writeUE(height);                      // pic_height_in_luma_samples
  w.writeBits(0, 1);                      // conformance_window_flag
  // bit_depth_*_minus8：hvcC 的色深字段来源（main10 = 2）
  w.writeUE(bitDepthLumaMinus8);
  w.writeUE(bitDepthChromaMinus8);
  rbspTrailing(w);
  return w.finish();
}

export function hevcPps() {
  const bytes = new Uint8Array(8);
  const [b0] = hevcNalHeader(34);
  bytes[0] = b0;
  bytes[1] = 0x01;
  for (let i = 2; i < 8; i++) bytes[i] = 0x33 | i;
  return bytes;
}

export function hevcIdrSlice(size = 64) {
  const [b0] = hevcNalHeader(19);         // IDR_W_RADL
  const bytes = new Uint8Array(size);
  bytes[0] = b0;
  bytes[1] = 0x01;
  for (let i = 2; i < size; i++) bytes[i] = 0xa7 | (i & 0x07);
  return bytes;
}

export function hevcTrailSlice(size = 48) {
  const [b0] = hevcNalHeader(1);          // TRAIL_R
  const bytes = new Uint8Array(size);
  bytes[0] = b0;
  bytes[1] = 0x01;
  for (let i = 2; i < size; i++) bytes[i] = 0x5a | (i & 0x07);
  return bytes;
}

// ---------- AAC ----------

/**
 * ADTS 帧。@param raw AAC 裸帧负载 @param frameLen 显式指定帧长（默认按负载算）
 */
export function adtsFrame(raw, { sampleRateIndex = 4, channels = 2, mpeg2 = false, withCrc = false, frameLen } = {}) {
  const headerSize = withCrc ? 9 : 7;
  const len = frameLen ?? headerSize + raw.length;
  const w = new BitWriter();
  w.writeBits(0xfff, 12);
  w.writeBits(mpeg2 ? 1 : 0, 1);
  w.writeBits(0, 2);
  w.writeBits(withCrc ? 0 : 1, 1);       // protection_absent
  w.writeBits(1, 2);                     // profile: LC(AOT2)-1
  w.writeBits(sampleRateIndex, 4);
  w.writeBits(0, 1);
  w.writeBits(channels, 3);
  w.writeBits(0, 4);                     // original/home/copyright bits
  w.writeBits(len & 0x1fff, 13);
  w.writeBits(0x7ff, 11);
  w.writeBits(0, 2);                     // num_raw_blocks-1
  w.alignByte();
  const head = w.finish();
  if (!withCrc) return concatBytes([head, raw]);
  const crc = new Uint8Array([0xde, 0xad]);
  return concatBytes([head.slice(0, 7), crc, raw]);
}

/** 按本仓库 LATM 简化语法构造一个 AudioSyncStream 单元 */
export function latmStream({ aot = 2, sampleRateIndex = 4, channels = 2, raw }) {
  // 先写主体（syncword 之后的部分）
  const w = new BitWriter();
  w.writeBits(0, 1);        // useSameStreamMux = 0 → 携带配置
  w.writeBits(0, 1);        // audioMuxVersion = 0
  w.writeBits(1, 1);        // allStreamsSameTimeFraming
  w.writeBits(0, 6);        // numSubFrames
  w.writeBits(0, 4);        // numPrograms - 1
  w.writeBits(0, 3);        // numLayers - 1
  // AudioSpecificConfig（补零对齐到整 2 字节，与解析端一致）
  w.writeBits(aot, 5);
  w.writeBits(sampleRateIndex, 4);
  w.writeBits(channels, 4);
  w.writeBits(0, 3);
  // 帧参数
  w.writeBits(0, 3);        // frameLengthType = 0
  w.writeBits(0, 6);        // slotLengthList[0]
  // PayloadLengthInfo
  w.writeBits(raw.length, 8);
  w.alignByte();
  const body = concatBytes([w.finish(), raw]);

  // 头部：syncword + audioMuxLengthBytes（body 长度）
  const hw = new BitWriter();
  hw.writeBits(0x2b7, 11);
  hw.writeBits(body.length, 13);
  return concatBytes([hw.finish(), body]);
}

// ---------- 整流组装 ----------

export const STREAM_TYPE = {
  H264: 0x1b,
  HEVC: 0x24,
  AAC_ADTS: 0x0f,
  AAC_LATM: 0x11,
};

/**
 * 组装一个完整的节目流。
 * @param {{
 *   video?: { codec:'h264'|'hevc', width?:number, height?:number,
 *             frames:number, gopSize?:number },
 *   audio?: { mode:'adts'|'latm', framesPerPes?:number,
 *             sampleRateIndex?:number, channels?:number, count?:number }
 * }} cfg
 */
export function assembleTs(cfg) {
  resetCc();
  const VIDEO_PID = 0x0101;
  const AUDIO_PID = 0x0102;
  const PMT_PID = 0x1000;
  const packets = [];

  const streams = [];
  if (cfg.video) streams.push({ streamType: cfg.video.codec === 'h264' ? STREAM_TYPE.H264 : STREAM_TYPE.HEVC, pid: VIDEO_PID });
  if (cfg.audio) streams.push({ streamType: cfg.audio.mode === 'latm' ? STREAM_TYPE.AAC_LATM : STREAM_TYPE.AAC_ADTS, pid: AUDIO_PID });

  packets.push(...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])));
  packets.push(...sectionToPackets(PMT_PID, buildPMT({ pcrPid: VIDEO_PID, streams })));

  let videoPts = 90000;             // 从 1 秒开始，留出正时间余量
  const audioTick = 1024;
  let audioPts = 90000;

  if (cfg.video) {
    const { codec, frames = 8, gopSize = 4 } = cfg.video;
    const makeSlice = codec === 'h264'
      ? { idr: h264IdrSlice, nonIdr: h264NonIdrSlice, paramSets: () => [h264Sps(cfg.video.width ?? 320, cfg.video.height ?? 240), h264Pps()] }
      : { idr: hevcIdrSlice, nonIdr: hevcTrailSlice, paramSets: () => [hevcVps(), hevcSps(cfg.video.width ?? 256, cfg.video.height ?? 144), hevcPps()] };
    const frameDuration = 3003;     // ≈29.97fps
    for (let f = 0; f < frames; f++) {
      const isKey = f % gopSize === 0;
      const nalus = isKey ? [...makeSlice.paramSets(), makeSlice.idr()] : [makeSlice.nonIdr()];
      const es = annexb(...nalus);
      const pes = buildPes(0xe0, es, { pts: videoPts, dts: videoPts });
      packets.push(...dataToPackets(VIDEO_PID, pes));
      videoPts += frameDuration;
    }
  }

  if (cfg.audio) {
    const { mode, framesPerPes = 2, count = 8, sampleRateIndex = 4, channels = 2 } = cfg.audio;
    let emitted = 0;
    while (emitted < count) {
      const n = Math.min(framesPerPes, count - emitted);
      const rawFrames = [];
      for (let i = 0; i < n; i++) {
        rawFrames.push(new Uint8Array(32).fill(0x5c ^ i));   // 假裸帧
      }
      let pes;
      if (mode === 'adts') {
        const frames = rawFrames.map((raw) => adtsFrame(raw, { sampleRateIndex, channels }));
        pes = buildPes(0xc0, concatBytes(frames), { pts: audioPts });
      } else {
        const units = rawFrames.map((raw) => latmStream({ sampleRateIndex, channels, raw }));
        pes = buildPes(0xc0, concatBytes(units), { pts: audioPts });
      }
      packets.push(...dataToPackets(AUDIO_PID, pes));
      // 音频 PTS 步进：每帧 1024 个 44.1k tick ≈ 23ms；此处统一用 90k 域近似
      audioPts += Math.round((n * audioTick * 90000) / 44100);
      emitted += n;
    }
  }

  return concatBytes(packets);
}

function rbspTrailing(w) {
  w.writeBits(1, 1);      // stop bit
  w.alignByte();          // 补零
}

function concatBytes(list) {
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
