/**
 * MASTER 播放列表解析单测（fixture 全部内联，无外网依赖）
 * 运行：node --test hls/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaster, detectPlaylistType } from '../src/m3u8-parser.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub/zh.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30,AUDIO="aud",SUBTITLES="sub"
v720/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=4120000,AVERAGE-BANDWIDTH=3800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=30,AUDIO="aud"
v1080/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="avc1.42E00A,mp4a.40.2",RESOLUTION=640x360
v360/index.m3u8`;

const BASE = 'https://cdn.example.com/live/master.m3u8';

test('detectPlaylistType 识别 master', () => {
  assert.equal(detectPlaylistType(MASTER), 'master');
});

test('master 解析：levels 数量 / 排序 / 字段', () => {
  const m = parseMaster(MASTER, BASE);
  assert.equal(m.type, 'master');
  assert.equal(m.levels.length, 3);
  // 按 bandwidth 降序：1080 在前，360 在后
  assert.deepEqual(
    m.levels.map((l) => l.bandwidth),
    [4120000, 1280000, 512000]
  );
  const top = m.levels[0];
  assert.equal(top.url, 'https://cdn.example.com/live/v1080/playlist.m3u8');
  assert.deepEqual(top.resolution, { width: 1920, height: 1080 });
  assert.equal(top.videoCodec, 'avc1.640028');
  assert.equal(top.audioCodec, 'mp4a.40.2');
  assert.equal(top.frameRate, 30);
  assert.equal(top.label, '1080p');
});

test('master 解析：音频与字幕 Rendition', () => {
  const m = parseMaster(MASTER, BASE);
  assert.equal(m.audioTracks.length, 1);
  const aud = m.audioTracks[0];
  assert.equal(aud.groupId, 'aud');
  assert.equal(aud.language, 'en');
  assert.ok(aud.default);
  assert.equal(aud.url, 'https://cdn.example.com/live/audio/en.m3u8');

  assert.equal(m.subtitleTracks.length, 1);
  assert.equal(m.subtitleTracks[0].language, 'zh');
  assert.equal(m.subtitleTracks[0].default, false);
});

test('master 解析：level 与 rendition group 关联', () => {
  const m = parseMaster(MASTER, BASE);
  const l720 = m.levels.find((l) => l.bandwidth === 1280000);
  assert.equal(l720.audioGroup, 'aud');
  assert.equal(l720.subtitlesGroup, 'sub');
  // 未声明 AUDIO 的 level 为 null
  assert.equal(m.levels[0].subtitlesGroup, null);
});

test('master 无任何条目时抛出明确错误', () => {
  assert.throws(() => parseMaster('#EXTM3U\n#EXT-X-VERSION:7\n'), /未找到任何/);
});
