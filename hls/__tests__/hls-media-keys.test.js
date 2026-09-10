/**
 * MEDIA 播放列表加密与标志深水区单测（第二十五波）
 * 覆盖：SAMPLE-AES、无 IV 缺省推导、EXTINF 之间改 KEY、EXT-X-GAP、
 * DISCONTINUITY-SEQUENCE 初值、MAP BYTERANGE、EVENT/lowercase 类型、EXTINF 标题、带 query 的 base。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia } from '../src/m3u8-parser.js';

test('SAMPLE-AES：method 保留 + KEYFORMAT/KEYFORMATVERSIONS + URI 相对解析', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key/decr.key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXTINF:6.0,
a.m4s
#EXT-X-ENDLIST`, 'https://cdn.example.com/fairplay/media.m3u8');
  const k = p.segments[0].key;
  assert.equal(k.method, 'SAMPLE-AES');
  assert.equal(k.uri, 'https://cdn.example.com/fairplay/key/decr.key');
  assert.equal(k.keyFormat, 'com.apple.streamingkeydelivery');
  assert.equal(k.keyFormatVersions, '1');
  assert.equal(k.iv, null, '无 IV 属性时为 null（上层按媒体序号推导）');
});

test('KEY 位于 EXTINF 与 URI 之间：归当前分片而非下一分片', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="k1.key",IV=0x00000000000000000000000000000001
#EXTINF:4.0,
plain.ts
#EXTINF:4.0,
#EXT-X-KEY:METHOD=AES-128,URI="k2.key",IV=0x00000000000000000000000000000002
mid.ts
#EXTINF:4.0,
after.ts
#EXT-X-ENDLIST`, 'https://x/m.m3u8');
  assert.equal(p.segments[0].key.uri, 'https://x/k1.key', '首片继承声明期 KEY');
  assert.equal(p.segments[1].key.uri, 'https://x/k2.key', 'EXTINF 后改 KEY 归当前分片');
  assert.equal(p.segments[2].key.uri, 'https://x/k2.key', 'KEY 持续生效直到下次变更');
});

test('EXT-X-GAP：标记归属分片且不粘连后续分片', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-GAP
#EXTINF:4.0,
lost.ts
#EXTINF:4.0,
ok.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.segments[0].gap, true);
  assert.equal(p.segments[1].gap, false, 'GAP 只作用于紧随的一个分片');
});

test('EXT-X-DISCONTINUITY-SEQUENCE：初值即连续性编号基准', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-DISCONTINUITY-SEQUENCE:7
#EXTINF:4.0,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.discontinuitySequence, 7);
  assert.equal(p.segments[0].cc, 7);
  assert.equal(p.segments[1].cc, 8, '真实断点在初值上 +1');
});

test('EXT-X-MAP 带 BYTERANGE 属性', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4",BYTERANGE=1200@0
#EXTINF:4.0,
a.m4s
#EXT-X-ENDLIST`, 'https://x/m.m3u8');
  assert.deepEqual(p.segments[0].map.byteRange, { length: 1200, offset: 0 });
  assert.equal(p.segments[0].map.uri, 'https://x/init.mp4');
});

test('PLAYLIST-TYPE:EVENT 无 ENDLIST 仍判 live；小写 vod 归一化为 VOD', () => {
  const EVENT = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:4.0,
a.ts`, '');
  assert.equal(EVENT.playlistType, 'EVENT');
  assert.equal(EVENT.live, true, 'EVENT 未结束仍为直播');

  const vod = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:vod
#EXTINF:4.0,
a.ts`, '');
  assert.equal(vod.playlistType, 'VOD', '小写应归一化');
  assert.equal(vod.live, false, 'VOD 即便无 ENDLIST 也不是直播');
});

test('EXTINF 标题（逗号后内容）保留', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,the first episode
a.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.segments[0].duration, 4);
  assert.equal(p.segments[0].title, 'the first episode');
});

test('base 带 query：相对分片解析丢弃 query、保留路径层级', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg1.ts
#EXT-X-ENDLIST`, 'https://cdn.example.com/live/index.m3u8?token=abc&exp=1');
  assert.equal(
    p.segments[0].url,
    'https://cdn.example.com/live/seg1.ts',
    'URL 规范：相对解析基于路径，query 不继承'
  );
});

test('零分片清单（纯头标签）不抛错，totalDuration 为 0', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-ENDLIST`, '');
  assert.equal(p.segments.length, 0);
  assert.equal(p.totalDuration, 0);
  assert.equal(p.live, false, '有 ENDLIST 判 VOD');
});

test('EXTINF 非法时长（非数字）解析期报错而非 NaN 静默入列', () => {
  assert.throws(
    () => parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:NaN,
a.ts
#EXT-X-ENDLIST`, ''),
    (e) => e.code === 'PARSE_ERROR' && /缺少 #EXTINF/.test(e.message)
  );
});
