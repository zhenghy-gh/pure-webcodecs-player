/**
 * samples/fixtures/__tests__/audio.test.js —— makeWAV / makeFLACHeader 验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWAV, makeFLACHeader, parseStreamInfo } from '../index.js';

test('WAV：RIFF 尺寸链自洽，chunk 可顺序走通', () => {
  const { bytes, meta } = makeWAV({ sampleRate: 8000, channels: 1, durationSec: 0.05 });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

  assert.equal(tag(0), 'RIFF');
  assert.equal(dv.getUint32(4, true), bytes.length - 8, 'RIFF size = 文件长 - 8');
  assert.equal(tag(8), 'WAVE');

  // fmt 块
  assert.equal(tag(12), 'fmt ');
  assert.equal(dv.getUint32(16, true), 16); // PCM fmt 长度
  assert.equal(bytes[20] | (bytes[21] << 8), 1); // PCM
  const channels = bytes[22] | (bytes[23] << 8);
  const sampleRate = dv.getUint32(24, true);
  const byteRate = dv.getUint32(28, true);
  const blockAlign = bytes[32] | (bytes[33] << 8);
  const bitsPerSample = bytes[34] | (bytes[35] << 8);
  assert.equal(channels, meta.channels);
  assert.equal(sampleRate, meta.sampleRate);
  assert.equal(byteRate, sampleRate * blockAlign, 'byteRate = rate × blockAlign');
  assert.equal(bitsPerSample, 16);

  // data 块
  const dataOff = 36;
  assert.equal(tag(dataOff), 'data');
  const dataLen = dv.getUint32(dataOff + 4, true);
  assert.equal(dataLen, meta.numSamples * meta.blockAlign);
  assert.equal(dataOff + 8 + dataLen, bytes.length, 'data 块应精确到文件尾');

  // 首个采样是 sin(0)=0，第二个采样应为正
  const firstSample = dv.getInt16(meta.dataChunkOffset, true);
  assert.equal(firstSample, 0);
});

test('WAV：自定义参数（立体声 44.1k）同样自洽', () => {
  const { bytes, meta } = makeWAV({ sampleRate: 44100, channels: 2, durationSec: 0.01, frequency: 1000 });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(meta.numSamples, 441); // round(44100 * 0.01)
  const riffSize = dv.getUint32(4, true);
  assert.equal(riffSize, bytes.length - 8);
  assert.equal(meta.channels, 2);
});

test('FLAC：fLaC 魔数 + STREAMINFO(last-block) 位打包回读一致', () => {
  const { bytes, meta } = makeFLACHeader({ sampleRate: 48000, channels: 2, bitsPerSample: 24, totalSamples: 123456789 });
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  assert.equal(magic, 'fLaC');

  // 元数据块头：last-flag(1)+type(7)=0x80|0；长度 u24 = 34
  assert.equal(bytes[4], 0x80, 'STREAMINFO 且为最后一块');
  assert.deepEqual(Array.from(bytes.subarray(5, 8)), [0, 0, 34]);
  assert.equal(bytes.length, 4 + 4 + 34);

  const parsed = parseStreamInfo(bytes.subarray(8));
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.bitsPerSample, 24);
  assert.equal(parsed.totalSamples, 123456789);
  assert.equal(parsed.minBlockSize, 4096);
});
