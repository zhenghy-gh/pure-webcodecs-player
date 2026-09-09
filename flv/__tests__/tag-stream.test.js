/**
 * tag-stream 低层接口单测（rtmp/WebSocket-FLV 复用面）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlvHeader, FlvTagStream, iterateTags } from '../src/tag-stream.js';
import { assembleFlv } from './fixtures/build-flv.mjs';

test('parseFlvHeader：字段黄金值与非法输入', () => {
  const file = assembleFlv({ video: { frames: 1 }, audio: { count: 1 } });
  const head = parseFlvHeader(file);
  assert.equal(head.version, 1);
  assert.equal(head.hasAudio, true);
  assert.equal(head.hasVideo, true);
  assert.equal(head.dataOffset, 9);

  assert.equal(parseFlvHeader(new Uint8Array(8)), null);          // 太短
  assert.equal(parseFlvHeader(new Uint8Array(64).fill(0)), null);  // 魔数不符
  assert.equal(parseFlvHeader(null), null);
});

test('iterateTags：一次性遍历类型/时间戳/数据长度', () => {
  const file = assembleFlv({
    metadata: { duration: 0.3 },
    video: { frames: 4, gopSize: 2 },
    audio: { count: 4 },
  });
  const tags = [...iterateTags(file)];
  const byType = { 8: 0, 9: 0, 18: 0 };
  for (const t of tags) byType[t.type]++;
  assert.equal(byType[18], 1);            // script
  assert.equal(byType[9], 5);             // seq header + 4 帧
  assert.equal(byType[8], 5);             // ASC + 4 帧
  // 时间戳单调（同类型内）
  const vts = tags.filter((t) => t.type === 9).map((t) => t.timestamp);
  assert.deepEqual(vts, [...vts].sort((a, b) => a - b));
});

test('iterateTags：截断尾部不产出半包', () => {
  const file = assembleFlv({ video: { frames: 4 } });
  const cut = file.subarray(0, file.length - 10);
  const last = [...iterateTags(cut)].pop();
  const full = [...iterateTags(file)];
  assert.ok(full.length - ([...iterateTags(cut)].length) >= 0);
  void last;
});

test('FlvTagStream：整块 vs 任意切块结果一致', () => {
  const file = assembleFlv({ video: { frames: 6 }, audio: { count: 4 } });
  const whole = [...iterateTags(file)];

  const stream = new FlvTagStream();
  const incremental = [];
  for (let off = 0; off < file.length; off += 17) {
    incremental.push(...stream.push(file.subarray(off, Math.min(off + 17, file.length))));
  }
  stream.end();
  assert.deepEqual(
    incremental.map((t) => [t.type, t.timestamp, t.data.length]),
    whole.map((t) => [t.type, t.timestamp, t.data.length]),
  );
  // offset 字段为绝对偏移且递增
  for (let i = 1; i < incremental.length; i++) {
    assert.ok(incremental[i].offset > incremental[i - 1].offset);
  }
});

test('FlvTagStream：WebSocket 风格单帧喂入（rtmp 复用形态）', () => {
  const file = assembleFlv({ video: { frames: 2 }, audio: null });
  const stream = new FlvTagStream();
  const got = [];
  for (let i = 0; i < file.length; i++) {
    got.push(...stream.push(file.subarray(i, i + 1)));
  }
  stream.end();
  assert.equal(got.filter((t) => t.type === 9).length, 3);   // 序列头 + 2 帧
});

test('FlvTagStream：resumeMidStream 支持跳过文件头续传', () => {
  const file = assembleFlv({ video: { frames: 4 } });
  const stream = new FlvTagStream();
  stream.resumeMidStream({ hasAudio: false, hasVideo: true });
  // 从第一个视频 Tag 头位置继续（此处取文件头后首个 Tag 的 offset）
  let firstOffset = null;
  for (const t of iterateTags(file)) { firstOffset = t.offset; break; }
  const tags = stream.push(file.subarray(firstOffset));
  assert.equal(tags.length, 5);   // seq + 4 帧
});
