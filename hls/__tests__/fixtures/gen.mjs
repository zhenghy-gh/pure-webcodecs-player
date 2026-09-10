/**
 * fixtures/gen.mjs —— hls 清单样例程序化生成（契约 §0.6）
 *
 * 用法：仓库根目录 `npm run fixtures` 一键重建；产物 gitignore、离线可复现。
 * 产出：master / media(VOD·fMP4) / media(直播·TS) / LL-HLS / BYTERANGE 五类清单文本。
 */

const MASTER = (base) => `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${base}/audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",DEFAULT=NO,URI="${base}/sub/zh.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="avc1.42E00A,mp4a.40.2",RESOLUTION=640x360
360v/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30,AUDIO="aud",SUBTITLES="sub"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4120000,AVERAGE-BANDWIDTH=3800000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="aud"
1080p/index.m3u8
`;

const MEDIA_VOD_FMP4 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5.76,
seg1.m4s
#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x9c7db8778570d05c3177c349fd9236aa
#EXTINF:6.008,
seg2.m4s
#EXT-X-KEY:METHOD=NONE
#EXTINF:5.984,
seg3.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
ad1.m4s
#EXT-X-ENDLIST
`;

const MEDIA_LIVE_TS = (() => {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:2680',
  ];
  const durs = [9.0, 9.0, 9.375, 8.75, 9.25];
  for (let i = 0; i < durs.length; i++) {
    lines.push(`#EXTINF:${durs[i].toFixed(3)},`);
    lines.push(`live-${2680 + i}.ts`);
  }
  return lines.join('\n') + '\n';
})();

const MEDIA_LLHLS = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:4
#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=24.0,PART-HOLD-BACK=1.02,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=0.33334
#EXT-X-MEDIA-SEQUENCE:160
#EXTINF:4.0,
fs160.mp4
#EXT-X-PART:DURATION=0.33334,URI="p1.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.33334,URI="p2.mp4"
#EXT-X-PART:DURATION=0.33334,URI="p3.mp4"
#EXTINF:4.0,
fs161.mp4
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="p4.mp4"
#EXT-X-RENDITION-REPORT:URI="../720p/playlist.m3u8",LAST-MSN=161,LAST-PART=2
`;

const MEDIA_BYTERANGE = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
#EXT-X-BYTERANGE:75232@0
main.mp4
#EXTINF:5.0,
#EXT-X-BYTERANGE:82112
main.mp4
#EXTINF:5.0,
#EXT-X-BYTERANGE:80304
main.mp4
#EXT-X-ENDLIST
`;

/** 契约签名：async generate(fixDir) */
export async function generate(fixDir) {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(fixDir, 'master.m3u8'), MASTER('.'), 'utf8');
  await writeFile(join(fixDir, 'media-vod-fmp4.m3u8'), MEDIA_VOD_FMP4, 'utf8');
  await writeFile(join(fixDir, 'media-live-ts.m3u8'), MEDIA_LIVE_TS, 'utf8');
  await writeFile(join(fixDir, 'media-llhls.m3u8', ), MEDIA_LLHLS, 'utf8');
  await writeFile(join(fixDir, 'media-byterange.m3u8'), MEDIA_BYTERANGE, 'utf8');
}
