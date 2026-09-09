/**
 * 公共数据类型定义（CONTRACTS v0.2 §1 权威形状 + 少量运行时常量/工具）。
 *
 * 硬约束（§0.5）：契约边界上一切 timestamp/duration 均为**整数微秒（µs）**；
 * 容器原生 timescale/ticks 只允许作为模块内部表示，公共导出前必须换算
 * （就近取整，本文件提供 ticksToUs/usToTicks）。Track.timescale 仅供诊断。
 *
 * 各模块不得私设同名异构类型；扩展字段一律以可选成员追加（minor 演进）。
 */

/** 轨道类型（字幕轨定稿 'text'） */
export const TrackType = Object.freeze({
  VIDEO: 'video',
  AUDIO: 'audio',
  TEXT: 'text',
  /** 其它元数据轨（如 QuickTime tmcd 时间码） */
  METADATA: 'metadata',
});

/** MediaInfo.tracks 的排序权重：video > audio > text > metadata */
export const TRACK_TYPE_ORDER = Object.freeze({ video: 0, audio: 1, text: 2, metadata: 3 });

/** 样本数据加载状态（仅 options.lazySamples 时出现） */
export const SampleDataState = Object.freeze({
  LAZY: 'lazy',
  LOADED: 'loaded',
});

/** 视频码流形态：'avc'=长度前缀(AVCC/HVCC)，'annexb'=Annex B 起始码 */
export const BitstreamFormat = Object.freeze({
  AVC: 'avc',
  ANNEXB: 'annexb',
});

/**
 * @typedef {Object} Sample 解码最小单元（契约 §1.1）
 * @property {number}     trackId   所属 Track.id
 * @property {string}     codec     规范 codec 串（恒等于所属轨的 codec）
 * @property {number}     timestamp PTS，整数微秒
 * @property {number}     duration  整数微秒；未知填 0
 * @property {Uint8Array} data      一个 Access Unit 的裸码流字节（lazy 时缺省）
 * @property {boolean}    keyframe  关键帧标志（音频/文本轨恒 true）
 * @property {number}     [dts]     解码序时间戳（µs）；视频 B 帧 DTS≠PTS 时必填
 * @property {number}     [size]    字节长度
 * @property {number}     [index]   轨内序号（0 起）
 * @property {'lazy'|'loaded'} [dataState] 仅 lazySamples 时出现
 * // ---- 以下为本仓允许的可选扩展成员（minor 演进）----
 * @property {number}     [offset]  数据源内绝对偏移（ISO-BMFF Range 直读/重封装用）
 * @property {number}     [dtsTicks] 内部诊断：原生 ticks 的 DTS
 */

/**
 * @typedef {Object} Track 单条轨（契约 §1.2）
 * @property {number} id                     MediaInfo 内唯一，从 1 开始
 * @property {'video'|'audio'|'text'|'metadata'} type
 * @property {string} codec                  规范 codec 串（§3）；未知 ''
 * @property {Uint8Array|null} [description] 解码器私有初始化数据（avcC/hvcC/ASC/OpusHead…）
 * @property {'avc'|'annexb'} [bitstreamFormat] 视频专用码流形态
 * @property {number}                        [durationUs]
 * @property {number}                        [timescale] 原生时间基（仅诊断）
 * @property {string}                        [language] ISO-639-2/T，未知 'und'
 * // video：width/height/[frameRate]/[rotation]/[sampleEntryType]
 * // audio：sampleRate/numberOfChannels/[channelLayout]
 * // ---- 过渡别名（§2.4，M2 接入波次清理）----
 * @property {Uint8Array|null} [codecPrivate] = description 的过渡别名（getter 同步）
 * @property {number}          [channelCount] = numberOfChannels 的过渡别名
 * @property {number}          [duration]     = durationUs 的过渡别名（ticks 已废止，此处即 µs）
 */

/**
 * @typedef {Object} MediaInfo 容器级元信息（契约 §1.3）
 * @property {'mp4'|'mov'|'mkv'|'webm'|'ts'|'flv'|'hls'|'wav'|'flac'|'ape'} container
 * @property {Track[]} tracks        至少一条，排序 video > audio > text > metadata
 * @property {number|null} durationUs 直播/未知 null
 * @property {boolean} seekable      直播恒 false
 * @property {boolean} live          直播恒 true 且 durationUs=null
 * @property {number}                [bitrate]
 * @property {{title?:string,[k:string]:string}} [metadata] 仅字符串叶子字段
 * // ---- 可选扩展成员 ----
 * @property {{majorBrand:string,minorVersion:number,compatible:string[]}|null} [brands] ISO-BMFF 品牌
 * @property {Record<string,string>}                                             [qtTags] QuickTime udta 标签
 */

/**
 * @typedef {Object} ProbeResult 嗅探结果（契约 §1.4）
 * @property {number} confidence     0~1；≥0.8 视为命中
 * @property {string} container      ∈ MediaInfo.container 枚举
 * @property {string[]}              [codecsHint]
 */

/** ticks → 整数微秒（就近取整） */
export function ticksToUs(ticks, timescale) {
  if (!Number.isFinite(ticks) || !Number.isFinite(timescale) || timescale <= 0) return 0;
  return Math.round((ticks * 1_000_000) / timescale);
}

/** 微秒 → ticks（就近取整；remux 边界回转用） */
export function usToTicks(us, timescale) {
  if (!Number.isFinite(us) || !Number.isFinite(timescale) || timescale <= 0) return 0;
  return Math.round((us * timescale) / 1_000_000);
}

/** 按 video > audio > text > metadata 排序（就地返回新数组） */
export function sortTracks(tracks) {
  return [...tracks].sort(
    (a, b) => (TRACK_TYPE_ORDER[a.type] ?? 9) - (TRACK_TYPE_ORDER[b.type] ?? 9),
  );
}

/**
 * 构造符合契约的 Track。过渡别名（codecPrivate/channelCount）与正式字段同步维护。
 */
export function createTrack(partial = {}) {
  const t = {
    id: 0,
    type: TrackType.METADATA,
    codec: '',
    description: null,
    bitstreamFormat: undefined,
    durationUs: undefined,
    timescale: undefined,
    language: 'und',
    ...partial,
  };
  // 过渡别名：getter 形式保持双向一致（写入别名同步正名，反之亦然）
  Object.defineProperties(t, {
    codecPrivate: {
      get() { return this.description; },
      set(v) { this.description = v; },
      enumerable: true,
      configurable: true,
    },
    channelCount: {
      get() { return this.numberOfChannels; },
      set(v) { this.numberOfChannels = v; },
      enumerable: true,
      configurable: true,
    },
  });
  return t;
}

/** 构造符合契约的 Sample（µs 时间基） */
export function createSample(partial = {}) {
  return {
    trackId: 0,
    codec: '',
    timestamp: 0,
    duration: 0,
    data: null,
    keyframe: false,
    dts: undefined,
    size: undefined,
    index: undefined,
    dataState: undefined,
    offset: undefined,
    ...partial,
  };
}

/** 构造 ProbeResult（probe 未命中一律返回 null，不返回低分对象） */
export function createProbeResult(confidence, container, codecsHint = undefined) {
  const r = { confidence, container };
  if (codecsHint) r.codecsHint = codecsHint;
  return r;
}
