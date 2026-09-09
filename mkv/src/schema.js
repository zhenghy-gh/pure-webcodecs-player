/**
 * schema.js —— Matroska/WebM 元素表（EBML Schema 子集）
 *
 * 收录解析 MKV/WebM 必需的元素 ID 与类型映射。
 * 类型代号：
 *   m = Master（容器）  u = Unsigned Integer  i = Signed Integer
 *   f = Float           s = ASCII String      8 = UTF-8 String
 *   b = Binary          d = Date（纳秒，自 2001-01-01 起）
 *
 * 说明：本表为「够用且可扩展」子集，未收录的元素按 Unknown 处理，
 * 解析器会依据其尺寸字段安全跳过（含未知长度元素的边界探测）。
 */

/** 元素类型常量 */
export const TYPE = Object.freeze({
  MASTER: 'm',
  UINT: 'u',
  INT: 'i',
  FLOAT: 'f',
  STRING: 's',
  UTF8: '8',
  BINARY: 'b',
  DATE: 'd',
});

/** 关键元素 ID（十六进制字面量即其规范编码值，含标记位） */
export const ID = Object.freeze({
  // ── EBML 头 ────────────────────────────────────────────────
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  // ── 全局 ──────────────────────────────────────────────────
  Void: 0xec,
  CRC32: 0xbf,

  // ── Segment 层 ────────────────────────────────────────────
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,

  // ── Info ──────────────────────────────────────────────────
  Info: 0x1549a966,
  SegmentUID: 0x73a4,
  SegmentFilename: 0x7384,
  TimecodeScale: 0x2ad7b1, // 段内时间戳单位（纳秒），默认 1_000_000
  DateUTC: 0x4461,
  Title: 0x7ba9,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489, // Float，单位 = TimecodeScale

  // ── Tracks ────────────────────────────────────────────────
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83, // 1=video 2=audio 0x11=subtitle
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagLacing: 0x9c,
  DefaultDuration: 0x23e383, // 单帧时长（纳秒），可推帧率
  TrackName: 0x536e,
  TrackLanguage: 0x22b59c,
  LanguageIETF: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa, // 纳秒
  SeekPreRoll: 0x56bb, // 纳秒
  ContentEncodings: 0x6d80, // 存在即含压缩/加密变换 → 本期视为加密轨（NOT_SUPPORTED）

  // ── Video / Audio 轨参数 ──────────────────────────────────
  Video: 0xe0,
  FlagInterlaced: 0x9a,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  PixelCropLeft: 0x54cc,
  PixelCropRight: 0x54dd,
  PixelCropTop: 0x54bb,
  PixelCropBottom: 0x54aa,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5, // Float
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x62a4,

  // ── Cluster / Block ───────────────────────────────────────
  Cluster: 0x1f43b675,
  ClusterTimecode: 0xe7,
  ClusterPrevSize: 0xab,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  // 注：BlockAdditional 规范 ID 为 0xA1，与 Track 层的 Block(0xA1) 在不同父级下同值；
  // 本解析器使用全局扁平表，为避免撞名不收录该元素（按 Unknown Binary 跳过即可）。
  BlockDuration: 0x9b,
  ReferencePriority: 0xfa,
  ReferenceBlock: 0xfb, // 存在即非关键帧
  DiscardPadding: 0x75a2,

  // ── Cues（索引）───────────────────────────────────────────
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1, // 相对 Segment 数据起点的偏移
  CueRelativePosition: 0xf0,
  CueBlockNumber: 0x5378,

  // ── 其余顶层（识别并跳过）─────────────────────────────────
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
});

/**
 * ID → { name, type } 映射表。
 * 未登记的元素在解析时记 name=undefined、type 由调用方按 Binary 兜底。
 */
export const SCHEMA = new Map([
  [ID.EBML, { name: 'EBML', type: TYPE.MASTER }],
  [ID.EBMLVersion, { name: 'EBMLVersion', type: TYPE.UINT }],
  [ID.EBMLReadVersion, { name: 'EBMLReadVersion', type: TYPE.UINT }],
  [ID.EBMLMaxIDLength, { name: 'EBMLMaxIDLength', type: TYPE.UINT }],
  [ID.EBMLMaxSizeLength, { name: 'EBMLMaxSizeLength', type: TYPE.UINT }],
  [ID.DocType, { name: 'DocType', type: TYPE.STRING }],
  [ID.DocTypeVersion, { name: 'DocTypeVersion', type: TYPE.UINT }],
  [ID.DocTypeReadVersion, { name: 'DocTypeReadVersion', type: TYPE.UINT }],

  [ID.Void, { name: 'Void', type: TYPE.BINARY }],
  [ID.CRC32, { name: 'CRC32', type: TYPE.BINARY }],

  [ID.Segment, { name: 'Segment', type: TYPE.MASTER }],
  [ID.SeekHead, { name: 'SeekHead', type: TYPE.MASTER }],
  [ID.Seek, { name: 'Seek', type: TYPE.MASTER }],
  [ID.SeekID, { name: 'SeekID', type: TYPE.BINARY }],
  [ID.SeekPosition, { name: 'SeekPosition', type: TYPE.UINT }],

  [ID.Info, { name: 'Info', type: TYPE.MASTER }],
  [ID.SegmentUID, { name: 'SegmentUID', type: TYPE.BINARY }],
  [ID.SegmentFilename, { name: 'SegmentFilename', type: TYPE.UTF8 }],
  [ID.TimecodeScale, { name: 'TimecodeScale', type: TYPE.UINT }],
  [ID.DateUTC, { name: 'DateUTC', type: TYPE.DATE }],
  [ID.Title, { name: 'Title', type: TYPE.UTF8 }],
  [ID.MuxingApp, { name: 'MuxingApp', type: TYPE.UTF8 }],
  [ID.WritingApp, { name: 'WritingApp', type: TYPE.UTF8 }],
  [ID.Duration, { name: 'Duration', type: TYPE.FLOAT }],

  [ID.Tracks, { name: 'Tracks', type: TYPE.MASTER }],
  [ID.TrackEntry, { name: 'TrackEntry', type: TYPE.MASTER }],
  [ID.TrackNumber, { name: 'TrackNumber', type: TYPE.UINT }],
  [ID.TrackUID, { name: 'TrackUID', type: TYPE.UINT }],
  [ID.TrackType, { name: 'TrackType', type: TYPE.UINT }],
  [ID.FlagEnabled, { name: 'FlagEnabled', type: TYPE.UINT }],
  [ID.FlagDefault, { name: 'FlagDefault', type: TYPE.UINT }],
  [ID.FlagForced, { name: 'FlagForced', type: TYPE.UINT }],
  [ID.FlagLacing, { name: 'FlagLacing', type: TYPE.UINT }],
  [ID.DefaultDuration, { name: 'DefaultDuration', type: TYPE.UINT }],
  [ID.TrackName, { name: 'TrackName', type: TYPE.UTF8 }],
  [ID.TrackLanguage, { name: 'TrackLanguage', type: TYPE.STRING }],
  [ID.LanguageIETF, { name: 'LanguageIETF', type: TYPE.STRING }],
  [ID.CodecID, { name: 'CodecID', type: TYPE.STRING }],
  [ID.CodecPrivate, { name: 'CodecPrivate', type: TYPE.BINARY }],
  [ID.CodecDelay, { name: 'CodecDelay', type: TYPE.UINT }],
  [ID.SeekPreRoll, { name: 'SeekPreRoll', type: TYPE.UINT }],
  [ID.ContentEncodings, { name: 'ContentEncodings', type: TYPE.MASTER }],

  [ID.Video, { name: 'Video', type: TYPE.MASTER }],
  [ID.FlagInterlaced, { name: 'FlagInterlaced', type: TYPE.UINT }],
  [ID.PixelWidth, { name: 'PixelWidth', type: TYPE.UINT }],
  [ID.PixelHeight, { name: 'PixelHeight', type: TYPE.UINT }],
  [ID.PixelCropLeft, { name: 'PixelCropLeft', type: TYPE.UINT }],
  [ID.PixelCropRight, { name: 'PixelCropRight', type: TYPE.UINT }],
  [ID.PixelCropTop, { name: 'PixelCropTop', type: TYPE.UINT }],
  [ID.PixelCropBottom, { name: 'PixelCropBottom', type: TYPE.UINT }],
  [ID.DisplayWidth, { name: 'DisplayWidth', type: TYPE.UINT }],
  [ID.DisplayHeight, { name: 'DisplayHeight', type: TYPE.UINT }],
  [ID.Audio, { name: 'Audio', type: TYPE.MASTER }],
  [ID.SamplingFrequency, { name: 'SamplingFrequency', type: TYPE.FLOAT }],
  [ID.OutputSamplingFrequency, { name: 'OutputSamplingFrequency', type: TYPE.FLOAT }],
  [ID.Channels, { name: 'Channels', type: TYPE.UINT }],
  [ID.BitDepth, { name: 'BitDepth', type: TYPE.UINT }],

  [ID.Cluster, { name: 'Cluster', type: TYPE.MASTER }],
  [ID.ClusterTimecode, { name: 'ClusterTimecode', type: TYPE.UINT }],
  [ID.ClusterPrevSize, { name: 'ClusterPrevSize', type: TYPE.UINT }],
  [ID.SimpleBlock, { name: 'SimpleBlock', type: TYPE.BINARY }],
  [ID.BlockGroup, { name: 'BlockGroup', type: TYPE.MASTER }],
  [ID.Block, { name: 'Block', type: TYPE.BINARY }],
  [ID.BlockAdditions, { name: 'BlockAdditions', type: TYPE.MASTER }],
  [ID.BlockMore, { name: 'BlockMore', type: TYPE.MASTER }],
  [ID.BlockAddID, { name: 'BlockAddID', type: TYPE.UINT }],
  [ID.BlockDuration, { name: 'BlockDuration', type: TYPE.UINT }],
  [ID.ReferencePriority, { name: 'ReferencePriority', type: TYPE.UINT }],
  [ID.ReferenceBlock, { name: 'ReferenceBlock', type: TYPE.INT }],
  [ID.DiscardPadding, { name: 'DiscardPadding', type: TYPE.INT }],

  [ID.Cues, { name: 'Cues', type: TYPE.MASTER }],
  [ID.CuePoint, { name: 'CuePoint', type: TYPE.MASTER }],
  [ID.CueTime, { name: 'CueTime', type: TYPE.UINT }],
  [ID.CueTrackPositions, { name: 'CueTrackPositions', type: TYPE.MASTER }],
  [ID.CueTrack, { name: 'CueTrack', type: TYPE.UINT }],
  [ID.CueClusterPosition, { name: 'CueClusterPosition', type: TYPE.UINT }],
  [ID.CueRelativePosition, { name: 'CueRelativePosition', type: TYPE.UINT }],
  [ID.CueBlockNumber, { name: 'CueBlockNumber', type: TYPE.UINT }],

  [ID.Attachments, { name: 'Attachments', type: TYPE.MASTER }],
  [ID.Chapters, { name: 'Chapters', type: TYPE.MASTER }],
  [ID.Tags, { name: 'Tags', type: TYPE.MASTER }],
]);

/** TrackType 数值 → 类型名（契约 §1.2：字幕轨定稿 'text'） */
export const TRACK_TYPE_NAME = Object.freeze({
  0x01: 'video',
  0x02: 'audio',
  0x11: 'text',
});
