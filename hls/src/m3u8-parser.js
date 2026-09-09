/**
 * m3u8-parser.js —— HLS 播放列表解析器（RFC 8216 + LL-HLS 扩展草案）
 *
 * 覆盖范围：
 *  - MASTER：#EXT-X-STREAM-INF（BANDWIDTH/AVERAGE-BANDWIDTH/RESOLUTION/CODECS/FRAME-RATE/AUDIO/SUBTITLES）、
 *            #EXT-X-MEDIA（音频/字幕 Rendition）、会话级 #EXT-X-SESSION-KEY
 *  - MEDIA ：#EXTINF、#EXT-X-KEY、#EXT-X-MAP、#EXT-X-BYTERANGE、#EXT-X-DISCONTINUITY(-SEQUENCE)、
 *            #EXT-X-GAP、#EXT-X-PROGRAM-DATE-TIME、#EXT-X-MEDIA-SEQUENCE、#EXT-X-TARGETDURATION、
 *            #EXT-X-PLAYLIST-TYPE、#EXT-X-ENDLIST、#EXT-X-INDEPENDENT-SEGMENTS、#EXT-X-START、
 *            #EXT-X-SKIP（Delta Playlist）
 *  - LL-HLS：#EXT-X-PART-INF、#EXT-X-PART（含 RANGE/INDEPENDENT/GAP）、#EXT-X-SERVER-CONTROL、
 *            #EXT-X-PRELOAD-HINT、#EXT-X-RENDITION-REPORT
 *
 * 设计原则：解析层只做"语法 -> 结构化对象"，不做网络与播放决策。
 */

import { parseAttributes, parseByteRange, resolveUrl, splitCodecs, toNumber, hexToUint8 } from './utils.js';
import { PlayerError, ErrorCode } from '../../core/src/errors.js';

const parseFail = (msg) => new PlayerError(ErrorCode.PARSE_ERROR, msg);

const TAG = {
  M3U: '#EXTM3U',
  VERSION: '#EXT-X-VERSION',
  // ---- 媒体分片相关 ----
  INF: '#EXTINF',
  KEY: '#EXT-X-KEY',
  MAP: '#EXT-X-MAP',
  BYTERANGE: '#EXT-X-BYTERANGE',
  DISCONTINUITY: '#EXT-X-DISCONTINUITY',
  DISCONTINUITY_SEQUENCE: '#EXT-X-DISCONTINUITY-SEQUENCE',
  GAP: '#EXT-X-GAP',
  PDT: '#EXT-X-PROGRAM-DATE-TIME',
  MEDIA_SEQUENCE: '#EXT-X-MEDIA-SEQUENCE',
  TARGET_DURATION: '#EXT-X-TARGETDURATION',
  PLAYLIST_TYPE: '#EXT-X-PLAYLIST-TYPE',
  ENDLIST: '#EXT-X-ENDLIST',
  INDEPENDENT_SEGMENTS: '#EXT-X-INDEPENDENT-SEGMENTS',
  START: '#EXT-X-START',
  SKIP: '#EXT-X-SKIP',
  // ---- 多码率相关 ----
  STREAM_INF: '#EXT-X-STREAM-INF',
  MEDIA: '#EXT-X-MEDIA',
  SESSION_KEY: '#EXT-X-SESSION-KEY',
  SESSION_DATA: '#EXT-X-SESSION-DATA',
  // ---- LL-HLS ----
  PART_INF: '#EXT-X-PART-INF',
  PART: '#EXT-X-PART',
  SERVER_CONTROL: '#EXT-X-SERVER-CONTROL',
  PRELOAD_HINT: '#EXT-X-PRELOAD-HINT',
  RENDITION_REPORT: '#EXT-X-RENDITION-REPORT',
};

/** 解析 RESOLUTION=1280x720 */
function parseResolution(v) {
  if (!v) return null;
  const m = /^(\d+)[xX](\d+)$/.exec(String(v).trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 解析 IV 属性：严格校验后转 16 字节（奇数长度/超长均报错，不静默截断） */
function parseIv(attrs) {
  if (attrs.IV === undefined) return null; // 无 IV：按规范用媒体序号推导
  let hex = String(attrs.IV).trim().replace(/^0[xX]/, '');
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw parseFail(`m3u8 解析失败：IV 十六进制长度非法（${hex.length} 位，须为偶数）`);
  }
  if (hex.length > 32) {
    throw parseFail(`m3u8 解析失败：IV 超过 128 位（${hex.length} 位十六进制）`);
  }
  if (/[^0-9a-fA-F]/.test(hex)) {
    throw parseFail('m3u8 解析失败：IV 含非十六进制字符');
  }
  // 右对齐填充到 16 字节（RFC 8216：IV 为 128 位值）
  const raw = hexToUint8(hex);
  const bytes = new Uint8Array(16);
  bytes.set(raw, 16 - raw.length);
  return { raw: attrs.IV, bytes };
}

/** 解析加密 Key 结构 */
function parseKeyAttrs(attrs, baseUrl) {
  const method = attrs.METHOD || 'NONE';
  if (method === 'NONE') {
    return { method: 'NONE', uri: null, iv: null, keyFormat: null };
  }
  return {
    method, // 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR'
    uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
    iv: parseIv(attrs),
    keyFormat: attrs.KEYFORMAT || null,
    keyFormatVersions: attrs.KEYFORMATVERSIONS || '1',
  };
}

/** 剥离 BOM、切行，并校验 #EXTM3U 首行（RFC 8216 §4.3.1.1） */
function splitPlaylistLines(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '');
  if (!first || first.trim() !== '#EXTM3U') {
    throw parseFail('m3u8 解析失败：首行必须是 #EXTM3U');
  }
  return lines;
}

/**
 * 判断 m3u8 文本是 MASTER 还是 MEDIA 播放列表。
 * 规则：出现 #EXT-X-STREAM-INF 或 #EXT-X-I-FRAME-STREAM-INF 即为 MASTER；
 * 出现 #EXTINF / #EXT-X-TARGETDURATION 即为 MEDIA；两者皆无按 MEDIA 处理（容错）。
 */
export function detectPlaylistType(text) {
  if (/^\s*#EXT-X-STREAM-INF/m.test(text)) return 'master';
  if (/^\s*#EXT-X-I-FRAME-STREAM-INF/m.test(text)) return 'master';
  if (/^\s*#EXTINF/m.test(text) || /^\s*#EXT-X-TARGETDURATION/m.test(text)) return 'media';
  return 'media';
}

/* ------------------------------------------------------------------ */
/* MASTER 播放列表                                                     */
/* ------------------------------------------------------------------ */

/**
 * 解析 MASTER 播放列表。
 * @param {string} text   m3u8 文本
 * @param {string} [baseUrl] 该 m3u8 的绝对地址，用于相对地址解析
 */
export function parseMaster(text, baseUrl = '') {
  const lines = splitPlaylistLines(text);
  const levels = [];
  const audioTracks = [];
  const subtitleTracks = [];
  const sessionKeys = [];
  let pendingStreamInf = null;
  let iframes = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === TAG.M3U) continue;
    if (!line.startsWith('#')) {
      // 非注释行 = URI 行，归属最近的标签
      if (pendingStreamInf) {
        const attrs = pendingStreamInf;
        const codecs = splitCodecs(attrs.CODECS);
        levels.push({
          url: resolveUrl(line, baseUrl),
          bandwidth: toNumber(attrs.BANDWIDTH) || 0,
          averageBandwidth: toNumber(attrs.AVERAGE_BANDWIDTH) || 0,
          resolution: parseResolution(attrs.RESOLUTION),
          codecs: attrs.CODECS || '',
          videoCodec: codecs.video,
          audioCodec: codecs.audio,
          frameRate: toNumber(attrs['FRAME-RATE']) || 0,
          audioGroup: attrs.AUDIO || null,
          subtitlesGroup: attrs.SUBTITLES || null,
          videoRange: attrs['VIDEO-RANGE'] || null,
          name: attrs.NAME ? String(attrs.NAME) : '',
          // 清晰度展示名：优先 NAME，否则用分辨率高度，否则用带宽
          label:
            attrs.NAME ||
            (parseResolution(attrs.RESOLUTION)
              ? `${parseResolution(attrs.RESOLUTION).height}p`
              : ''),
        });
        pendingStreamInf = null;
      }
      continue;
    }
    if (line.startsWith(TAG.STREAM_INF)) {
      pendingStreamInf = parseAttributes(line.slice(TAG.STREAM_INF.length + 1));
      continue;
    }
    if (line.startsWith(TAG.MEDIA)) {
      const a = parseAttributes(line.slice(TAG.MEDIA.length + 1));
      const track = {
        type: a.TYPE || '', // AUDIO | SUBTITLES | CLOSED-CAPTIONS
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        default: String(a.DEFAULT) === 'YES',
        autoselect: String(a.AUTOSELECT) === 'YES',
        forced: String(a.FORCED) === 'YES',
        channels: toNumber(a.CHANNELS) || 0,
        url: a.URI ? resolveUrl(a.URI, baseUrl) : null,
      };
      if (track.type === 'AUDIO') audioTracks.push(track);
      else if (track.type === 'SUBTITLES') subtitleTracks.push(track);
      continue;
    }
    if (line.startsWith(TAG.SESSION_KEY)) {
      sessionKeys.push(parseKeyAttrs(parseAttributes(line.slice(TAG.SESSION_KEY.length + 1)), baseUrl));
      continue;
    }
    // I-frame playlist 也登记为 level（仅作提示，当前不参与切换）
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      const a = parseAttributes(line.slice('#EXT-X-I-FRAME-STREAM-INF'.length + 1));
      if (a.URI) iframes.push(resolveUrl(a.URI, baseUrl));
      continue;
    }
  }

  if (!levels.length && !audioTracks.length && !subtitleTracks.length) {
    throw parseFail('m3u8 解析失败：未找到任何 #EXT-X-STREAM-INF / #EXT-X-MEDIA 条目');
  }

  // 按带宽降序排列，方便上层做"最高清晰度优先"策略
  levels.sort((a, b) => b.bandwidth - a.bandwidth);

  return {
    type: 'master',
    levels,
    audioTracks,
    subtitleTracks,
    sessionKeys,
    iframePlaylists: iframes,
  };
}

/* ------------------------------------------------------------------ */
/* MEDIA 播放列表                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解析 MEDIA 播放列表（点播或直播）。
 * @param {string} text
 * @param {string} [baseUrl]
 */
export function parseMedia(text, baseUrl = '') {
  const lines = splitPlaylistLines(text);
  /** @type {any[]} */
  const segments = [];
  let current = null;
  let prevByteRangeEnd = null;
  let segmentCounter = -1; // 播放列表内的分片下标（0 基）
  // 连续性计数器：EXT-X-DISCONTINUITY-SEQUENCE 设初值，之后每个 DISCONTINUITY 标签 +1
  // （初值 0；若播放列表声明了 DISCONTINUITY-SEQUENCE，解析到该标签时会重新赋值）
  let ccCounter = 0;

  const result = {
    type: 'media',
    version: 1,
    targetDuration: 0,
    partTargetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    playlistType: null, // VOD | EVENT | null(直播滑动窗口)
    independentSegments: false,
    start: null,
    skippedSegments: 0, // EXT-X-SKIP（Delta 更新）
    hasEndlist: false,
    segments,
    totalDuration: 0,
    serverControl: null,
    preloadHint: null,
    renditionReports: [],
  };

  let lastKey = { method: 'NONE', uri: null, iv: null, keyFormat: null };
  let lastMap = null;
  /** 前置 BYTERANGE（出现在所属分片 EXTINF 之前，非规范排列）：暂存并挂给下一个分片 */
  let pendingByteRange = null;
  let discontinuityPending = false;
  let gapPending = false;
  // LL-HLS：EXT-X-PART / PROGRAM-DATE-TIME 按规范出现在所属分片的 EXTINF 之前，
  // 先挂起、在分片创建时归属（若出现在分片之后则直接归当前分片，容错）
  /** @type {any[]} */
  let pendingParts = [];
  let pendingPdt = null;

  const flushSegment = () => {
    if (!current) return;
    if (current.duration == null || Number.isNaN(current.duration)) {
      throw parseFail(`m3u8 解析失败：第 ${current.index} 个分片缺少 #EXTINF 时长`);
    }
    // sn 在 flush 时计算；Delta 清单（EXT-X-SKIP）中被省略的分段计入偏移
    // （RFC 8216bis：首个在列分片的 sn = MEDIA-SEQUENCE + SKIPPED-SEGMENTS）
    current.sn = result.mediaSequence + result.skippedSegments + current.index;
    segments.push(current);
    current = null;
    pendingParts = []; // 已归属分片的 parts 清空
  };

  /** 应用挂起的 discontinuity/gap/parts/pdt 到刚创建的分片 */
  const applyPendingFlags = (seg) => {
    if (discontinuityPending) {
      seg.discontinuity = true;
      ccCounter += 1; // 每个真实断点使连续性编号 +1
      discontinuityPending = false;
    }
    if (gapPending) {
      seg.gap = true;
      gapPending = false;
    }
    if (pendingParts.length && !seg.parts.length) seg.parts = pendingParts.splice(0);
    if (pendingPdt && !seg.programDateTime) {
      seg.programDateTime = pendingPdt;
      pendingPdt = null;
    }
    seg.cc = ccCounter;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === TAG.M3U) continue;

    if (!line.startsWith('#')) {
      // URI 行：一个分片的资源地址
      if (!current) {
        segmentCounter += 1;
        current = {
          index: segmentCounter,
          url: resolveUrl(line, baseUrl),
          duration: null,
          title: '',
          byteRange: null,
          key: null,
          map: null,
          discontinuity: false,
          gap: false,
          programDateTime: null,
          parts: [],
        };
        // 继承当前生效的 key/map/标记（规范上 URI 行必须跟在 EXTINF 后，此处为容错）
        if (lastKey.method !== 'NONE') current.key = lastKey;
        if (lastMap) current.map = lastMap;
        applyPendingFlags(current);
      } else {
        current.url = resolveUrl(line, baseUrl);
      }
      flushSegment();
      continue;
    }

    if (line.startsWith(TAG.INF)) {
      flushSegment();
      segmentCounter += 1;
      const body = line.slice(TAG.INF.length + 1); // "5.76,title"
      const commaAt = body.indexOf(',');
      const durStr = commaAt >= 0 ? body.slice(0, commaAt) : body;
      current = {
        index: segmentCounter,
        url: '',
        duration: toNumber(durStr),
        title: commaAt >= 0 ? body.slice(commaAt + 1).trim() : '',
        byteRange: pendingByteRange, // 前置 BYTERANGE（非规范）在此归属
        key: lastKey.method !== 'NONE' ? lastKey : null,
        map: lastMap,
        discontinuity: false,
        gap: false,
        programDateTime: null,
        parts: [],
      };
      pendingByteRange = null;
      applyPendingFlags(current);
      continue;
    }

    if (line.startsWith(TAG.BYTERANGE)) {
      const br = parseByteRange(line.slice(TAG.BYTERANGE.length + 1), prevByteRangeEnd);
      if (br) {
        if (br.offset == null) {
          throw parseFail('m3u8 解析失败：BYTERANGE 缺省 offset 但无前序引用可滚动');
        }
        if (!(br.length > 0)) {
          // RFC 8216 §4.3.2.2：length 必须为正整数；length=0 会生成非法
          // "bytes=offset-(offset-1)" 请求头，须在解析期拦截。
          throw parseFail(`m3u8 解析失败：BYTERANGE 长度必须为正整数，实际 ${br.length}`);
        }
        prevByteRangeEnd = br.offset + br.length;
        if (current) current.byteRange = br;
        else pendingByteRange = br; // 前置（非规范）：挂给下一个 EXTINF 分片
      }
      continue;
    }

    if (line.startsWith(TAG.KEY)) {
      lastKey = parseKeyAttrs(parseAttributes(line.slice(TAG.KEY.length + 1)), baseUrl);
      if (current) current.key = lastKey.method !== 'NONE' ? lastKey : null;
      continue;
    }

    if (line.startsWith(TAG.MAP)) {
      const a = parseAttributes(line.slice(TAG.MAP.length + 1));
      const mapByteRange = a.BYTERANGE
        ? (() => {
            const br = parseByteRange(a.BYTERANGE, prevByteRangeEnd);
            return br && br.offset >= 0 && br.length > 0 ? br : null;
          })()
        : null;
      lastMap = {
        uri: resolveUrl(a.URI, baseUrl),
        byteRange: mapByteRange,
      };
      if (current) current.map = lastMap;
      continue;
    }

    if (line.startsWith(TAG.DISCONTINUITY_SEQUENCE)) {
      result.discontinuitySequence = Number(line.split(':')[1]) || 0;
      ccCounter = result.discontinuitySequence;
      continue;
    }
    if (line === TAG.DISCONTINUITY) {
      discontinuityPending = true;
      continue;
    }
    if (line.startsWith(TAG.GAP)) {
      gapPending = true;
      continue;
    }
    if (line.startsWith(TAG.PDT)) {
      // 注意：ISO8601 时间串自身含冒号，不能用 split(':') 取值
      const iso = line.slice(TAG.PDT.length + 1);
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) {
        const pdtIso = d.toISOString();
        if (current) current.programDateTime = pdtIso;
        else pendingPdt = pdtIso;
      }
      continue;
    }
    if (line.startsWith(TAG.MEDIA_SEQUENCE)) {
      // 规范要求出现在首个 EXTINF 之前；sn 在 flushSegment 时统一计算
      result.mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith(TAG.TARGET_DURATION)) {
      result.targetDuration = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith(TAG.PLAYLIST_TYPE)) {
      result.playlistType = (line.split(':')[1] || '').trim().toUpperCase();
      continue;
    }
    if (line === TAG.ENDLIST) {
      result.hasEndlist = true;
      flushSegment();
      continue;
    }
    if (line === TAG.INDEPENDENT_SEGMENTS) {
      result.independentSegments = true;
      continue;
    }
    if (line.startsWith(TAG.VERSION)) {
      result.version = Number(line.split(':')[1]) || 1;
      continue;
    }
    if (line.startsWith(TAG.START)) {
      result.start = parseAttributes(line.slice(TAG.START.length + 1));
      continue;
    }
    if (line.startsWith(TAG.SKIP)) {
      const a = parseAttributes(line.slice(TAG.SKIP.length + 1));
      result.skippedSegments = toNumber(a['SKIPPED-SEGMENTS']) || 0;
      continue;
    }

    /* ---------------- LL-HLS ---------------- */
    if (line.startsWith(TAG.PART_INF)) {
      const a = parseAttributes(line.slice(TAG.PART_INF.length + 1));
      result.partTargetDuration = toNumber(a['PART-TARGET']) || null;
      continue;
    }
    if (line.startsWith(TAG.PART)) {
      const a = parseAttributes(line.slice(TAG.PART.length + 1));
      const br = a.RANGE ? parseByteRange(a.RANGE, prevByteRangeEnd) : null;
      if (br && br.offset != null) prevByteRangeEnd = br.offset + br.length;
      const part = {
        uri: resolveUrl(a.URI, baseUrl),
        duration: toNumber(a.DURATION) || 0,
        byteRange: br && br.offset != null ? br : null,
        independent: String(a.INDEPENDENT) === 'YES',
        gap: String(a.GAP) === 'YES',
      };
      if (current) current.parts.push(part);
      else pendingParts.push(part); // 规范位置：PART 在所属分片 EXTINF 之前
      continue;
    }
    if (line.startsWith(TAG.SERVER_CONTROL)) {
      const a = parseAttributes(line.slice(TAG.SERVER_CONTROL.length + 1));
      result.serverControl = {
        canSkipUntil: toNumber(a['CAN-SKIP-UNTIL']) || 0,
        canSkipDvrPassthrough: String(a['CAN-SKIP-DVR-PASSTHROUGH']) === 'YES',
        holdBack: toNumber(a['HOLD-BACK']) || 0,
        partHoldBack: toNumber(a['PART-HOLD-BACK']) || 0,
        canBlockReload: String(a['CAN-BLOCK-RELOAD']) === 'YES',
      };
      continue;
    }
    if (line.startsWith(TAG.PRELOAD_HINT)) {
      const a = parseAttributes(line.slice(TAG.PRELOAD_HINT.length + 1));
      result.preloadHint = {
        type: a.TYPE || '',
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        byteRangeStart: toNumber(a['BYTERANGE-START']) || 0,
        byteRangeLength: a['BYTERANGE-LENGTH'] != null ? toNumber(a['BYTERANGE-LENGTH']) : null,
      };
      continue;
    }
    if (line.startsWith(TAG.RENDITION_REPORT)) {
      const a = parseAttributes(line.slice(TAG.RENDITION_REPORT.length + 1));
      result.renditionReports.push({
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        lastMsn: toNumber(a['LAST-MSN']) || 0,
        lastPart: a['LAST-PART'] != null ? toNumber(a['LAST-PART']) : null,
      });
      continue;
    }
    // 其余未支持标签静默忽略（向前兼容）
  }

  flushSegment();

  result.totalDuration = segments.reduce((s, seg) => s + seg.duration, 0);

  // TARGETDURATION 语义校验（RFC 8216 §4.4.3.1：各分片 EXTINF 四舍五入到最近整数后
  // 必须 ≤ 声明的 Target Duration —— 6.008s 配 6s 声明合规，6.6s 配 6s 才违例）。
  // 服务器违例（声明过小、数值非法被归零）会让播放器按其值驱动直播轮询周期与追赶节奏，
  // 声明过小 → 轮询过频/追赶过激；归零 → 依赖调用方 6s 猜测。
  // 容错策略：以实际最大分片时长上取整自愈提升声明值（合规流不受影响），
  // 违例分片数经 targetDurationViolations 暴露供上层诊断，不静默吞掉。
  if (segments.length) {
    let maxDur = 0;
    for (const seg of segments) if (seg.duration > maxDur) maxDur = seg.duration;
    if (result.targetDuration > 0 && Math.round(maxDur) > result.targetDuration) {
      result.targetDurationViolations = segments.filter(
        (s) => Math.round(s.duration) > result.targetDuration
      ).length;
      result.targetDuration = Math.ceil(maxDur);
    } else if (result.targetDuration === 0) {
      // 标签缺失（或非法值归零）：以实际最大分片时长兜底，避免调用方拍脑袋猜测
      result.targetDuration = Math.ceil(maxDur);
    }
  }

  result.live = !result.hasEndlist && result.playlistType !== 'VOD';
  return result;
}

/**
 * 自动识别并解析任意 m3u8 文本。
 * @returns {{type:'master', ...}|{type:'media', ...}}
 */
export function parsePlaylist(text, baseUrl = '') {
  return detectPlaylistType(text) === 'master'
    ? parseMaster(text, baseUrl)
    : parseMedia(text, baseUrl);
}
