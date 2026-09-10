/**
 * chunk-parser.js —— chunked CMAF track 解析
 *
 * CMAF（Common Media Application Format, ISO/IEC 23000-19）把一条轨组织为：
 *   [init segment (ftyp+moov)] + [chunk (styp+moof+mdat)] × N
 * 本解析器把这样的字节流切成独立 chunk，并从 moof 提取每样本的
 * 时长/大小/标志/composition offset 与解码时间基。
 *
 * 输入形态：DataSource（契约 §2.1，点播型随机读）或一次性内存字节。
 */

import {
  iterateBoxes,
  findBox,
  parseMoof,
  parseSidx,
  isKeyframeFlag,
  findVideoDecoderConfig,
  findAudioSpecificConfig,
} from './isobmff.js';
import { notSupported } from '../../core/src/errors.js';

/**
 * 嗅探是否为 CMAF 形态（ftyp 或 styp 开头）。
 * @param {Uint8Array} bytes 头部字节（建议 >=64B）
 * @returns {{confidence:number, container:string}|null}
 */
export function probe(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (type === 'styp') return { confidence: 0.95, container: 'cmaf' };
  if (type === 'ftyp') return { confidence: 0.6, container: 'cmaf' }; // 可能是普通 mp4
  return null;
}

/**
 * 把一段（可能包含多个 fragment 的）fMP4 字节切分为 CMAF chunk 列表。
 *
 * 边界规则：
 *  - ftyp 开头且不含 moof 的块 = init segment（经 parseInitSegment 单独解析）；
 *  - styp 开头的块 = 一个 CMAF chunk；
 *  - 无 styp 的裸 fragment 流按 moof 归组（容错）。
 *
 * @param {Uint8Array} buf 完整或增量数据
 * @returns {{chunks:Array<CmafChunk>, initRange:{startOffset:number,byteLength:number}|null}}
 *
 * @typedef {Object} CmafChunk
 * @property {number} index            chunk 序号（0 起）
 * @property {boolean} styp            是否以 styp 起始
 * @property {number} startOffset      在 buf 内的起始偏移
 * @property {number} byteLength       含 styp/moof/mdat 全部字节
 * @property {Array<{trackId:number, baseTime:number,
 *                    samples:Array<object>}>} tracks
 */
export function splitChunks(buf) {
  /** @type {CmafChunk[]} */
  const chunks = [];
  /** @type {{startOffset:number,byteLength:number}|null} */
  let initRange = null;
  /** @type {ReturnType<typeof parseSidx>|null} */
  let segmentIndex = null;

  let current = null;
  let sawMoofInCurrent = false;

  /**
   * 收尾当前块：含 moof 的进 chunks；ftyp 起始且无 moof 的判为 init。
   */
  const finalize = () => {
    if (!current) return;
    if (!sawMoofInCurrent && !current.styp) {
      if (current.byteLength > 0 && !initRange) {
        initRange = { startOffset: current.startOffset, byteLength: current.byteLength };
      }
    } else if (current.byteLength > 0) {
      current.index = chunks.length;
      chunks.push(current);
    }
    current = null;
    sawMoofInCurrent = false;
  };

  for (const b of iterateBoxes(buf)) {
    if (b.type === 'styp' || b.type === 'ftyp') {
      finalize();
      current = {
        index: -1,
        styp: b.type === 'styp',
        startOffset: b.contentStart - 8,
        byteLength: 0,
        tracks: [],
      };
    } else if (!current) {
      // 无 styp 的裸流：以首个 box 起始
      current = {
        index: -1,
        styp: false,
        startOffset: b.contentStart - 8,
        byteLength: 0,
        tracks: [],
      };
    }
    current.byteLength += b.size;

    if (b.type === 'sidx' && !segmentIndex) {
      // 分段寻址索引（契约 §2.5：分片级 sidx）
      segmentIndex = parseSidx(buf, b.contentStart, b.contentEnd);
    }
    if (b.type === 'moof') {
      sawMoofInCurrent = true;
      for (const traf of parseMoof(buf, b.contentStart, b.contentEnd)) {
        const samples = materializeSamples(buf, b, traf);
        current.tracks.push({
          trackId: traf.trackId,
          baseTime: traf.baseTime,
          samples,
        });
      }
    }
  }
  finalize();
  return { chunks, initRange, segmentIndex };
}

/** 由 trun 行 + mdat 数据区计算每个样本的具体位置与属性 */
function materializeSamples(buf, moofBox, traf) {
  const { trun, baseTime, defaults, trackId } = traf;
  void trackId;
  // 找紧随 moof 的 mdat
  let mdatDataStart = -1;
  for (const b of iterateBoxes(buf, moofBox.contentEnd)) {
    if (b.type === 'mdat') {
      mdatDataStart = b.contentStart;
      break;
    }
  }
  if (mdatDataStart < 0) {
    throw notSupported('moof 之后未找到 mdat，无法定位样本数据');
  }

  const rows = trun.rows.map((r) => ({
    duration: r.duration || defaults.defaultSampleDuration || 0,
    size: r.size || defaults.defaultSampleSize || 0,
    flags: r.flags || defaults.defaultSampleFlags || 0,
    cts: r.cts || 0,
  }));

  const out = [];
  let cursor = mdatDataStart + trun.dataOffset;
  let dtsOffset = baseTime; // 所属 timescale 的 ticks
  for (const row of rows) {
    out.push({
      durationUs: 0, // 由上层按轨 timescale 换算（契约：公共边界 µs）
      durationTicks: row.duration,
      size: row.size,
      keyframe: isKeyframeFlag(row.flags),
      cts: row.cts,
      dtsOffset,
      dataStart: cursor,
    });
    cursor += row.size;
    dtsOffset += row.duration;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* init segment 信息                                                   */
/* ------------------------------------------------------------------ */

/**
 * 解析 init segment：轨类型、timescale、解码配置。
 * @param {Uint8Array} initBytes ftyp+moov 字节
 */
export function parseInitSegment(initBytes) {
  const videoCfg = findVideoDecoderConfig(initBytes);
  const asc = findAudioSpecificConfig(initBytes);

  /** 按 trak 树关联提取 timescale（复用 hdlr 判定轨类型，非全文件字节扫描） */
  const timescales = findTimescales(initBytes);

  return {
    video: videoCfg
      ? {
          entryType: videoCfg.entryType,
          description: videoCfg.description,
          timescale: timescales.video ?? 90000,
        }
      : null,
    audio: asc ? { asc, codecAot: (asc[0] >> 3) & 0x1f, timescale: timescales.audio ?? 48000 } : null,
  };
}

/**
 * 从 init segment 的 moov 树按 trak 结构关联提取各轨 timescale。
 *
 * 修正（audit-79 C-2）：旧实现全文件扫描 'mdhd' 字节串、并以出现顺序
 * 假定"第 1 个 mdhd=视频、第 2 个=音频"，在音视频顺序非常规、或解码配置
 * 字节里恰含 'mdhd' 序列时会取错。这里改为遍历
 *   moov → trak → mdia，用 hdlr.handlerType 判定轨类型
 * （'vide'→视频、'soun'→音频），再读同 trak 的 mdhd 取 timescale。
 * 不依赖出现顺序，也不扫描解码配置字节（avcC/hvcC/esds 等二进制内
 * 理论上也可出现这 4 字节，全文件扫描会误命中）。
 *
 * @param {Uint8Array} initBytes ftyp+moov 字节
 * @returns {{video?:number, audio?:number}}
 */
export function findTimescales(initBytes) {
  const result = {};
  // 顶层定位 moov（非全文件扫描）
  const moov = findBox(initBytes, 0, initBytes.length, 'moov');
  if (!moov) return result;
  for (const trak of iterateBoxes(initBytes, moov.contentStart, moov.contentEnd)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(initBytes, trak.contentStart, trak.contentEnd, 'mdia');
    if (!mdia) continue; // 缺 mdia：兜底跳过该轨
    const mdhd = findBox(initBytes, mdia.contentStart, mdia.contentEnd, 'mdhd');
    if (!mdhd) continue; // 缺 mdhd：兜底跳过该轨
    const handlerType = readHandlerType(initBytes, mdia);
    const ts = readMdhdTimescale(initBytes, mdhd);
    if (ts == null) continue; // timescale 非法：兜底跳过
    if (handlerType === 'soun') {
      if (result.audio == null) result.audio = ts;
    } else if (handlerType === 'vide') {
      if (result.video == null) result.video = ts;
    }
    // 其他 handlerType / 缺 hdlr：兜底跳过该轨
  }
  return result;
}

/** 读 hdlr 的 handlerType（4 字符）；缺 hdlr/截断返回 null */
function readHandlerType(buf, mdia) {
  const hdlr = findBox(buf, mdia.contentStart, mdia.contentEnd, 'hdlr');
  if (!hdlr) return null;
  // hdlr fullBox：[ver/flags(4)][predefined(4)][handlerType(4)]…
  if (hdlr.contentStart + 8 + 4 > buf.length) return null;
  return String.fromCharCode(
    buf[hdlr.contentStart + 8],
    buf[hdlr.contentStart + 9],
    buf[hdlr.contentStart + 10],
    buf[hdlr.contentStart + 11]
  );
}

/** 读 mdhd 的 timescale；版本不识别/越界/非正返回 null */
function readMdhdTimescale(buf, mdhd) {
  const version = buf[mdhd.contentStart];
  // v0: [ver/flags(4)][ctime(4)][mtime(4)][timescale(4)] → +12；v1 时间戳 8 字节 → +20
  const tsPos = mdhd.contentStart + 4 + (version === 1 ? 16 : 8);
  if (tsPos + 4 > buf.length) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ts = dv.getUint32(tsPos);
  return ts > 0 ? ts : null;
}
