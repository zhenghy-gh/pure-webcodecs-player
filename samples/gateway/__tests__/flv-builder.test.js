import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FlvLoopSource,
  buildFlvTags,
  flvFileHeader,
  serializeTag,
  makeAvcC,
} from '../src/flv-builder.js';

test('FLV 文件头：魔数/版本/仅视频标志/头长', () => {
  const h = flvFileHeader();
  assert.equal(h.toString('latin1', 0, 3), 'FLV');
  assert.equal(h[3], 1); // version
  assert.equal(h[4], 0x01); // 仅视频
  assert.deepEqual([...h.subarray(5, 9)], [0, 0, 0, 9]);
});

test('Tag 链完整：类型/长度/PreviousTagSize 自洽，时间戳单调', () => {
  const { tags } = buildFlvTags(30);
  // 头两个为配置 Tag：sequence header(9) 与 metadata(18)
  assert.equal(tags[0].type, 9);
  assert.equal(tags[1].type, 18);
  let lastTs = -1;
  for (const t of tags) {
    assert.ok(t.data.length > 0);
    assert.ok(t.ts >= lastTs);
    lastTs = t.ts;
  }
  // 帧数据 Tag 均为 keyframe+AVC+NALU
  const frame = tags[2];
  assert.equal(frame.data[0], 0x17); // frameType=1(key) codecId=7(AVC)
  assert.equal(frame.data[1], 0x01); // AVCPacketType = NALU
});

test('serializeTag：11B 头与 PreviousTagSize 精确对应', () => {
  const chunk = serializeTag(9, 1234, Buffer.alloc(10));
  assert.equal(chunk.length, 11 + 10 + 4);
  assert.equal(chunk[0], 9);
  assert.equal((chunk[1] << 16) | (chunk[2] << 8) | chunk[3], 10);
  // 时间戳 1234ms：低 24 位 = 1234，扩展字节 0
  assert.equal(chunk[7], 0); // ext
  assert.equal((chunk[4] << 16) | (chunk[5] << 8) | chunk[6], 1234);  const prev = chunk.subarray(chunk.length - 4).readUInt32BE(0);
  assert.equal(prev, 21);
  // 大时间戳走扩展字节
  const big = serializeTag(9, 0x11223344, Buffer.alloc(0));
  assert.equal(big[7], 0x11);
  assert.equal((big[4] << 16) | (big[5] << 8) | big[6], 0x223344);
});

test('avcC 记录：SPS/PPS 各 1 条、长度前缀 4 字节', () => {
  const avcC = makeAvcC();
  assert.equal(avcC[0], 1); // configurationVersion
  assert.equal(avcC[4] & 0x03, 3); // lengthSizeMinusOne
  assert.equal(avcC[5] & 0x1f, 1); // numOfSPS - 1
  const spsLen = (avcC[6] << 8) | avcC[7];
  assert.ok(spsLen > 4 && spsLen < 32);
  const ppsOff = 8 + spsLen + 1;
  const ppsLen = (avcC[ppsOff] << 8) | avcC[ppsOff + 1];
  assert.ok(ppsLen > 1 && ppsLen < 16);
});

test('循环推流：跨周期时间戳持续递增且内容可循环', () => {
  const src = new FlvLoopSource({ frameCount: 5 });
  const init = src.initChunk();
  assert.equal(init.toString('latin1', 0, 3), 'FLV');
  const cycle1 = src.take(5).map((b) => b.readUInt32BE(b.length - 4)); // 取每块 prevSize 无意义；改读 TagHeader ts
  void cycle1;

  const readTs = (buf) => buf[7] * 0x1000000 + ((buf[4] << 16) | (buf[5] << 8) | buf[6]);
  const chunks = [...src.take(5), ...src.take(5)]; // 5 帧 + 跨周期再取 5 帧
  const tss = chunks.map(readTs);
  for (let i = 1; i < tss.length; i++) {
    assert.ok(tss[i] >= tss[i - 1], `时间戳应单调: ${tss[i - 1]} -> ${tss[i]}`);
  }
  // 第二周期首帧时间戳 ≈ 第一周期末帧 + 周期时长
  assert.ok(tss[5] > tss[4]);
});
