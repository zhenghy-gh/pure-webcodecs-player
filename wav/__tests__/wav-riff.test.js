/**
 * wav/__tests__/wav-riff.test.js — RIFF/WAVE 容器头校验与坏魔术拒绝
 * 纯字节解析、零网络零浏览器依赖；fixture 全部程序化生成。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWavHeader, WavDemuxer, ErrorCode, WAVE_FORMAT } from '../src/index.js';

/* ---------------- fixture 构造 ---------------- */

function putFourCC(dv, off, id) { for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i)); }
function putChunk(dv, off, id, size) { putFourCC(dv, off, id); dv.setUint32(off + 4, size, true); }

/** 构造最小合法 WAV（PCM s16 单声道） */
function buildWav(opt = {}) {
  const channels = opt.channels ?? 1;
  const sampleRate = opt.sampleRate ?? 8000;
  const bits = opt.bitsPerSample ?? 16;
  const bytesPerSample = bits >> 3;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const frames = opt.frames ?? 4;
  const dataBytes = frames * blockAlign;

  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, WAVE_FORMAT.PCM, true);
  fv.setUint16(2, channels, true);
  fv.setUint32(4, sampleRate, true);
  fv.setUint32(8, byteRate, true);
  fv.setUint16(12, blockAlign, true);
  fv.setUint16(14, bits, true);

  const total = 12 + (8 + 16) + (8 + dataBytes);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  putChunk(dv, 0, 'RIFF', total - 8);
  putFourCC(dv, 8, 'WAVE');
  putChunk(dv, 12, 'fmt ', 16); u8.set(fmt, 20);
  putChunk(dv, 36, 'data', dataBytes);
  return new Uint8Array(buf);
}

/** 手工拼装任意头（用于坏魔术/缺 WAVE 场景） */
function makeHeader({ riff = 'RIFF', form = 'WAVE', size = 4 } = {}) {
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf);
  putFourCC(dv, 0, riff);
  dv.setUint32(4, size, true);
  putFourCC(dv, 8, form);
  return new Uint8Array(buf);
}

/* ---------------- 测试用例 ---------------- */

describe('RIFF/WAVE 头校验', () => {
  test('最小合法头可解析且 codec=pcm-s16', () => {
    const h = parseWavHeader(buildWav({ channels: 1, sampleRate: 8000, frames: 4 }));
    assert.equal(h.format.formatTag, WAVE_FORMAT.PCM);
    assert.equal(h.codec, 'pcm-s16');
    assert.equal(h.dataChunk.size, 8);
  });

  test('头部不足 12 字节 → PARSE_ERROR', () => {
    assert.throws(() => parseWavHeader(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])),
      (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('坏魔数（非 RIFF）→ PARSE_ERROR', () => {
    // 'RIFX' 不是 RIFF
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    putFourCC(dv, 0, 'RIFX'); dv.setUint32(4, 8, true); putFourCC(dv, 8, 'WAVE');
    assert.throws(() => parseWavHeader(buf), (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('RIFF 但形式类型非 WAVE → PARSE_ERROR', () => {
    const buf = makeHeader({ riff: 'RIFF', form: 'AVI ', size: 4 });
    assert.throws(() => parseWavHeader(buf), (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('仅有 RIFF/WAVE 头、无子块 → 缺 fmt PARSE_ERROR', () => {
    const buf = makeHeader({ riff: 'RIFF', form: 'WAVE', size: 4 });
    assert.throws(() => parseWavHeader(buf), (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('WavDemuxer.probe 对坏头返回 null（不抛）', () => {
    assert.equal(WavDemuxer.probe(makeHeader({ riff: 'RIFX' })), null);
    assert.equal(WavDemuxer.probe(new Uint8Array(4)), null);
    assert.equal(WavDemuxer.probe(new Uint8Array(0)), null);
  });

  test('流式哨兵 riffSize=0xFFFFFFFF 仍按实际字节解析', () => {
    const bytes = buildWav({ channels: 1, sampleRate: 8000, frames: 8 });
    new DataView(bytes.buffer).setUint32(4, 0xFFFFFFFF, true);
    const h = parseWavHeader(bytes);
    assert.equal(h.format.channels, 1);
    assert.ok(h.durationUs > 0);
  });

  test('谎报 riffSize（偏小）按实际长度容错解析', () => {
    const bytes = buildWav({ channels: 2, sampleRate: 44100, frames: 10 });
    // 声明尺寸比实际小很多，但字节完整，解析应继续到末尾
    new DataView(bytes.buffer).setUint32(4, 20, true);
    const h = parseWavHeader(bytes);
    assert.equal(h.format.channels, 2);
    assert.equal(h.codec, 'pcm-s16');
  });
});
