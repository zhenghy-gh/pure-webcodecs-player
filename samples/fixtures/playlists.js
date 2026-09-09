/**
 * samples/fixtures/playlists.js —— HLS 测试用文本常量与小工厂。
 * 全部为合法 m3u8 语法；分片名与 fixtures 其它生成器无耦合，可按需替换为 .ts/.m4s。
 */

/** 媒体播放列表（VOD，3×4 秒 TS 分片，带 ENDLIST） */
export const SAMPLE_M3U8_MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:4.000,',
  'segment-0.ts',
  '#EXTINF:4.000,',
  'segment-1.ts',
  '#EXTINF:4.000,',
  'segment-2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

/** 主播放列表（两档码率 + 独立音轨声明示例） */
export const SAMPLE_M3U8_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文配音",DEFAULT=YES,URI="audio/index.m3u8"',
  '',
  '# EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"',
  '# ↑ 上行为演示注释（行首带空格的非法指令会被解析器忽略）——真实行见下',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
  'high/index.m3u8',
].join('\n');

/** 直播滑动窗口（无 ENDLIST，MEDIA-SEQUENCE 非零，含一条 DISCONTINUITY） */
export const SAMPLE_M3U8_LIVE = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:2680',
  '#EXTINF:2.000,',
  'live-2680.ts',
  '#EXTINF:2.000,',
  'live-2681.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:2.000,',
  'live-2682.ts',
].join('\n');

/**
 * 参数化媒体播放列表工厂（需要自定义分片时长/数量时使用）。
 * @param {object} [opts] {segments=4, durationSec=6, mediaSequence=0, live=false, ext='.ts'}
 * @returns {string} m3u8 文本
 */
export function makeMediaPlaylist(opts = {}) {
  const {
    segments = 4,
    durationSec = 6,
    mediaSequence = 0,
    live = false,
    ext = '.ts',
  } = opts;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(durationSec)}`];
  if (!live || mediaSequence > 0) lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);
  for (let i = 0; i < segments; i++) {
    lines.push(`#EXTINF:${durationSec.toFixed(3)},`);
    lines.push(`seg-${i}${ext}`);
  }
  if (!live) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}
