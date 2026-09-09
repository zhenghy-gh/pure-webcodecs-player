/**
 * samples/fixtures/__tests__/flv.test.js —— makeFLV 结构合法性验证。
 * 含 FLV Tag 链遍历的最小参考实现，供 flv 模块作者对照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFLV, buildAvcC } from '../index.js';

/** 解析全部 Tag（含 PreviousTagSize 校验），返回 {type,timestamp,payload} 数组 */
function parseTags(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = [];
  let off = 9; // 跳过 header
  let prevSize = dv.getUint32(off); off += 4;
  assert.equal(prevSize, 0, 'PreviousTagSize0 应为 0');
  while (off < bytes.length) {
    const type = bytes[off];
    const dataSize = (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const tsLow = (bytes[off + 4] << 16) | (bytes[off + 5] << 8) | bytes[off + 6];
    const tsExt = bytes[off + 7];
    const streamId = (bytes[off + 8] << 16) | (bytes[off + 9] << 8) | bytes[off + 10];
    assert.equal(streamId, 0, 'StreamID 恒为 0');
    const payload = bytes.subarray(off + 11, off + 11 + dataSize);
    off += 11 + dataSize;
    prevSize = dv.getUint32(off); off += 4;
    assert.equal(prevSize, 11 + dataSize, 'PreviousTagSize 必须等于 11+DataSize');
    tags.push({ type, timestamp: tsExt * 0x1000000 + tsLow, payload });
  }
  assert.equal(off, bytes.length, 'Tag 链应精确消费到文件尾');
  return tags;
}

function asciiOf(bytes) {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

test('header 标志位与音视频轨声明一致', () => {
  const vOnly = makeFLV({ frameCount: 2 });
  assert.deepEqual(Array.from(vOnly.bytes.subarray(0, 3)), [0x46, 0x4c, 0x56]); // 'FLV'
  assert.equal(vOnly.bytes[3], 1);
  assert.equal(vOnly.bytes[4] & 0x01, 0x01);
  assert.equal(vOnly.bytes[4] & 0x04, 0);

  const both = makeFLV({ hasAudio: true, hasVideo: true });
  assert.equal(both.bytes[4], 0x05);
});

test('默认输出：SCRIPT 元数据 + AVC sequence header + 帧序列，长度链自洽', () => {
  const { bytes, meta } = makeFLV();
  const tags = parseTags(bytes);

  assert.equal(tags[0].type, 18, '第一个 Tag 是 SCRIPT(onMetaData)');
  const scriptText = asciiOf(tags[0].payload.subarray(0, 30));
  assert.ok(scriptText.includes('@setDataFrame'), 'AMF 应以 @setDataFrame 开头');
  assert.ok(scriptText.includes('onMetaData'));
  // ECMAArray 中应出现 width 键与值
  assert.ok(asciiOf(tags[0].payload).includes('width'));

  assert.equal(tags[1].type, 9, '第二个 Tag 是 AVC sequence header');
  assert.equal(tags[1].payload[0], 0x17, 'keyframe|AVC');
  assert.equal(tags[1].payload[1], 0x00, 'AVCPacketType=0(序列头)');
  const avcCCopy = buildAvcC();
  const inPayload = tags[1].payload.subarray(5, 5 + avcCCopy.length);
  assert.deepEqual(Array.from(inPayload), Array.from(avcCCopy));

  const frames = tags.filter((t) => t.type === 9 && t.payload[1] === 0x01);
  assert.equal(frames.length, meta.frameCount);
  assert.equal(frames[0].payload[0], 0x17, '首帧为关键帧');
  for (let i = 1; i < frames.length; i++) {
    assert.equal(frames[i].payload[0], 0x27, '后续帧为帧间帧');
  }
});

test('时间戳单调且步进正确（25fps → 40ms）', () => {
  const { meta } = makeFLV({ frameCount: 6 });
  const { bytes } = makeFLV({ frameCount: 6 });
  const frames = parseTags(bytes).filter((t) => t.type === 9 && t.payload[1] === 0x01);
  frames.forEach((f, i) => {
    assert.equal(f.timestamp, i * meta.frameDurationMs);
    if (i > 0) assert.ok(f.timestamp >= frames[i - 1].timestamp);
  });
  assert.equal(meta.frameDurationMs, 40);
});

test('hasAudio：出现 AAC sequence header 与 raw 帧', () => {
  const { bytes } = makeFLV({ hasAudio: true, frameCount: 4 });
  const tags = parseTags(bytes);
  const audioTags = tags.filter((t) => t.type === 8);
  assert.ok(audioTags.length >= 2, '应有 AAC 序列头 + 至少一帧 raw');
  assert.equal(audioTags[0].payload[0], 0xaf, 'soundFormat=AAC/rate44k/16bit/stereo');
  assert.equal(audioTags[0].payload[1], 0x00, 'AACPacketType=0(序列头)');
  assert.equal(audioTags[1].payload[1], 0x01, 'AACPacketType=1(raw)');
});
