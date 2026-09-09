/**
 * psi.js —— MPEG-TS 节目专用信息（PSI）解析
 *
 * PAT（Program Association Table，PID=0x0000）列出节目号 → PMT PID 的映射；
 * PMT（Program Map Table）列出每个节目的 elementary stream：
 *   stream_type + ES PID + （可选的描述符，本项目忽略）。
 *
 * PSI 以 Section 为单位组织，一个 Section 可能跨多个 TS 包
 * （通过 pointer_field 与 table extension 续包），因此这里提供按 PID
 * 重组 Section 的 PsiAssembler。
 */

/** MPEG-2 CRC32：多项式 0x04C11DB7，初值/终值全 1，MSB 先行 */
export function mpegCrc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/**
 * 从 payload unit 中提取完整 section 字节。
 * 返回 { complete: Uint8Array|null } —— 长度不足时返回 null。
 * 调用方负责把同一 PID 的 payload unit 按序喂进来。
 * @param {Uint8Array} payloadUnit 一个 PUSI 开始的整段 TS 有效载荷
 */
export function readSectionFromPayload(payloadUnit) {
  let offset = 0;
  if (payloadUnit.length === 0) return null;
  const pointerField = payloadUnit[0];
  offset = 1 + pointerField;
  if (offset >= payloadUnit.length) return null;
  if (offset + 3 > payloadUnit.length) return null;
  // section 头：table_id(8) | section_syntax(1) '0' reserved(2) length(12)
  const sectionLength = ((payloadUnit[offset + 1] & 0x0f) << 8) | payloadUnit[offset + 2];
  const total = 3 + sectionLength; // 含头与 CRC
  if (total > 4096 + 3) return null; // PSI 上限 1024(PAT)/4096?保守拒绝
  if (offset + total > payloadUnit.length) return null; // 跨包由 assembler 处理
  return payloadUnit.subarray(offset, offset + total);
}

/** 解析 section 公共头 */
function parseSectionHeader(section) {
  return {
    tableId: section[0],
    sectionLength: ((section[1] & 0x0f) << 8) | section[2],
    // section_syntax_indicator 在 [1] 最高位；version 取 current_next=1 的版本
    versionNumber: (section[5] >> 1) & 0x1f,
    currentNext: section[5] & 0x01,
    sectionNumber: section[6],
    lastSectionNumber: section[7],
  };
}

/**
 * 解析 PAT。section 为完整字节（含 CRC）。
 * @returns {{ programs: Array<{ number:number, pid:number }>, versionNumber:number, crcOk:boolean }}
 */
export function parsePAT(section) {
  const header = parseSectionHeader(section);
  const bodyEnd = section.length - 4; // 去掉尾部 CRC32
  const programs = [];
  for (let pos = 8; pos + 4 <= bodyEnd; pos += 4) {
    const number = (section[pos] << 8) | section[pos + 1];
    const pid = ((section[pos + 2] & 0x1f) << 8) | section[pos + 3];
    if (number !== 0) programs.push({ number, pid }); // number 0 = NIT，跳过
  }
  const expected = ((section[bodyEnd] << 24) | (section[bodyEnd + 1] << 16)
    | (section[bodyEnd + 2] << 8) | section[bodyEnd + 3]) >>> 0;
  const actual = mpegCrc32(section, 0, bodyEnd);
  return { programs, versionNumber: header.versionNumber, crcOk: expected === actual };
}

/** PMT 中常见的 stream_type 映射（节选自 ISO 13818-1 / ITU-T H.222） */
export const STREAM_TYPE_MAP = {
  0x01: 'mpeg1-video',
  0x02: 'mpeg2-video',
  0x03: 'mp3',        // MPEG-1 audio
  0x04: 'mp3',        // MPEG-2 audio
  0x0f: 'aac-adts',   // AAC in ADTS
  0x10: 'mpeg4-video',
  0x11: 'aac-latm',   // AAC in LATM/LOAS
  0x1b: 'h264',       // AVC
  0x24: 'hevc',       // HEVC (H.265)
  0x42: 'cavs-video',
};

/**
 * 解析 PMT。
 * @returns {{ pcrPid:number, streams:Array<{pid:number, streamType:number, codec:string|undefined}>, versionNumber:number, crcOk:boolean }}
 */
export function parsePMT(section) {
  const header = parseSectionHeader(section);
  const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  let pos = 12 + programInfoLength;
  const bodyEnd = section.length - 4;
  const streams = [];
  while (pos + 5 <= bodyEnd) {
    const streamType = section[pos];
    const pid = ((section[pos + 1] & 0x1f) << 8) | section[pos + 2];
    const esInfoLength = ((section[pos + 3] & 0x0f) << 8) | section[pos + 4];
    streams.push({
      pid,
      streamType,
      codec: STREAM_TYPE_MAP[streamType], // 不认识的类型返回 undefined
    });
    pos += 5 + esInfoLength;
  }
  const expected = ((section[bodyEnd] << 24) | (section[bodyEnd + 1] << 16)
    | (section[bodyEnd + 2] << 8) | section[bodyEnd + 3]) >>> 0;
  const actual = mpegCrc32(section, 0, bodyEnd);
  return { pcrPid, streams, versionNumber: header.versionNumber, crcOk: expected === actual };
}

/**
 * 按 PID 重组跨包 Section。
 * 用法：assembler.feed(pid, payloadBytes, pusi)；当某个 PID 上凑齐一个完整
 * section 时回调 onSection(pid, sectionBytes)。
 */
export class PsiAssembler {
  /** @param {(pid:number, section:Uint8Array)=>void} onSection */
  constructor(onSection) {
    this.onSection = onSection;
    /** @type {Map<number, {buf:Uint8Array[], got:number, need:number}>} */
    this.pending = new Map();
  }

  /**
   * @param {number} pid
   * @param {Uint8Array} payload 该包去头后的有效载荷（不含 AF）
   * @param {boolean} pusi 是否为负载起始包
   */
  feed(pid, payload, pusi) {
    if (payload.length === 0) return;
    if (pusi) {
      const pointerField = payload[0];
      // 同包内 pointer_field 之后可能还有上一节的残余——直接丢弃旧缓存
      this._startNew(pid);
      const state = this.pending.get(pid);
      this._append(state, payload.subarray(1 + pointerField));
      this._drain(pid, state, true);
    } else {
      const state = this.pending.get(pid);
      if (!state) return; // 未从 PUSI 开始，无法重组
      this._append(state, payload);
      this._drain(pid, state, false);
    }
  }

  _startNew(pid) {
    this.pending.set(pid, { buf: [], got: 0, need: -1 });
  }

  _append(state, chunk) {
    if (chunk.length === 0 || chunk.length > 4096 * 2) return;
    state.buf.push(chunk);
    state.got += chunk.length;
    if (state.need < 0 && state.got >= 3) {
      // 已能读到 section_length
      const flat = concatBuffers(state.buf);
      state.need = 3 + (((flat[1] & 0x0f) << 8) | flat[2]);
      state.buf = [flat];
    }
  }

  _drain(pid, state) {
    if (state.need >= 0 && state.got >= state.need) {
      const flat = concatBuffers(state.buf);
      this.onSection(pid, flat.subarray(0, state.need));
      // 一段有效载荷里可能紧随另一个 section；简化处理：剩余部分丢弃，
      // 等下一个 PUSI 重来（主流复用器每包只放一节的头部）。
      this._startNew(pid);
    }
  }

  reset() {
    this.pending.clear();
  }
}

function concatBuffers(list) {
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
