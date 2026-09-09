/**
 * samples/fixtures/ts.js —— makeTS()：程序化生成结构合法的 MPEG-TS 字节流。
 *
 * 结构：188 字节定长包序列：
 *   PAT  （PID 0x0000，program 1 → PMT_PID）
 *   PMT  （默认 PID 0x1000，PCR_PID = 视频 PID；H264 流 + 可选 AAC 流）
 *   N 个访问单元：PES（含 PTS/DTS）拆包进 TS 包，
 *                每个访问单元首包带 PCR（自适应字段），不足处用 0xFF 填充。
 *
 * 约定：载荷为伪 H.264/AAC 数据，但同步字节、PSI 的 CRC32/MPEG-2、
 *       连续计数器步进、PES 头与 PTS/DTS 编码全部符合 ISO/IEC 13818-1。
 */

import {
  u8, concat, u16be, crc32Mpeg2,
} from './bytes.js';
import { makeAnnexbAvcSample, makeAdtsAacFrame } from './codecs.js';

const PACKET_SIZE = 188;

/* ---------------- PTS/DTS 编码 ---------------- */

/**
 * 编码 33bit 展示时间戳。
 * @param {number} prefix 4bit 前缀：'0010'(0x2)=仅 PTS；'0011'(0x3)=有 DTS 时的 PTS；'0001'(0x1)=DTS
 */
export function encodePts(prefix, t) {
  const v = BigInt(t) & 0x1ffffffffn; // 33 bit
  const out = new Uint8Array(5);
  out[0] = ((prefix & 0xf) << 4) | (Number((v >> 30n) & 7n) << 1) | 1;
  const mid = Number((v >> 15n) & 0x7fffn); // 中段 15bit
  const low = Number(v & 0x7fffn); // 低段 15bit
  out[1] = (mid >> 7) & 0xff;
  out[2] = ((mid & 0x7f) << 1) | 1; // marker 位
  out[3] = (low >> 7) & 0xff;
  out[4] = ((low & 0x7f) << 1) | 1;
  return out;
}

/** 从 5 字节解码 PTS/DTS（测试回读用） */
export function decodePts(b) {
  const hi = BigInt((b[0] >> 1) & 0x07);
  const mid = BigInt((((b[1] << 8) | b[2]) >> 1) & 0x7fff);
  const low = BigInt((((b[3] << 8) | b[4]) >> 1) & 0x7fff);
  return Number((hi << 30n) | (mid << 15n) | low);
}

/* ---------------- TS 包 / 自适应字段 ---------------- */

/**
 * 组装单个 TS 包。
 * @param {object} o {pid, pusi, cc, pcrBase?, payload}
 *                   pcrBase 存在时该包携带 PCR（90kHz 基准 + 0 扩展）；
 *                   载荷不足 184 字节时自动用自适应字段填充：
 *                     - 携带 PCR：AF = 标志(含 PCR_flag) + 6 字节 PCR + 0xFF 填充；
 *                     - 纯填充：AF = 长度 + 标志 + 0xFF 填充（长度可为 0，即无标志）。
 */
function buildTsPacket({ pid, pusi = false, cc, pcrBase = null, payload }) {
  const bytes = new Uint8Array(PACKET_SIZE);
  bytes[0] = 0x47;
  bytes[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  bytes[2] = pid & 0xff;
  bytes[3] = 0x10 | (cc & 0x0f); // 加扰 00；默认 af_control=01（无 AF、满载荷）

  let writePos = 4;
  const SPACE = PACKET_SIZE - 4; // 头后可用 184 字节

  if (pcrBase !== null) {
    // 有 PCR 的包：调用方保证 payload ≤ 176
    bytes[3] = (bytes[3] & 0xcf) | 0x30; // af_control=11
    const stuffLen = SPACE - 8 - payload.length;
    bytes[4] = 7 + stuffLen;
    bytes[5] = 0x10; // PCR_flag=1
    const base = BigInt(pcrBase) & 0x1ffffffffn; // 33bit @90kHz
    const ext = 0;
    bytes[6] = Number((base >> 25n) & 0xffn);
    bytes[7] = Number((base >> 17n) & 0xffn);
    bytes[8] = Number((base >> 9n) & 0xffn);
    bytes[9] = Number((base >> 1n) & 0xffn);
    bytes[10] = (Number(base & 1n) << 7) | 0x7e | ((ext >> 8) & 0x01); // 保留位固定 0x7E
    bytes[11] = ext & 0xff;
    bytes.fill(0xff, 12, SPACE - payload.length + 4);
    writePos = SPACE - payload.length + 4;
  } else if (payload.length === SPACE) {
    // 恰好填满：无需自适应字段
    writePos = 4;
  } else if (payload.length === SPACE - 1) {
    // 仅剩 1 字节空隙：合法的零长度自适应字段（无标志位）
    bytes[3] = (bytes[3] & 0xcf) | 0x30;
    bytes[4] = 0;
    writePos = 5;
  } else {
    // 常规填充：AF = 长度字节 + 标志字节 + N 个 0xFF
    bytes[3] = (bytes[3] & 0xcf) | 0x30;
    const afLen = SPACE - 1 - payload.length;
    bytes[4] = afLen;
    bytes[5] = 0x00; // 无 PCR/优先级等标志
    bytes.fill(0xff, 6, SPACE - payload.length + 4);
    writePos = SPACE - payload.length + 4;
  }
  bytes.set(payload, writePos);
  return bytes;
}

/** 把一段字节流按容量拆进连续 TS 包（首个包可选 PCR），返回包数组并维护 CC。 */
function segmentIntoPackets(pid, ccRef, data, { pcrOnFirst = false, pcrBase = 0 } = {}) {
  const packets = [];
  let pos = 0;
  let first = true;
  while (pos < data.length) {
    const wantPcr = first && pcrOnFirst;
    const capacity = wantPcr ? PACKET_SIZE - 4 - 8 : PACKET_SIZE - 4; // 预留 AF 最小开销
    const take = Math.min(capacity, data.length - pos);
    packets.push(buildTsPacket({
      pid,
      pusi: first,
      cc: ccRef.n++,
      pcrBase: wantPcr ? pcrBase : null,
      payload: data.subarray(pos, pos + take),
    }));
    pos += take;
    first = false;
  }
  return packets;
}

/* ---------------- PSI（PAT/PMT）---------------- */

/**
 * 构造一个完整 PSI section（table_id → CRC32 全覆盖），再装入 PUSI 的 TS 包。
 * @param {number} tableId 0x00=PAT, 0x02=PMT
 * @param {number} extId table_id_extension：PAT=transport_stream_id，PMT=program_number
 * @param {Uint8Array} loopBody 版本区之后的循环体
 */
function buildPsiSection(tableId, extId, loopBody, version = 0) {
  const afterLength = concat([
    u16be(extId),
    u8(0xc0 | ((version & 0x1f) << 1) | 1), // 当前有效 + version
    u8(0x00), // section_number
    u8(0x00), // last_section_number
    loopBody,
  ]);
  const sectionLength = afterLength.length + 4; // 含 CRC
  const head = concat([u8(tableId), u16be(0xb000 | sectionLength)]);
  const crc = crc32Mpeg2(concat(head, afterLength));
  return concat(head, afterLength, u32beOf(crc));
}

function u32beOf(n) {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

/* ---------------- PES ---------------- */

/** 组装一个完整 PES 包（视频 stream_id=0xE0，音频 AAC 用 0xC0） */
function buildPes(streamId, pts, dts, payload) {
  const hasDts = dts != null && dts !== pts;
  const headerData = hasDts
    ? concat(encodePts(0x3, pts), encodePts(0x1, dts))
    : encodePts(0x2, pts);
  const bodyLen = 3 + headerData.length + payload.length;
  return concat([
    u8(0x00, 0x00, 0x01),
    u8(streamId),
    u16be(bodyLen),
    u8(0x80), // '10' + 标志位
    hasDts ? u8(0xc0) : u8(0x80), // PTS_only 或 PTS+DTS
    u8(headerData.length),
    headerData,
    payload,
  ]);
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {object} [opts]
 * @param {number}  [opts.auCount=3]     视频访问单元数
 * @param {boolean} [opts.withAudio=false] 是否加 AAC 音频流（ADTS）
 * @param {number}  [opts.pmtPid=0x1000] PMT 所在 PID
 * @param {number}  [opts.videoPid=0x0100] 视频 ES 的 PID（同时是 PCR PID）
 * @param {number}  [opts.audioPid=0x0101] 音频 ES 的 PID
 * @param {number}  [opts.ptsStep=3000]  相邻 AU 的 PTS 步进（90kHz 下 ≈ 33ms）
 * @param {number}  [opts.auPadBytes=0]  每个 AU 追加的填充字节数（>176 时强制跨包，测试分段用）
 * @returns {{bytes: Uint8Array, meta: object}}
 */
export function makeTS(opts = {}) {
  const {
    auCount = 3,
    withAudio = false,
    pmtPid = 0x1000,
    videoPid = 0x0100,
    audioPid = 0x0101,
    ptsStep = 3000,
    auPadBytes = 0,
  } = opts;

  const ccRefs = new Map(); // 每个 PID 独立连续计数器
  const ccOf = (pid) => (ccRefs.has(pid) ? ccRefs.get(pid) : { n: 0 });
  const packets = [];

  function emit(pid, ...args) {
    const ref = ccOf(pid);
    ccRefs.set(pid, ref);
    packets.push(...segmentIntoPackets(pid, ref, ...args));
  }

  /* PAT：program 1 → PMT PID（PSI 载荷首字节是 pointer_field=0） */
  const patSection = buildPsiSection(0x00, 1, concat(u16be(1), u16be(0xe000 | pmtPid)));
  emit(0x0000, concat(u8(0x00), patSection));

  /* PMT：PCR=videoPid；stream 列表 H264(0x1B) [+ AAC ADTS(0x0F)] */
  const streams = [[0x1b, videoPid]];
  if (withAudio) streams.push([0x0f, audioPid]);
  const pmtLoop = concat(...streams.map(([type, pid]) => concat(
    u8(type),
    u16be(0xe000 | pid),
    u16be(0xe000), // ES_info_length = 0
  )));
  const pmtBody = concat(u16be(0xe000 | videoPid), u16be(0xe000), pmtLoop); // PCR_PID + program_info_length=0
  const pmtSection = buildPsiSection(0x02, 1, pmtBody);
  emit(pmtPid, concat(u8(0x00), pmtSection)); // 同样带 pointer_field

  /* 访问单元 */
  const ptsList = [];
  for (let i = 0; i < auCount; i++) {
    const pts = i * ptsStep;
    ptsList.push(pts);
    const pcrBase = i * ptsStep; // 与 PTS 同步走 90kHz 时钟
    const au = auPadBytes > 0
      ? concat(makeAnnexbAvcSample(i), new Uint8Array(auPadBytes))
      : makeAnnexbAvcSample(i);
    emit(videoPid, buildPes(0xe0, pts, pts, au), { pcrOnFirst: true, pcrBase });
    if (withAudio && i % 2 === 0) {
      emit(audioPid, buildPes(0xc0, pts, undefined, makeAdtsAacFrame(120)));
    }
  }

  return {
    bytes: concat(...packets),
    meta: {
      packetCount: packets.length,
      packetSize: PACKET_SIZE,
      pids: { pat: 0x0000, pmt: pmtPid, video: videoPid, ...(withAudio ? { audio: audioPid } : {}) },
      streamTypes: withAudio ? { [videoPid]: 0x1b, [audioPid]: 0x0f } : { [videoPid]: 0x1b },
      ptsList,
      pcrStep: ptsStep,
    },
  };
}
