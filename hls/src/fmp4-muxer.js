/**
 * fmp4-muxer.js —— TS 样本 → fMP4（fragmented MP4）转封装器
 *
 * 职责：把 ts/ 模块（TsDemuxer）demux 出的样本
 *   - 视频：H.264/H.265 AnnexB → AVCC/HVCC 长度前缀形态
 *   - 音频：AAC raw block 保持原样
 * 封装为可直接 appendBuffer 的 fMP4：
 *   - init segment：ftyp + moov(mvex)（空样本表 + trex，MSE 分片模式标准形态）
 *   - media fragment：moof(mfhd+traf(tfhd/tfdt/trun)) + mdat
 *
 * 时间轴策略：
 *   TsDemuxer 输出 90kHz ticks（视频）/ 音频轨自身 timescale（sampleRate）。
 *   首个分片取最小 DTS 作为 epoch 基准，后续分片沿用同一基准，保证 MSE 时间线
 *   从近零开始且跨分片连续；discontinuity 时可由调用方要求重置基准。
 */

import { buildAvcCodecString, buildHevcCodecString, aacCodecString } from '../../core/src/codec-string.js';
import { PlayerError, ErrorCode } from '../../core/src/errors.js';
const parseFail = (m) => new PlayerError(ErrorCode.PARSE_ERROR, m);

/* ------------------------------------------------------------------ */
/* ts/src/nalu 惰性加载（评审 §16.3 架构项）                              */
/*                                                                     */
/* 旧实现静态 import nalu：ESM 静态依赖在模块加载期解析，ts/ 缺失时      */
/* 整条 hls 模块图加载失败 —— Transmuxer.tsAvailable() 的"探测后降级"   */
/* 承诺失真（探测代码根本执行不到）。改为模块级惰性动态加载：             */
/*   - 本模块加载不再触碰 ts/，tsAvailable() 语义成立；                  */
/*   - remux 入口 await 落定后 toAvcc 同步可用；                        */
/*   - 模块加载即预热，与首次 remux 并行，通常已就绪。                   */
/* ------------------------------------------------------------------ */

/** @type {typeof import('../../ts/src/nalu.js')|null} */
let _nalu = null;
let _naluPromise = null;

/** 惰性加载 ts/src/nalu（缓存 promise，幂等） */
export function loadNalu() {
  if (!_naluPromise) {
    _naluPromise = import('../../ts/src/nalu.js').then((m) => {
      _nalu = m;
      return m;
    });
  }
  return _naluPromise;
}
// 预热：不 await，失败不影响本模块加载（由 remux/tsAvailable 显式感知）
void loadNalu();

/* ------------------------------------------------------------------ */
/* 字节写入原语                                                         */
/* ------------------------------------------------------------------ */

/** 拼接多个 Uint8Array */
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** u32/u16/i16 大端字节 */
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const u16 = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
};
/** u64（version=1 的 tfdt 使用；安全整数域内用数值拆高低 32 位） */
const u64 = (n) => concat([u32(Math.floor(n / 0x100000000)), u32(n % 0x100000000)]);
/** 有符号 32 位（trun version=1 的 composition time offset 可为负） */
const i32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0);
  return b;
};

/** ISO-BMFF box 头 + payload */
function box(type, ...payloads) {
  const body = concat(payloads);
  return concat([u32(body.length + 8), ascii(type), body]);
}

/** fullBox：box 头 + version/flags + payload */
function fullBox(type, version, flags, ...payloads) {
  const vf = new Uint8Array(4);
  vf[0] = version;
  vf[1] = (flags >> 16) & 0xff;
  vf[2] = (flags >> 8) & 0xff;
  vf[3] = flags & 0xff;
  return box(type, vf, ...payloads);
}

function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
  return out;
}

/* ------------------------------------------------------------------ */
/* 各类 box 构造                                                        */
/* ------------------------------------------------------------------ */

function ftyp() {
  return box('ftyp', ascii('iso5'), u32(0x200), ascii('isom'), ascii('iso5'), ascii('avc1'), ascii('mp41'));
}

function styp() {
  // CMAF 风格分片头（MSE 同样接受；语义更贴切）
  return box('styp', ascii('msdh'), u32(0), ascii('msdh'), ascii('msix'));
}

/** movie header，timescale 固定 1000，duration 由 endOfStream 时另行设置 */
function mvhd(nextTrackId) {
  const v0 = concat([
    u32(0), u32(0),              // creation / modification time
    u32(1000),                   // timescale
    u32(0),                      // duration（未知）
    u32(0x00010000),             // rate 1.0
    u16(0x0100),                 // volume 1.0
    u16(0), u32(0), u32(0),      // reserved
    matrixUnity(),
    predefinedMatrix(),
    u32(nextTrackId),
  ]);
  return fullBox('mvhd', 0, 0, v0);
}

/** unity matrix（a=1,d=1,i=16384 定点） */
function matrixUnity() {
  return concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
}
function predefinedMatrix() {
  return concat([u32(0), u32(0), u32(0), u32(0), u32(0), u32(0)]);
}

function tkhd(trackId, isVideo, width, height) {
  const w = Math.round((width || 0) * 0x10000);
  const h = Math.round((height || 0) * 0x10000);
  const body = concat([
    u32(0), u32(0),            // creation / modification
    u32(trackId),
    u32(0),                    // reserved
    u32(0),                    // duration（moov 层未知，置 0）
    u32(0), u32(0),            // reserved x2
    u16(0), u16(0),            // layer / alternate_group
    u16(isVideo ? 0 : 0x0100), // volume（音轨 1.0）
    u16(0),                    // reserved
    matrixUnity(),
    u32(w), u32(h),            // width/height 16.16 定点
  ]);
  // flags: enabled | in_movie
  return fullBox('tkhd', 0, 3, body);
}

function mdhd(timescale, language = 'und') {
  const packedLang =
    ((language.charCodeAt(0) - 0x60) << 10) |
    ((language.charCodeAt(1) - 0x60) << 5) |
    (language.charCodeAt(2) - 0x60);
  const body = concat([
    u32(0), u32(0),          // creation / modification
    u32(timescale),
    u32(0),                  // duration（未知）
    u16(0x8000 | packedLang), // language 打包 + pad 位
    u16(0),                  // pre_defined
  ]);
  return fullBox('mdhd', 0, 0, body);
}

function hdlr(handlerType, name = 'PlayerCore') {
  return fullBox('hdlr', 0, 0, u32(0), ascii(handlerType), u32(0), u32(0), u32(0), ascii(name), new Uint8Array(1));
}

function vmhd() {
  return fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
}
function smhd() {
  return fullBox('smhd', 0, 0, u16(0), u16(0));
}

function dinf() {
  const url = fullBox('url ', 0, 1); // self-contained
  const dref = fullBox('dref', 0, 0, u32(1), url);
  return box('dinf', dref);
}

/** 视频样本描述项 avc1/hvc1 + 解码配置 */
function videoSampleEntry(codecStr, description, width, height) {
  const fourcc = codecStr.startsWith('hvc') ? 'hvc1' : 'avc1';
  const base = concat([
    new Uint8Array(6),           // reserved
    u16(1),                      // data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined / reserved / pre_defined[3]（VisualSampleEntry 标准头，共 16 字节）
    u16(width || 0),             // width
    u16(height || 0),            // height
    u32(0x00480000), u32(0x00480000), // horiz/vertical dpi 72
    u32(0),                      // reserved
    u16(1),                      // frame_count
    new Uint8Array(32),          // compressorname
    u16(0x0018),                 // depth 24
    u16(0xffff),                 // pre_defined -1
  ]);
  const avcCOrHvcC = box(description.tag, description.bytes);
  return box(fourcc, base, avcCOrHvcC);
}

/** 音频样本描述项 mp4a + esds（内嵌 AudioSpecificConfig） */
function audioSampleEntry(ascBytes, sampleRate, channels) {
  const base = concat([
    new Uint8Array(6),
    u16(1),
    u16(0), u16(0), u32(0),
    u16(channels || 2),
    u16(16),                     // samplesize
    u16(0), u16(0),              // pre_defined/reserved
    u32((sampleRate || 44100) << 16), // samplerate 16.16
  ]);
  const esds = buildEsds(ascBytes);
  return box('mp4a', base, esds);
}

/** ESDS：ES_Descriptor 包 DecoderConfigDescriptor 包 DecoderSpecificInfo(ASC) */
export function buildEsds(ascBytes) {
  const dsi = concat([u8(0x05), varlen(ascBytes.length), ascBytes]);       // DecoderSpecificInfo
  const dcd = concat([
    u8(0x04),
    varlen(dsi.length + 13),
    u8(0x40),                  // objectTypeIndication: MPEG-4 AAC
    u8(0x15),                  // streamType(audio)<<2 | upStream<<1 | reserved  => 0b01010101
    new Uint8Array(3),         // bufferSizeDB
    u32(128000),               // maxBitrate
    u32(128000),               // avgBitrate
    dsi,
  ]);
  const es = concat([
    u8(0x03),
    varlen(dcd.length + 3),
    u16(1),                    // ES_ID
    u8(0),                     // flags
    dcd,
  ]);
  return fullBox('esds', 0, 0, es);
}

function u8(n) {
  const b = new Uint8Array(1);
  b[0] = n & 0xff;
  return b;
}
/** 描述符变长长度编码 */
function varlen(len) {
  if (len < 0x80) return u8(len);
  if (len < 0x4000) return new Uint8Array([0x80 | (len >> 7), len & 0x7f]);
  return new Uint8Array([0x80 | (len >> 14), 0x80 | ((len >> 7) & 0x7f), len & 0x7f]);
}

/** 分片模式样本表：仅 stsd（entry 自带 avcC/esds），与 core/mp4 remuxer 产物对齐。
 *  （fMP4 流样本信息全部由 moof/trun 携带，stbl 中 stts/stsc/stsz/stco 无意义；
 *    旧实现带四张空表，产物在 Chrome 151+ MSE 真机曾被拒，移除后保持一致。）
 */
function emptySampleTables(entry) {
  const stsd = fullBox('stsd', 0, 0, u32(1), entry);
  return box('stbl', stsd);
}

/** 单轨 trak（init segment 用） */
function trak(track) {
  const isVideo = track.type === 'video';
  const entry = isVideo
    ? videoSampleEntry(track.codec, track.description, track.width, track.height)
    : audioSampleEntry(track.description.bytes, track.sampleRate, track.channels);
  return box(
    'trak',
    tkhd(track.id, isVideo, track.width, track.height),
    box(
      'mdia',
      mdhd(track.timescale),
      hdlr(isVideo ? 'vide' : 'soun'),
      box('minf', isVideo ? vmhd() : smhd(), dinf(), emptySampleTables(entry))
    )
  );
}

/** mvex/trex：声明每分片自带样本信息 */
function mvex(tracks) {
  const trexs = tracks.map((t) =>
    fullBox('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0))
  );
  return box('mvex', ...trexs);
}

/** moof/mfhd 序列号 */
function mfhd(seq) {
  return fullBox('mfhd', 0, 0, u32(seq));
}

/**
 * tfhd：track id + default-base-is-moof + 默认样本参数。
 * flags: 0x020000|0x08|0x10|0x20
 */
function tfhd(trackId, defaultDuration, defaultSize, defaultFlags) {
  return fullBox(
    'tfhd',
    0,
    0x020000 | 0x08 | 0x10 | 0x20,
    u32(trackId),
    u32(defaultDuration),
    u32(defaultSize),
    u32(defaultFlags)
  );
}

/** tfdt version=1：64bit baseMediaDecodeTime */
function tfdt(baseTime) {
  return fullBox('tfdt', 1, 0, u64(Math.max(0, Math.round(baseTime))));
}

/**
 * trun：
 * @param {Array<{duration:number,size:number,flags:number,cts:number}>} samples
 * @param {number} dataOffset 相对 moof 起点的 mdat 数据偏移
 * @param {boolean} hasCts 视频带 composition offset（version=1 有符号）
 */
function trun(samples, dataOffset, hasCts) {
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | (hasCts ? 0x000800 : 0);
  const version = hasCts ? 1 : 0;
  const rows = samples.map((s) => {
    const row = [u32(s.duration), u32(s.size), u32(s.flags)];
    if (hasCts) row.push(i32(s.cts)); // version=1 有符号 composition offset
    return row;
  });
  return fullBox('trun', version, flags, u32(samples.length), u32(dataOffset), ...rows.flat());
}

/**
 * 两遍构造 moof：先以占位 data_offset 生成，量得 moof 实际长度后再以
 * 精确值重建（仅数值变化，长度不变，两遍即收敛）。
 */
function makeMoof(seq, trackId, baseTime, rows, hasCts, defaults) {
  const build = (dataOffset) =>
    box(
      'moof',
      mfhd(seq),
      box('traf', tfhd(trackId, defaults.duration, defaults.size, defaults.flags), tfdt(baseTime), trun(rows, dataOffset, hasCts))
    );
  let moof = build(0);
  const dataOffset = moof.length + 8; // mdat 头 8 字节
  moof = build(dataOffset);
  return moof;
}

/* ------------------------------------------------------------------ */
/* Remuxer 主类                                                         */
/* ------------------------------------------------------------------ */

const VIDEO_TIMESCALE = 90000;

/** 样本 flag 常量 */
const FLAG_KEYFRAME = 0x02000000;     // sample_depends_on=2（I 帧），sync sample
const FLAG_INTERFRAME = 0x01010000;   // depends_on=1 且 non-sync

/**
 * TS 分片转封装器。每个 HLS 分片调用一次 remux()；
 * 跨分片保留轨道配置与时间基准，首个分片附带产出 initSegment。
 *
 * 与 transmuxer.js 的适配契约：
 *   remux(tsBytes) -> {
 *     codecs: {video?:string, audio?:string},
 *     video: { initSegment: Uint8Array|null, mediaSegment: Uint8Array },
 *     audio: { initSegment: Uint8Array|null, mediaSegment: Uint8Array } | null,
 *   }
 */
export class TsToFmp4Transmuxer {
  constructor(options = {}) {
    this.options = options;
    this._seq = 1;
    /** @type {Map<string,{codec:string,config:any}|null>} 缓存的轨配置 */
    this._videoCfg = null;
    this._audioCfg = null;
    this._dtsBaseUs = null;      // µs 基准（契约时间基）
    this._lastInitKey = '';      // 配置指纹，变化时重出 init
    this.destroyed = false;
  }

  /**
   * 转封装一个 TS 分片。
   * @param {Uint8Array} tsBytes 完整分片字节
   * @param {{discontinuity?:boolean}} [opts]
   */
  async remux(tsBytes, opts = {}) {
    if (this.destroyed) throw new PlayerError(ErrorCode.STATE_ERROR, 'remuxer 已销毁');
    // 复用 ts/ 模块（契约适配壳版）：构造时以 ChunkSource 形态接管 write/end，
    // end() 触发引擎 flush → readSample 干净排空到 null。
    // nalu 与 TsDemuxer 均为惰性动态导入（评审 §16.3）：本模块加载期不依赖 ts/，
    // 导入失败包成 NOT_SUPPORTED（契约：禁止裸 Error 冒泡），由上层降级策略感知。
    let TsDemuxer;
    try {
      ({ TsDemuxer } = await import('../../ts/src/index.js'));
      await loadNalu();
    } catch (err) {
      throw new PlayerError(
        ErrorCode.NOT_SUPPORTED,
        `ts/ demux 模块不可用，无法转封装 TS 分片: ${err.message}`
      );
    }
    const sink = {
      write(chunk) { void chunk; },
      end(err) { void err; },
    };
    const demuxer = new TsDemuxer(sink);
    const opened = demuxer.open();
    sink.write(tsBytes);
    sink.end();
    await opened;

    // ---- 按轨拉取样本（契约 Sample 形状：timestamp/duration 为 µs）----
    /** @type {Record<string, any[]>} */
    const collected = { video: [], audio: [] };
    /** @type {Record<string, any>} */
    const trackMeta = {};
    for (const t of demuxer.tracks || []) {
      if (t.type !== 'video' && t.type !== 'audio') continue;
      trackMeta[t.type] = t;
      for (;;) {
        const smp = await demuxer.readSample(t.id);
        if (!smp) break;
        collected[t.type].push(smp);
      }
    }

    const vTrack = trackMeta.video;
    const aTrack = trackMeta.audio;

    // ---- 轨道配置（codec 串/解码描述由 ts/ 按契约产出）----
    let videoCfgChanged = false;
    let audioCfgChanged = false;
    if (vTrack && vTrack.description) {
      const isHevc = /^hv?c1|^hev1/i.test(vTrack.codec || '');
      const cfg = {
        fingerprint: Array.from(vTrack.description.slice(0, 12)).join(',') + '#' + vTrack.description.length,
        codec: vTrack.codec || safeCodec(() => buildAvcCodecString(vTrack.description), 'avc1'),
        description: { tag: isHevc ? 'hvcC' : 'avcC', bytes: vTrack.description },
        width: vTrack.width || 0,
        height: vTrack.height || 0,
      };
      videoCfgChanged = !this._videoCfg || this._videoCfg.fingerprint !== cfg.fingerprint || opts.discontinuity;
      this._videoCfg = cfg;
    }
    if (aTrack && aTrack.description) {
      const asc = aTrack.description;
      const key = Array.from(asc.slice(0, 8)).join(',');
      audioCfgChanged = !this._audioCfg || this._audioCfg.fingerprint !== key || opts.discontinuity;
      this._audioCfg = {
        fingerprint: key,
        codec: aTrack.codec || aacCodecString(parseAot(asc)),
        asc,
        sampleRate: aTrack.sampleRate || 44100,
        channels: aTrack.channels || aTrack.channelCount || 2,
        timescale: aTrack.timescale || aTrack.sampleRate || 44100,
      };
    }

    if (!collected.video.length && !collected.audio.length) {
      return { codecs: this.currentCodecs(), video: null, audio: null };
    }

    // ---- 时间基准（µs 域；跨分片保持同一 epoch）----
    const firstDtsUs = [];
    for (const list of [collected.video, collected.audio]) {
      if (list.length) firstDtsUs.push(list[0].dts ?? list[0].timestamp ?? 0);
    }
    if (opts.discontinuity || this._dtsBase == null) {
      this._dtsBaseUs = firstDtsUs.length ? Math.min(...firstDtsUs) : 0;
    }

    // ---- init 片段按需重建 ----
    const initKey = [
      this._videoCfg ? `${this._videoCfg.codec}:${this._videoCfg.fingerprint}` : '-',
      this._audioCfg ? `${this._audioCfg.codec}:${this._audioCfg.fingerprint}` : '-',
    ].join('|');
    const needInit = initKey !== this._lastInitKey;
    if (needInit) this._lastInitKey = initKey;

    const result = { codecs: this.currentCodecs(), video: null, audio: null };

    if (collected.video.length && this._videoCfg) {
      const TS = VIDEO_TIMESCALE; // 90000
      const usToTicks = (us) => Math.round(((us - this._dtsBaseUs) * TS) / 1e6);
      const samples = collected.video.map((s, i) => {
        // 注意：size 必须取 avcc 转换后的真实长度，否则 trun 声明的 sample size
        // 与 mdat 实际字节数不一致，Chrome 会拒收整段 media segment。
        const avcc = toAvcc(s.data, 'h264');
        return {
          dts: usToTicks(s.dts ?? s.timestamp),
          pts: usToTicks(s.pts ?? s.timestamp),
          duration: Math.round(((s.duration || estimateVideoDuration(collected.video, i)) * TS) / 1e6),
          size: avcc.byteLength,
          keyframe: !!s.keyframe,
          data: avcc,
        };
      });
      result.video = {
        initSegment: needInit || videoCfgChanged
          ? buildInit([{ ...videoTrakFrom(this._videoCfg), id: 1 }])
          : null,
        mediaSegment: buildFragment({ trackId: 1, timescale: TS, samples, seq: this._seq }),
      };
    }

    if (collected.audio.length && this._audioCfg) {
      const ts = this._audioCfg.timescale;
      const scale = ts / 1e6; // µs → 音轨 ticks
      const audioSamples = collected.audio.map((s) => ({
        dts: Math.round(((s.dts ?? s.timestamp) - this._dtsBaseUs) * scale),
        pts: Math.round(((s.pts ?? s.timestamp) - this._dtsBaseUs) * scale),
        duration: Math.round((s.duration || (1024 / this._audioCfg.sampleRate) * 1e6) * scale),
        size: s.size ?? s.data?.byteLength ?? 0,
        keyframe: true,
        data: s.data,
      }));
      result.audio = {
        initSegment: needInit || audioCfgChanged
          ? buildInit([
              {
                id: 2,
                type: 'audio',
                codec: this._audioCfg.codec,
                description: { tag: 'esds', bytes: this._audioCfg.asc },
                sampleRate: this._audioCfg.sampleRate,
                channels: this._audioCfg.channels,
                timescale: ts,
              },
            ])
          : null,
        mediaSegment: buildAudioFragment(2, ts, audioSamples, this._seq),
      };
    }

    this._seq += 1;
    demuxer.destroy?.();
    return result;
  }

  currentCodecs() {
    return {
      video: this._videoCfg ? this._videoCfg.codec : '',
      audio: this._audioCfg ? this._audioCfg.codec : '',
    };
  }

  destroy() {
    this.destroyed = true;
    this._videoCfg = null;
    this._audioCfg = null;
  }
}

/* ---------------- 内部工具 ---------------- */

function videoTrakFrom(cfg) {
  return {
    type: 'video',
    codec: cfg.codec,
    description: cfg.description, // {tag:'avcC'|'hvcC', bytes}
    width: cfg.width,
    height: cfg.height,
    timescale: VIDEO_TIMESCALE,
  };
}

function safeCodec(fn) {
  try {
    return fn();
  } catch (err) {
    // 契约 §3：禁止编造 profile。无法推导时返回空串，由上层跳过该轨并告警。
    logWarn(`codec 串推导失败，跳过该轨初始化: ${err.message}`);
    return '';
  }
}
function logWarn(msg) {
  // 轻量告警：避免引入 core logger 造成循环依赖
  if (typeof console !== 'undefined') console.warn(`[hls:fmp4] ${msg}`);
}

/** ASC 前 5 位 = AOT */
function parseAot(asc) {
  if (!asc || !asc.length) return 2;
  return (asc[0] >> 3) & 0x1f;
}

/** AnnexB 整帧 → AVCC（4 字节长度前缀）；失败即抛错，杜绝坏流透传 */
function toAvcc(frameData, codec) {
  try {
    if (!_nalu) throw new Error('ts/src/nalu 模块未就绪（应由 remux 入口预加载）');
    const units = _nalu.classify(_nalu.splitAnnexB(frameData), codec === 'hevc' ? 'hevc' : 'h264');
    return _nalu.annexbToAvcc(units);
  } catch (err) {
    throw parseFail(`视频样本 AnnexB→AVCC 转换失败: ${err.message}`);
  }
}

/** 视频时长兜底：相邻 DTS 差值 */
function estimateVideoDuration(list, idx) {
  if (idx >= 0 && idx < list.length - 1) {
    const cur = list[idx];
    const next = list[idx + 1];
    const d = (next.dts ?? next.pts) - (cur.dts ?? cur.pts);
    if (Number.isFinite(d) && d > 0) return d;
  }
  return Math.round(VIDEO_TIMESCALE / 30); // 30fps 兜底
}

/** 组装 init segment（ftyp+moov） */
function buildInit(tracks) {
  const nextId = Math.max(...tracks.map((t) => t.id)) + 1;
  const moovBody = concat([mvhd(nextId), ...tracks.map(trak), mvex(tracks)]);
  return concat([ftyp(), box('moov', moovBody)]);
}

/** 视频分片：styp + moof + mdat（按解码序输出，cts 表达 pts-dts） */
function buildFragment({ trackId, timescale, samples, seq = 1 }) {
  void timescale;
  const norm = samples.map((s) => ({
    ...s,
    size: s.size ?? s.data?.byteLength ?? 0,
  }));
  norm.sort((a, b) => a.dts - b.dts);
  const dataBytes = concat(norm.map((s) => s.data));
  const first = norm[0];
  const moof = makeMoof(
    seq,
    trackId,
    first.dts,
    norm.map((s) => ({
      duration: Math.max(0, Math.round(s.duration || 0)),
      size: s.size,
      flags: s.keyframe ? FLAG_KEYFRAME : FLAG_INTERFRAME,
      cts: Math.round((s.pts ?? s.dts) - s.dts),
    })),
    true,
    {
      duration: Math.max(0, Math.round(first.duration || 0)),
      size: first.size,
      flags: first.keyframe ? FLAG_KEYFRAME : FLAG_INTERFRAME,
    }
  );
  const mdat = concat([u32(dataBytes.length + 8), ascii('mdat'), dataBytes]);
  return concat([styp(), moof, mdat]);
}

/** 音频分片（无 composition offset） */
function buildAudioFragment(trackId, timescale, samples, seq = 1) {
  void timescale;
  const norm = samples.map((s) => ({ ...s, size: s.size ?? s.data?.byteLength ?? 0 }));
  norm.sort((a, b) => a.dts - b.dts);
  const dataBytes = concat(norm.map((s) => s.data));
  const first = norm[0];
  const avgDur = Math.max(1, Math.round(norm.reduce((n, s) => n + (s.duration || 0), 0) / norm.length));
  const avgSize = Math.max(1, Math.round(dataBytes.length / norm.length));
  const moof = makeMoof(
    seq,
    trackId,
    first.dts,
    norm.map((s) => ({ duration: Math.round(s.duration || 0), size: s.size, flags: FLAG_KEYFRAME, cts: 0 })),
    false,
    { duration: avgDur, size: avgSize, flags: FLAG_KEYFRAME }
  );
  const mdat = concat([u32(dataBytes.length + 8), ascii('mdat'), dataBytes]);
  return concat([styp(), moof, mdat]);
}

/**
 * 供单测直接验证 box 结构的内部构造器（非公共 API，语义可能演进）。
 * ts/ 模块未产出真实样本时，测试可用合成样本走纯结构路径。
 */
export const _internalForTest = { buildInit, buildFragment, buildAudioFragment, buildEsds, concat };
