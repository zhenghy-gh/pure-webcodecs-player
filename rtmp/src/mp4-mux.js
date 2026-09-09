/**
 * Fmp4Remuxer —— FLV(H264/AAC) → 分段 fMP4（init segment + moof/mdat 片段）。
 *
 * 用途：喂 MSE SourceBuffer（appendBuffer）。直播低延迟形态：
 *   - initSegment() 在轨道配置就绪后生成一次（ftyp+moov，含 mvex/trex）；
 *   - addSample() 缓存样本；buildFragment() 将已缓存样本打成 moof+mdat 并清空队列。
 *
 * 布局约定（与 media-dev 的 mp4 模块结论一致）：
 *   - tfhd 固定 default-base-is-moof，trun 的 data-offset 以 moof 起点为基准；
 *   - 视频轨 timescale=1000（FLV 毫秒域直映），音频轨 timescale=采样率；
 *   - 假定无 B 帧（FLV 直播常态）：pts≠dts 时告警一次并按 DTS 直通。
 */

import { errors } from './errors.js';

const VIDEO_TIMESCALE = 1000;

// ---------- 位流原语 ----------

function box(type, ...payloads) {
  let len = 8;
  for (const p of payloads) len += p.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const p of payloads) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function fullbox(type, version, flags, ...payloads) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >>> 16) & 0xff;
  head[2] = (flags >>> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, head, ...payloads);
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function str(s) {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

/** 以 0 结尾的 ASCII 名字（hdlr 用） */
function nullTerm(s) {
  return Uint8Array.from([...str(s), 0]);
}

const Z4 = () => u32(0);

function concatAll(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** MP4 描述符：tag + 单字节长度（本场景负载恒小于 128B） */
function makeDescriptor(tag, payload) {
  const head = Uint8Array.from([tag, payload.length]);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** AAC AudioSpecificConfig → esds box */
export function esdsFromAsc(asc, trackId) {
  const decoderConfig = concatAll([
    Uint8Array.from([0x40, (0x05 << 2) | 0x01]), // objectTypeIndication=AAC(0x40)，streamType=audio(5)<<2|reserved=1
    Uint8Array.from([0, 0, 0]), // bufferSizeDB(24bit)=0
    u32(0),
    u32(0), // maxBitrate / avgBitrate
    makeDescriptor(0x05, asc), // DecSpecificInfoInfo = ASC
    makeDescriptor(0x06, Uint8Array.from([0x02])), // SLConfigDescriptor
  ]);
  const esDescriptor = concatAll([u16(trackId), Uint8Array.from([0x00]) /*flags*/, decoderConfig]);
  return fullbox('esds', 0, 0, makeDescriptor(0x03, esDescriptor));
}

// ---------- remuxer ----------

export class Fmp4Remuxer {
  constructor() {
    /** @type {{description:Uint8Array, width?:number, height?:number}|null} */
    this.videoTrack = null;
    /** @type {{description:Uint8Array, sampleRate:number, channels?:number}|null} */
    this.audioTrack = null;
    this._videoQueue = [];
    this._audioQueue = [];
    this.sequence = 0;
    this._warnedPtsMismatch = false;
    this.totalSamples = 0;
  }

  setVideoTrack(t) {
    if (!t?.description) throw errors.state('视频轨缺少 description(avcC)');
    this.videoTrack = t;
  }

  setAudioTrack(t) {
    if (!t?.description || !t.sampleRate) throw errors.state('音频轨缺少 description(ASC)/采样率');
    this.audioTrack = t;
  }

  get ready() {
    return !!(this.videoTrack || this.audioTrack);
  }

  get hasVideo() {
    return !!this.videoTrack;
  }

  get hasAudio() {
    return !!this.audioTrack;
  }

  /** 初始化段：ftyp + moov。轨道配置齐备后调用一次。 */
  initSegment() {
    if (!this.ready) throw errors.state('尚未设置任何轨道');
    const ftyp = box('ftyp', str('iso6'), u32(0), str('iso6'), str('mp41'));
    const tracks = [];
    const trexs = [];
    // 轨道 ID 固定：视频=1、音频=2（与 fragment 一致）
    if (this.videoTrack) {
      tracks.push(this.#videoTrakBody(1));
      trexs.push(fullbox('trex', 0, 0, u32(1), u32(1), Z4(), Z4(), Z4()));
    }
    if (this.audioTrack) {
      const id = this.videoTrack ? 2 : 1;
      tracks.push(this.#audioTrakBody(id));
      trexs.push(fullbox('trex', 0, 0, u32(id), u32(1), Z4(), Z4(), Z4()));
    }
    // 契约布局：mvex 位于 moov 层（ISO/IEC 14496-12），不在 trak 内
    const moov = box('moov', this.#mvhd(tracks.length + 1), ...tracks, box('mvex', ...trexs));
    return concatAll([ftyp, moov]);
  }

  /** 追加一个样本（flv-demuxer 的 sample 事件对象） */
  addSample(sample) {
    if (!this.ready) throw errors.state('请先完成轨道配置');
    if (Math.abs((sample.ptsUs ?? 0) - (sample.dtsUs ?? 0)) > 1000 && !this._warnedPtsMismatch) {
      this._warnedPtsMismatch = true;
      console.warn('[fmp4] 存在 pts≠dts 样本（疑似 B 帧），当前按 DTS 直通处理');
    }
    if (sample.kind === 'video' && this.videoTrack) this._videoQueue.push(sample);
    else if (sample.kind === 'audio' && this.audioTrack) this._audioQueue.push(sample);
  }

  get pendingSamples() {
    return this._videoQueue.length + this._audioQueue.length;
  }

  /**
   * 将当前缓存样本打包为若干 moof+mdat 片段拼接；无样本返回 null。
   * @returns {Uint8Array|null}
   */
  buildFragment() {
    const parts = [];
    if (this.videoTrack && this._videoQueue.length) {
      parts.push(this.#fragment(1, this._videoQueue.splice(0), VIDEO_TIMESCALE, true));
    }
    if (this.audioTrack && this._audioQueue.length) {
      parts.push(this.#fragment(this.videoTrack ? 2 : 1, this._audioQueue.splice(0), this.audioTrack.sampleRate, false));
    }
    if (!parts.length) return null;
    this.sequence++;
    return concatAll(parts);
  }

  /**
   * 单轨片段：moof(mfhd+traf{tfhd,tfdt,trun}) + mdat
   * 尺寸精确推导（default-base-is-moof）：
   *   moof 头 8 | mfhd 16 | traf 头 8 | tfhd 16 | tfdt 16 | trun 16+12n
   *   dataOffset = moof 总长（mdat 载荷紧跟其 8 字节头之后）
   */
  #fragment(trackId, samples, timescale, isVideo) {
    const sizes = samples.map((s) => s.data.length);
    const totalBytes = sizes.reduce((a, b) => a + b, 0);
    const entryCount = samples.length;
    const trunSize = 8 + 4 + 4 + entryCount * 12;
    const moofSize = 8 + 16 + (8 + 16 + 16 + trunSize);

    const mfhd = fullbox('mfhd', 0, 0, u32(this.sequence));

    const baseTicks = toTicks(samples[0].dtsUs ?? samples[0].ptsUs, timescale);
    const tfhd = fullbox('tfhd', 0, 0x020000 /*default-base-is-moof*/, u32(trackId));
    const tfdt = fullbox('tfdt', 0, 0, u32(Math.max(0, baseTicks))); // v0：baseMediaDecodeTime 为 32 位

    // trun v0：sampleCount, dataOffset, [duration,size,flags]*
    const TRUN_FLAGS = 0x000001 /*data-offset*/ | 0x000100 /*duration*/ | 0x000200 /*size*/ | 0x000400 /*flags*/;
    const entryBytes = [];
    for (let i = 0; i < samples.length; i++) {
      const cur = samples[i];
      const next = samples[i + 1];
      let durTicks;
      if (next) durTicks = Math.max(1, toTicks(next.dtsUs ?? next.ptsUs, timescale) - toTicks(cur.dtsUs ?? cur.ptsUs, timescale));
      else durTicks = Math.max(1, Math.round(((cur.durationUs || (isVideo ? 66_000 : 21_300)) * timescale) / 1e6));
      const flags = cur.keyframe ? 0x02000000 : 0x01010000;
      entryBytes.push(u32(durTicks), u32(sizes[i]), u32(flags));
    }
    // 一次性构造完整 box，确保 size 字段与实际长度一致（concat 复用头部会造成 size 滞留旧值）
    const trun = fullbox('trun', 0, TRUN_FLAGS, u32(entryCount), u32(moofSize), ...entryBytes);

    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', mfhd, traf);
    void totalBytes;
    const mdat = box('mdat', ...samples.map((s) => s.data));
    this.totalSamples += entryCount;
    return concatAll([moof, mdat]);
  }

  // ---------- moov 构造 ----------

  #mvhd(nextTrackId) {
    // v0: created,modified,timescale,duration,rate,volume,reserved(2+8),matrix(36),preDefined(24),nextTrackID
    return fullbox(
      'mvhd',
      0,
      0,
      Z4(), Z4(),
      u32(1000), Z4(),
      u32(0x00010000), // rate 1.0
      u16(0x0100), u16(0), // volume, reserved
      Z4(), Z4(), // reserved(8)
      IDENTITY_MATRIX,
      ...new Array(6).fill(Z4()), // preDefined(24)
      u32(nextTrackId),
    );
  }

  #videoTrakBody(trackId) {
    const t = this.videoTrack;
    const width = t.width ?? 0;
    const height = t.height ?? 0;
    const avcC = box('avcC', t.description);
    // VisualSampleEntry(avc1) 精确布局：
    //   reserved(6) + dataRefIdx(2) + preDefined(2) + reserved(2) + preDefined(12)
    //   + width(2) + height(2) + horizRes(4) + vertRes(4) + reserved(4)
    //   + frameCount(2) + compressorname(32) + depth(2) + preDefined(2) + avcC
    const avc1 = box(
      'avc1',
      Z4(), u16(0), u16(1), // reserved(6) + dataReferenceIndex
      u16(0), u16(0), // preDefined, reserved
      Z4(), Z4(), Z4(), // preDefined(12)
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), // 72dpi
      Z4(), // reserved(4)
      u16(1), // frameCount
      Uint8Array.from(new Array(32).fill(0)), // compressorname
      u16(0x18), u16(0xffff), // depth, preDefined(-1)
      avcC,
    );
    const stsd = fullbox('stsd', 0, 0, u32(1), avc1);
    return this.#trak({
      trackId,
      timescale: VIDEO_TIMESCALE,
      handler: 'vide',
      handlerName: 'VideoHandler',
      volume: 0,
      width,
      height,
      stsd,
    });
  }

  #audioTrakBody(trackId) {
    const t = this.audioTrack;
    const channels = t.channels ?? t.numberOfChannels ?? 2;
    const sampleRate = t.sampleRate ?? 44100;
    // AudioSampleEntry(mp4a) 精确布局：
    //   reserved(6) + dataRefIdx(2) + reserved(8)
    //   + channelCount(2) + sampleSize(2) + preDefined(2) + reserved(2) + sampleRate 16.16(4) + esds
    const mp4a = box(
      'mp4a',
      Z4(), u16(0), u16(1), // reserved(6) + dataReferenceIndex
      Z4(), Z4(), // reserved(8)
      u16(channels),
      u16(16), // sampleSize
      u16(0), u16(0), // preDefined, reserved
      u32((sampleRate << 16) >>> 0),
      esdsFromAsc(t.description, trackId),
    );
    const stsd = fullbox('stsd', 0, 0, u32(1), mp4a);
    return this.#trak({
      trackId,
      timescale: sampleRate,
      handler: 'soun',
      handlerName: 'SoundHandler',
      volume: 0x0100,
      width: 0,
      height: 0,
      stsd,
    });
  }

  #trak({ trackId, timescale, handler, handlerName, volume, width, height, stsd }) {
    const tkhd = fullbox(
      'tkhd',
      0,
      7, // enabled | inMovie | inPreview
      Z4(), Z4(), // created, modified
      u32(trackId),
      Z4(), // reserved
      Z4(), // duration（流式未知）
      Z4(), Z4(), // reserved(8)
      u16(0), u16(0), // layer, alternateGroup
      u16(volume),
      u16(0), // reserved
      IDENTITY_MATRIX,
      u32((width << 16) >>> 0),
      u32((height << 16) >>> 0),
    );
    const mdhd = fullbox('mdhd', 0, 0, Z4(), Z4(), u32(timescale), Z4(), u16(0x55c4) /*und*/, u16(0));
    const hdlr = fullbox('hdlr', 0, 0, Z4(), str(handler), Z4(), Z4(), Z4(), nullTerm(handlerName));
    const mediaHeader = handler === 'vide'
      ? fullbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullbox('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
    const emptyTables = [
      fullbox('stts', 0, 0, Z4()),
      fullbox('stsc', 0, 0, Z4()),
      fullbox('stsz', 0, 0, Z4(), Z4()),
      fullbox('stco', 0, 0, Z4()),
    ];
    const minf = box('minf', mediaHeader, dinf, box('stbl', stsd, ...emptyTables));
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  }
}

const IDENTITY_MATRIX = Uint8Array.from([
  0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00, 0, 0, 0, 0,
]);

function toTicks(us, timescale) {
  return Math.round((us * timescale) / 1_000_000);
}
