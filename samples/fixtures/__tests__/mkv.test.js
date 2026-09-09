/**
 * samples/fixtures/__tests__/mkv.test.js —— makeMKV 结构合法性验证。
 * 含 EBML 元素遍历器（ID/尺寸 VINT 解码）最小参考实现，供 mkv 模块作者对照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMKV, ebmlSize } from '../index.js';

/** 读取 EBML 尺寸 VINT，返回 {value, len}（剥离长度前导位后的数值） */
function readVint(bytes, pos) {
  const first = bytes[pos];
  assert.notEqual(first, undefined, `偏移 ${pos} 越界`);
  let len = 1;
  for (let mask = 0x80; len <= 8; len++, mask >>= 1) {
    if (first & mask) break;
  }
  let value = first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + bytes[pos + i];
  return { value, len };
}

/** 读取元素 ID（保留前导标记位——EBML 的 ID 值包含这些位） */
function readId(bytes, pos) {
  const first = bytes[pos];
  let len = 1;
  for (let mask = 0x80; len <= 8; len++, mask >>= 1) {
    if (first & mask) break;
  }
  let value = first;
  for (let i = 1; i < len; i++) value = value * 256 + bytes[pos + i];
  return { value, len };
}

/** 遍历 [start,end) 内的兄弟元素，校验尺寸自洽 */
export function* iterElements(bytes, start = 0, end = bytes.length) {
  let off = start;
  while (off < end) {
    const id = readId(bytes, off);
    const size = readVint(bytes, off + id.len);
    const contentStart = off + id.len + size.len;
    const contentEnd = contentStart + Number(size.value);
    assert.ok(contentEnd <= end, `元素越界: id=0x${id.value.toString(16)} 偏移=${off}`);
    yield { id: id.value, idLen: id.len, contentStart, contentEnd };
    off = contentEnd;
  }
  assert.equal(off, end, '兄弟元素应精确消费到边界');
}

function child(bytes, start, end, id) {
  const hits = [...iterElements(bytes, start, end)].filter((e) => e.id === id);
  assert.equal(hits.length, 1, `期望恰好一个 ID=0x${id.toString(16)}`);
  return hits[0];
}

function uintAt(bytes, e) {
  let v = 0;
  for (let i = e.contentStart; i < e.contentEnd; i++) v = v * 256 + bytes[i];
  return v;
}

function strAt(bytes, e) {
  return new TextDecoder().decode(bytes.subarray(e.contentStart, e.contentEnd));
}

test('EBML 头：DocType=matroska，版本字段正确', () => {
  const { bytes } = makeMKV();
  const header = child(bytes, 0, bytes.length, 0x1a45dfa3);
  assert.equal(uintAt(bytes, child(bytes, header.contentStart, header.contentEnd, 0x4286)), 1); // EBMLVersion
  assert.equal(strAt(bytes, child(bytes, header.contentStart, header.contentEnd, 0x4282)), 'matroska');
  assert.equal(uintAt(bytes, child(bytes, header.contentStart, header.contentEnd, 0x4287)), 4); // DocTypeVersion
});

test('Segment 三大子件 Info/Tracks/Cluster 齐全且字段可回读', () => {
  const { bytes, meta } = makeMKV({ width: 640, height: 360, durationMs: 5000 });
  const header = child(bytes, 0, bytes.length, 0x1a45dfa3);
  const segment = child(bytes, header.contentEnd, bytes.length, 0x18538067);

  // Info：TimecodeScale=1ms、Duration(f64)、应用名
  const info = child(bytes, segment.contentStart, segment.contentEnd, 0x1549a966);
  assert.equal(uintAt(bytes, child(bytes, info.contentStart, info.contentEnd, 0x2ad7b1)), 1000000);
  const durationEl = child(bytes, info.contentStart, info.contentEnd, 0x4489);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getFloat64(durationEl.contentStart), 5000);

  // Tracks → TrackEntry
  const tracks = child(bytes, segment.contentStart, segment.contentEnd, 0x1654ae6b);
  const entry = child(bytes, tracks.contentStart, tracks.contentEnd, 0xae);
  assert.equal(uintAt(bytes, child(bytes, entry.contentStart, entry.contentEnd, 0xd7)), meta.trackNumber); // TrackNumber
  assert.equal(uintAt(bytes, child(bytes, entry.contentStart, entry.contentEnd, 0x83)), 1); // video
  assert.equal(strAt(bytes, child(bytes, entry.contentStart, entry.contentEnd, 0x86)), meta.codecId);

  // Video 子件宽高
  const video = child(bytes, entry.contentStart, entry.contentEnd, 0xe0);
  assert.equal(uintAt(bytes, child(bytes, video.contentStart, video.contentEnd, 0xb0)), 640);
  assert.equal(uintAt(bytes, child(bytes, video.contentStart, video.contentEnd, 0xba)), 360);
});

test('SimpleBlock 头部与关键帧标志正确', () => {
  const { bytes } = makeMKV();
  const header = child(bytes, 0, bytes.length, 0x1a45dfa3);
  const segment = child(bytes, header.contentEnd, bytes.length, 0x18538067);
  const cluster = child(bytes, segment.contentStart, segment.contentEnd, 0x1f43b675);
  assert.equal(uintAt(bytes, child(bytes, cluster.contentStart, cluster.contentEnd, 0xe7)), 0);

  const blocks = [...iterElements(bytes, cluster.contentStart, cluster.contentEnd)]
    .filter((e) => e.id === 0xa3);
  assert.equal(blocks.length, 2);

  const [b0, b1] = blocks;
  assert.equal(bytes[b0.contentStart], 0x81, 'TrackNumber 的 VINT 应为 0x81');
  const tc0 = (bytes[b0.contentStart + 1] << 8) | bytes[b0.contentStart + 2];
  assert.equal(tc0 << 16 >> 16, 0, '相对时间码为有符号 16bit');
  assert.equal(bytes[b0.contentStart + 3] & 0x80, 0x80, '第 1 块应为关键帧');

  const tc1 = (bytes[b1.contentStart + 1] << 8) | bytes[b1.contentStart + 2];
  assert.equal(tc1 << 16 >> 16, 1000);
  assert.equal(bytes[b1.contentStart + 3], 0x00, '第 2 块非关键帧');
});

test('ebmlSize 最短编码与已知值一致', () => {
  assert.deepEqual(Array.from(ebmlSize(0)), [0x80]);
  assert.deepEqual(Array.from(ebmlSize(126)), [0xfe]); // 单字节 VINT 上限 126（127 为保留）
  assert.deepEqual(Array.from(ebmlSize(127)), [0x40, 0x7f]); // 进入两字节域
  assert.deepEqual(Array.from(ebmlSize(300)), [0x41, 0x2c]);
  assert.deepEqual(Array.from(ebmlSize(16382)), [0x7f, 0xfe]); // 两字节上限减一（全 1 是保留型）
});
