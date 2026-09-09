/**
 * codecs.test.js —— Matroska CodecID → 规范 MSE codec 串归一化
 * 重点覆盖 round-1 第八波修复：A_MPEG/L3 / A_VORBIS 产出原生 CodecID（非法 MSE 串）的 bug。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCodec } from '../src/codecs.js';

test('A_MPEG/L3 → 合法 MSE codec 串 mp3（非原生 CodecID）', () => {
  const r = normalizeCodec({ codecId: 'A_MPEG/L3', codecPrivate: null }, {});
  assert.equal(r.family, 'mp3');
  assert.equal(r.supported, true);
  // 修复前此处为 'A_MPEG/L3'，下游 addSourceBuffer 会拿到非法串
  assert.equal(r.codec, 'mp3');
});

test('A_VORBIS → 合法 MSE codec 串 vorbis（非原生 CodecID）', () => {
  const r = normalizeCodec({ codecId: 'A_VORBIS', codecPrivate: null }, {});
  assert.equal(r.family, 'vorbis');
  assert.equal(r.supported, true);
  // 修复前此处为 'A_VORBIS'
  assert.equal(r.codec, 'vorbis');
});

test('相邻音频/视频家族 codec 串不被回归', () => {
  const cases = [
    ['A_AAC', 'mp4a.40.2'], // 缺私有数据降级 LC
    ['A_OPUS', 'opus'],
    ['A_FLAC', 'flac'],
    ['V_MPEG4/ISO/AVC', 'avc1'],
    ['V_MPEGH/ISO/HEVC', 'hev1'],
    ['A_PCM/INT/LIT', 'pcm-s16'],
  ];
  for (const [id, want] of cases) {
    const r = normalizeCodec({ codecId: id, codecPrivate: null }, {});
    assert.equal(r.codec, want, `${id} 应为 ${want}，实得 ${r.codec}`);
  }
});

test('未识别 CodecID → family 取小写、supported=false', () => {
  const r = normalizeCodec({ codecId: 'X_UNKNOWN/ZZ', codecPrivate: null }, {});
  assert.equal(r.family, 'x_unknown/zz');
  assert.equal(r.supported, false);
});
