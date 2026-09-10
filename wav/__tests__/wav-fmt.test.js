/**
 * wav/__tests__/wav-fmt.test.js — fmt chunk 各格式与字段计算/边界
 * 覆盖 PCM 16/24/32、IEEE float、mulaw/alaw 拒绝、extensible（含/不含 cbSize）、
 * channels/sampleRate 边界、blockAlign/byteRate 解析与故意错值容错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWavHeader, waveCodecString, ErrorCode, WAVE_FORMAT } from '../src/index.js';

/* ---------------- fixture 构造 ---------------- */

function putFourCC(dv, off, id) { for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i)); }
function putChunk(dv, off, id, size) { putFourCC(dv, off, id); dv.setUint32(off + 4, size, true); }

/** 灵活构造 WAV，支持 extensible / 多格式 / 错值注入 */
function buildWav(opt = {}) {
  const formatTag = opt.formatTag ?? WAVE_FORMAT.PCM;
  const extensible = opt.extensible ?? false;
  const writtenTag = opt.writtenTag ?? (extensible ? WAVE_FORMAT.EXTENSIBLE : formatTag);
  const channels = opt.channels ?? 1;
  const sampleRate = opt.sampleRate ?? 8000;
  const bits = opt.bitsPerSample ?? (formatTag === WAVE_FORMAT.IEEE_FLOAT ? 32 : 16);
  const bytesPerSample = bits >> 3;
  const blockAlign = channels * bytesPerSample;
  const byteRate = opt.byteRate ?? sampleRate * blockAlign;
  const frames = opt.frames ?? 8;
  const fmtSize = opt.fmtSize ?? (extensible ? 40 : 16);
  const dataBytes = frames * blockAlign;

  const total = 12 + (8 + fmtSize) + (8 + dataBytes);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  putChunk(dv, p, 'RIFF', total - 8); p += 8;
  putFourCC(dv, p, 'WAVE'); p += 4;

  putChunk(dv, p, 'fmt ', fmtSize); p += 8;
  dv.setUint16(p, writtenTag, true); p += 2;
  dv.setUint16(p, channels, true); p += 2;
  dv.setUint32(p, sampleRate, true); p += 4;
  dv.setUint32(p, byteRate, true); p += 4;
  dv.setUint16(p, blockAlign, true); p += 2;
  dv.setUint16(p, bits, true); p += 2;
  if (extensible) {
    dv.setUint16(p, 22, true); p += 2;                 // cbSize
    dv.setUint16(p, opt.validBits ?? bits, true); p += 2;
    dv.setUint32(p, opt.channelMask ?? 0, true); p += 4;
    const sub = opt.subFormat ?? formatTag;
    dv.setUint16(p, sub, true); p += 2;
    const tail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (const b of tail) dv.setUint8(p++, b);
  }

  putChunk(dv, p, 'data', dataBytes); p += 8;
  // 填入可识别模式：帧 i，声道 c → 值 i*100+c
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = i * 100 + c;
      switch (`${formatTag}:${bits}`) {
        case '1:8': u8[p] = 128; p += 1; break;
        case '1:16': dv.setInt16(p, v, true); p += 2; break;
        case '1:24': u8[p] = v & 0xff; u8[p + 1] = (v >> 8) & 0xff; u8[p + 2] = (v >> 16) & 0xff; p += 3; break;
        case '1:32': dv.setInt32(p, v, true); p += 4; break;
        case '3:32': dv.setFloat32(p, v / 32768, true); p += 4; break;
        case '6:8': case '7:8': u8[p] = 0; p += 1; break;
        default: p += bytesPerSample;
      }
    }
  }
  return new Uint8Array(buf);
}

/* ---------------- 各格式 ---------------- */

describe('fmt 各格式解析', () => {
  const cases = [
    [WAVE_FORMAT.PCM, 16, 'pcm-s16'],
    [WAVE_FORMAT.PCM, 24, 'pcm-s24'],
    [WAVE_FORMAT.PCM, 32, 'pcm-s32'],
    [WAVE_FORMAT.IEEE_FLOAT, 32, 'pcm-f32'],
  ];
  for (const [tag, bits, codec] of cases) {
    test(`PCM/IEEE 位深组合 tag=0x${tag.toString(16)} bits=${bits} → ${codec}`, () => {
      const h = parseWavHeader(buildWav({ formatTag: tag, bitsPerSample: bits }));
      assert.equal(h.format.formatTag, tag);
      assert.equal(h.format.bitsPerSample, bits);
      assert.equal(h.codec, codec);
    });
  }

  test('PCM u8 → pcm-u8', () => {
    const h = parseWavHeader(buildWav({ formatTag: WAVE_FORMAT.PCM, bitsPerSample: 8 }));
    assert.equal(h.codec, 'pcm-u8');
    assert.equal(h.format.bitsPerSample, 8);
  });

  test('mulaw(0x0007) 不受支持 → NOT_SUPPORTED', () => {
    assert.throws(() => parseWavHeader(buildWav({ formatTag: WAVE_FORMAT.MULAW, bitsPerSample: 8 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });

  test('alaw(0x0006) 不受支持 → NOT_SUPPORTED', () => {
    assert.throws(() => parseWavHeader(buildWav({ formatTag: WAVE_FORMAT.ALAW, bitsPerSample: 8 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });

  test('未映射位深（PCM 20bit）→ NOT_SUPPORTED', () => {
    assert.throws(() => parseWavHeader(buildWav({ formatTag: WAVE_FORMAT.PCM, bitsPerSample: 20 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });
});

/* ---------------- extensible ---------------- */

describe('WAVE_FORMAT_EXTENSIBLE', () => {
  test('SubFormat GUID=PCM 还原真实格式码', () => {
    const h = parseWavHeader(buildWav({ extensible: true, formatTag: WAVE_FORMAT.PCM, bitsPerSample: 24 }));
    assert.equal(h.format.extensible, true);
    assert.equal(h.format.formatTag, WAVE_FORMAT.PCM);
    assert.equal(h.codec, 'pcm-s24');
    assert.equal(h.format.validBitsPerSample, 24);
  });

  test('SubFormat GUID=IEEE_FLOAT 还原 pcm-f32', () => {
    const h = parseWavHeader(buildWav({ extensible: true, formatTag: WAVE_FORMAT.IEEE_FLOAT, bitsPerSample: 32 }));
    assert.equal(h.format.extensible, true);
    assert.equal(h.format.formatTag, WAVE_FORMAT.IEEE_FLOAT);
    assert.equal(h.codec, 'pcm-f32');
  });

  test('SubFormat GUID=ALAW 仍不可解码 → NOT_SUPPORTED', () => {
    assert.throws(() => parseWavHeader(buildWav({ extensible: true, formatTag: WAVE_FORMAT.ALAW, bitsPerSample: 8 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });

  test('未知 SubFormat GUID(0x0009) → NOT_SUPPORTED', () => {
    assert.throws(() => parseWavHeader(buildWav({ extensible: true, formatTag: 0x0009, bitsPerSample: 16 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });

  test('extensible 但无 cbSize（仅 16 字节、tag=0xfffe）→ NOT_SUPPORTED', () => {
    // 解析器在 codec 映射阶段即抛 NOT_SUPPORTED（formatTag 0xfffe 无法映射）
    assert.throws(() => parseWavHeader(buildWav({ writtenTag: WAVE_FORMAT.EXTENSIBLE, fmtSize: 16,
      formatTag: WAVE_FORMAT.PCM, bitsPerSample: 16, frames: 1 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
    assert.equal(waveCodecString(WAVE_FORMAT.EXTENSIBLE, 16), null);
  });
});

/* ---------------- 字段计算与边界 ---------------- */

describe('blockAlign/byteRate 解析与边界', () => {
  test('多声道 blockAlign/byteRate 精确还原', () => {
    const ch = 6, sr = 48000, bits = 16;
    const h = parseWavHeader(buildWav({ channels: ch, sampleRate: sr, bitsPerSample: bits }));
    assert.equal(h.format.blockAlign, ch * (bits >> 3));
    assert.equal(h.format.byteRate, sr * ch * (bits >> 3));
  });

  test('字节内错值 byteRate 被原样保留（解析器不重算）', () => {
    const h = parseWavHeader(buildWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, byteRate: 123456 }));
    assert.equal(h.format.byteRate, 123456);
  });

  test('声道数边界：1 与 64 合法，0 与 65 → PARSE_ERROR', () => {
    assert.equal(parseWavHeader(buildWav({ channels: 1 })).format.channels, 1);
    assert.equal(parseWavHeader(buildWav({ channels: 64 })).format.channels, 64);
    assert.throws(() => parseWavHeader(buildWav({ channels: 0 })), (e) => e.code === ErrorCode.PARSE_ERROR);
    assert.throws(() => parseWavHeader(buildWav({ channels: 65 })), (e) => e.code === ErrorCode.PARSE_ERROR);
  });

  test('采样率边界：1 与 384000 合法，0 与 384001 → PARSE_ERROR', () => {
    assert.equal(parseWavHeader(buildWav({ sampleRate: 1 })).format.sampleRate, 1);
    assert.equal(parseWavHeader(buildWav({ sampleRate: 384000 })).format.sampleRate, 384000);
    assert.throws(() => parseWavHeader(buildWav({ sampleRate: 0 })), (e) => e.code === ErrorCode.PARSE_ERROR);
    assert.throws(() => parseWavHeader(buildWav({ sampleRate: 384001 })), (e) => e.code === ErrorCode.PARSE_ERROR);
  });
});
