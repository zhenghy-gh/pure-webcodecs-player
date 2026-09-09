/**
 * samples/fixtures/__tests__/text.test.js —— m3u8 与 ASS/SRT/VTT 常量的语法要素检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_M3U8_MEDIA, SAMPLE_M3U8_MASTER, SAMPLE_M3U8_LIVE, makeMediaPlaylist,
  SAMPLE_SRT, SAMPLE_VTT, SAMPLE_ASS,
} from '../index.js';

test('媒体播放列表（VOD）：EXTINF 数量与分片一致且带 ENDLIST', () => {
  const lines = SAMPLE_M3U8_MEDIA.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines.includes('#EXT-X-ENDLIST'));
  const extinfs = lines.filter((l) => l.startsWith('#EXTINF:'));
  const segments = lines.filter((l) => l.endsWith('.ts'));
  assert.equal(extinfs.length, 3);
  assert.equal(segments.length, extinfs.length, '每个 EXTINF 后应跟一个分片 URI');
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:4'));
});

test('主播放列表：两档 STREAM-INF 且引用子播放列表', () => {
  const lines = SAMPLE_M3U8_MASTER.split('\n');
  const streamInfs = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  assert.equal(streamInfs.length, 2);
  const uris = ['low/index.m3u8', 'high/index.m3u8'];
  for (const uri of uris) assert.ok(lines.includes(uri));
  // 每条 STREAM-INF 的下一行应是分片播放列表 URI
  streamInfs.forEach((si) => {
    const idx = lines.indexOf(si);
    assert.ok(lines[idx + 1].endsWith('.m3u8') && !lines[idx + 1].startsWith('#'), 'STREAM-INF 下一行应为 URI');
  });
  assert.ok(lines.some((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')), '应声明音轨组');
});

test('直播窗口：无 ENDLIST、MEDIA-SEQUENCE 非零、含 DISCONTINUITY', () => {
  const lines = SAMPLE_M3U8_LIVE.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(!lines.includes('#EXT-X-ENDLIST'));
  assert.ok(lines.includes('#EXT-X-MEDIA-SEQUENCE:2680'));
  assert.equal(lines.filter((l) => l === '#EXT-X-DISCONTINUITY').length, 1);
});

test('makeMediaPlaylist 工厂：参数生效（数量/时长/live）', () => {
  const vod = makeMediaPlaylist({ segments: 5, durationSec: 9 });
  assert.equal(vod.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 5);
  assert.ok(vod.includes('#EXT-X-TARGETDURATION:9'));
  assert.ok(vod.includes('#EXT-X-ENDLIST'));

  const live = makeMediaPlaylist({ segments: 2, live: true });
  assert.ok(!live.includes('#EXT-X-ENDLIST'));

  const seq = makeMediaPlaylist({ mediaSequence: 42 });
  assert.ok(seq.includes('#EXT-X-MEDIA-SEQUENCE:42'));
});

/* ---------------- 字幕 ---------------- */

const SRT_TIME = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;

test('SRT：两条 cue，时间轴格式合法，含中文多行文本', () => {
  const blocks = SAMPLE_SRT.trim().split(/\n\n+/);
  assert.equal(blocks.length, 2);
  const [, timeLine] = blocks[0].split('\n');
  assert.ok(SRT_TIME.test(timeLine), `SRT 时间轴应形如 00:00:01,000 --> ...：${timeLine}`);
  assert.ok(blocks[1].split('\n').length >= 3, '第 2 条 cue 应含两行文本');
  assert.ok(SAMPLE_SRT.includes('中文标点'));
});

test('WebVTT：WEBVTT 头、NOTE、cue 标识与定位设置齐全', () => {
  assert.ok(SAMPLE_VTT.startsWith('WEBVTT'));
  assert.ok(SAMPLE_VTT.includes('NOTE '));
  // VTT 时间轴用点分隔毫秒
  assert.ok(/\d{2}:\d{2}\.\d{3} --> /.test(SAMPLE_VTT));
  assert.ok(SAMPLE_VTT.includes('line:80% align:center'));
  assert.ok(SAMPLE_VTT.includes('<b>'), '支持内联标签');
});

test('ASS：三大段齐全，Style 行字段数与 Format 一致，Dialogue 可数', () => {
  assert.ok(SAMPLE_ASS.includes('[Script Info]'));
  assert.ok(SAMPLE_ASS.includes('[V4+ Styles]'));
  assert.ok(SAMPLE_ASS.includes('[Events]'));

  const styleSection = SAMPLE_ASS.split('[V4+ Styles]')[1].split('[Events]')[0];
  const [formatLine, styleLine] = styleSection.trim().split('\n').filter((l) => !l.startsWith('[')).slice(0, 2);
  const fmtCount = formatLine.replace('Format:', '').split(',').length;
  const styleCount = styleLine.replace('Style:', '').split(',').length;
  assert.equal(fmtCount, styleCount, `Style 字段数(${styleCount})必须等于 Format 定义数(${fmtCount})`);
  assert.ok(styleLine.includes('思源黑体'));

  const dialogues = SAMPLE_ASS.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 2);
  // ASS 时间轴：H:MM:SS.CC（厘秒）
  assert.ok(/0:00:01\.00,0:00:03\.50/.test(dialogues[0]));
  assert.ok(dialogues[0].includes('{\\i1}'), '包含覆写标签');
});
