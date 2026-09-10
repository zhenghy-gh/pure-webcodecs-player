/**
 * MASTER 播放列表深水区单测（第二十五波）
 * 覆盖：SESSION-KEY、VIDEO-RANGE/AVERAGE-BANDWIDTH/NAME、label 优先级、
 * I-FRAME 类型探测、CLOSED-CAPTIONS 归类、纯 Rendition 清单、悬空 STREAM-INF。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaster, detectPlaylistType } from '../src/m3u8-parser.js';

test('SESSION-KEY：会话级密钥解析（URI 相对解析 + IV 十六进制）', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-SESSION-KEY:METHOD=AES-128,URI="session.key",IV=0x000102030405060708090a0b0c0d0e0f
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42E01E"
lo.m3u8`, 'https://cdn.example.com/vod/master.m3u8');
  assert.equal(m.sessionKeys.length, 1);
  const k = m.sessionKeys[0];
  assert.equal(k.method, 'AES-128');
  assert.equal(k.uri, 'https://cdn.example.com/vod/session.key');
  assert.deepEqual(Array.from(k.iv.bytes.slice(0, 3)), [0x00, 0x01, 0x02]);
  assert.equal(k.keyFormat, null);
});

test('SESSION-KEY：METHOD=NONE 也登记（占位语义，无 URI/IV）', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-SESSION-KEY:METHOD=NONE
#EXT-X-STREAM-INF:BANDWIDTH=800000
a.m3u8`, '');
  assert.equal(m.sessionKeys.length, 1);
  assert.equal(m.sessionKeys[0].method, 'NONE');
  assert.equal(m.sessionKeys[0].uri, null);
  assert.equal(m.sessionKeys[0].iv, null);
});

test('AVERAGE-BANDWIDTH / VIDEO-RANGE / FRAME-RATE 缺省归零与透传', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720,VIDEO-RANGE=SDR,CODECS="avc1.64001f"
hdr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.42E00A"
lo.m3u8`, '');
  const top = m.levels[0];
  // 已修复：m3u8-parser 此前误读 attrs.AVERAGE_BANDWIDTH（下划线），属性行键为
  // AVERAGE-BANDWIDTH（连字符），导致 averageBandwidth 恒为 0（第八十七波修复）。
  assert.equal(top.averageBandwidth, 1800000, 'AVERAGE-BANDWIDTH 应被正确解析');
  assert.equal(top.videoRange, 'SDR');
  assert.equal(top.frameRate, 0, '未声明 FRAME-RATE 归零');
  assert.equal(m.levels[1].averageBandwidth, 0, '未声明 AVERAGE-BANDWIDTH 归零');
  assert.equal(m.levels[1].videoRange, null);
});

test('label 优先级：NAME > 分辨率高度 > 空串', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,NAME="超清"
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
b.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000
c.m3u8`, '');
  assert.equal(m.levels[0].label, '超清', 'NAME 优先');
  assert.equal(m.levels[1].label, '720p', '次优取分辨率高度');
  assert.equal(m.levels[2].label, '', '两者皆无为空串');
});

test('RESOLUTION 大写 X 与非法值容错', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640X360
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=widescreen
b.m3u8`, '');
  // levels 按带宽降序：BANDWIDTH=2（widescreen）在前，BANDWIDTH=1（640X360）在后
  assert.deepEqual(m.levels[1].resolution, { width: 640, height: 360 });
  assert.equal(m.levels[0].resolution, null, '非法 RESOLUTION 解析为 null');
});

test('detectPlaylistType：I-FRAME-STREAM-INF 判 master；TARGETDURATION 判 media；缺省容错 media', () => {
  assert.equal(
    detectPlaylistType('#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=60000,URI="i.m3u8"'),
    'master'
  );
  assert.equal(detectPlaylistType('#EXTM3U\n#EXT-X-TARGETDURATION:4\n'), 'media');
  assert.equal(detectPlaylistType('#EXTM3U\n'), 'media');
});

test('CLOSED-CAPTIONS Rendition 不进 audio/subtitle 列表', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="EN"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="FR"
#EXT-X-STREAM-INF:BANDWIDTH=1
a.m3u8`, '');
  assert.equal(m.audioTracks.length, 2);
  assert.equal(m.subtitleTracks.length, 0);
  assert.equal(m.audioTracks[0].groupId, 'aud1');
  assert.equal(m.audioTracks[1].groupId, 'aud2');
});

test('纯 Rendition 清单（无 STREAM-INF）不抛错，levels 为空', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="EN",URI="audio/en.m3u8"`, 'https://x/m.m3u8');
  assert.equal(m.levels.length, 0);
  assert.equal(m.audioTracks.length, 1);
  assert.equal(m.audioTracks[0].url, 'https://x/audio/en.m3u8');
});

test('悬空 STREAM-INF（无 URI 行）被忽略，不产出幽灵 level', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1
#EXT-X-STREAM-INF:BANDWIDTH=2
real.m3u8`, '');
  assert.equal(m.levels.length, 1, '首个无 URI 的 STREAM-INF 不得占用 level');
  assert.equal(m.levels[0].bandwidth, 2);
});

test('无 URI 的纯音频 Rendition：url 为 null 而非空串', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="ZH"
#EXT-X-STREAM-INF:BANDWIDTH=1
a.m3u8`, '');
  assert.equal(m.subtitleTracks[0].url, null);
});
