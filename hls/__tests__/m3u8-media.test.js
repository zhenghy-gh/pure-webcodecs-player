/**
 * MEDIA 播放列表解析单测（VOD / 直播 / 加密 / fMP4 / BYTERANGE）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia, detectPlaylistType, parsePlaylist } from '../src/m3u8-parser.js';

const VOD = `#EXTM3U
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
#EXT-X-ENDLIST`;

test('VOD：基本字段与 live 判定', () => {
  const p = parseMedia(VOD, 'https://cdn.example.com/vod/media.m3u8');
  assert.equal(p.type, 'media');
  assert.equal(p.version, 6);
  assert.equal(p.targetDuration, 6);
  assert.equal(p.playlistType, 'VOD');
  assert.equal(p.hasEndlist, true);
  assert.equal(p.live, false);
  assert.equal(p.segments.length, 4);
  assert.ok(Math.abs(p.totalDuration - (5.76 + 6.008 + 5.984 + 6.0)) < 1e-9);
});

test('VOD：fMP4 init segment（EXT-X-MAP）继承到每个分片', () => {
  const p = parseMedia(VOD, '');
  for (const s of p.segments) {
    assert.ok(s.map, '每个分片应继承 EXT-X-MAP');
    assert.match(s.map.uri, /init\.mp4$/);
  }
});

test('VOD：加密 Key 的解析与 METHOD=NONE 恢复明文', () => {
  const p = parseMedia(VOD, 'https://cdn.example.com/vod/media.m3u8');
  const [s1, s2, s3] = p.segments;
  assert.equal(s1.key, null); // MAP 后、首个 KEY 前为明文
  assert.equal(s2.key.method, 'AES-128');
  assert.equal(
    s2.key.uri,
    'https://cdn.example.com/vod/enc.key',
    'KEY URI 需相对播放列表解析'
  );
  // IV 0x9c... 转成 16 字节大端
  assert.deepEqual(Array.from(s2.key.iv.bytes.slice(0, 4)), [0x9c, 0x7d, 0xb8, 0x77]);
  assert.equal(s3.key, null); // METHOD=NONE 之后恢复明文
});

test('VOD：discontinuity 使连续性编号 +1', () => {
  const p = parseMedia(VOD, '');
  assert.equal(p.segments[2].discontinuity, false);
  assert.equal(p.segments[3].discontinuity, true);
  assert.equal(p.segments[2].cc, 0);
  assert.equal(p.segments[3].cc, 1);
});

test('直播滑动窗口：MEDIA-SEQUENCE 与 sn 计算、live 判定', () => {
  const LIVE = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:2680
#EXTINF:9.0,
l1.ts
#EXTINF:9.0,
l2.ts
#EXTINF:9.375,
l3.ts`;
  const p = parseMedia(LIVE, '');
  assert.equal(p.live, true);
  assert.equal(p.mediaSequence, 2680);
  assert.deepEqual(
    p.segments.map((s) => s.sn),
    [2680, 2681, 2682]
  );
});

test('BYTERANGE：显式 offset 与滚动 offset', () => {
  const BR = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
#EXT-X-BYTERANGE:75232@0
main.mp4
#EXTINF:5.0,
#EXT-X-BYTERANGE:82112
main.mp4
#EXT-X-ENDLIST`;
  const p = parseMedia(BR, '');
  assert.deepEqual(p.segments[0].byteRange, { length: 75232, offset: 0 });
  // 第二个缺省 @offset，应滚动为前一段结束位置 75232
  assert.deepEqual(p.segments[1].byteRange, { length: 82112, offset: 75232 });
});

test('BYTERANGE：首段缺省 offset 属于非法输入，报错而非静默', () => {
  const BAD = `#EXTM3U
#EXTINF:5.0,
#EXT-X-BYTERANGE:1000
a.mp4`;
  assert.throws(() => parseMedia(BAD, ''), /无前序引用/);
});

test('缺少 EXTINF 时长属于非法输入，报错定位分片下标', () => {
  const BAD = `#EXTM3U
#EXTINF:5.0,
ok.ts
bad.ts
#EXT-X-ENDLIST`;
  try {
    parseMedia(BAD, '');
    assert.fail('应当抛出异常');
  } catch (e) {
    assert.match(e.message, /缺少 #EXTINF/);
  }
});

test('PROGRAM-DATE-TIME 解析为 ISO 字符串', () => {
  const PDT = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-PROGRAM-DATE-TIME:2024-01-01T08:00:00.000+00:00
#EXTINF:4.0,
p.ts
#EXT-X-ENDLIST`;
  const p = parseMedia(PDT, '');
  assert.equal(p.segments[0].programDateTime, '2024-01-01T08:00:00.000Z');
});

test('parsePlaylist 自动识别 media 类型', () => {
  assert.equal(detectPlaylistType(VOD), 'media');
  const p = parsePlaylist(VOD, '');
  assert.equal(p.type, 'media');
  assert.ok(p.segments.length > 0);
});
