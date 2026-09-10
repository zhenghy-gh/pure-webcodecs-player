/**
 * flv-audio.test.js —— 音频 Tag 位域映射 / AAC 序列头(ASC) / MP3 直通 边界
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvParser } from '../src/flv-parser.js';
import { parseAscInfo } from '../src/codec-info.js';
import { flvHeader, tag } from './fixtures/build-flv.mjs';

function concat(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

/** 带 FLV header 的解析器：tag-stream 必须先见 'FLV' 魔数才开始出 tag */
function mkParser() {
  const p = new FlvParser();
  p.push(flvHeader({ hasAudio: true, hasVideo: false }));
  return p;
}

/** 构造音频 Tag：soundByte 含 format/rate/size/type 四位域 */
function audioTag(soundByte, payload) {
  return tag(8, concat([Uint8Array.from([soundByte]), payload]));
}

function collect(parser) {
  const log = { audio: [], errors: [] };
  parser.on('audio', (a) => log.audio.push(a));
  parser.on('error', (e) => log.errors.push(e));
  return log;
}

/** sound byte = (format<<4)|(rate<<2)|(size<<1)|type */
function soundByte(format, rate, size, type) {
  return ((format & 0x0f) << 4) | ((rate & 0x03) << 2) | ((size & 0x01) << 1) | (type & 0x01);
}

test('音频位域：soundFormat 映射（AAC/MP3/Speex）', () => {
  const p = mkParser();
  const log = collect(p);
  // AAC
  p.push(audioTag(soundByte(10, 3, 1, 1), Uint8Array.from([0x00, 0x01, 9])));
  // MP3
  p.push(audioTag(soundByte(2, 3, 1, 1), Uint8Array.from([0x99])));
  // Speex（format=11）
  p.push(audioTag(soundByte(11, 0, 1, 1), Uint8Array.from([0xaa])));
  p.flush();
  assert.equal(log.audio[0].soundFormat, 'aac');
  assert.equal(log.audio[1].soundFormat, 'mp3');
  assert.equal(log.audio[2].soundFormat, 'speex');
});

test('MP3 位域：采样率/位深/声道 精确还原', () => {
  const cases = [
    { rate: 0, expRate: 5512, size: 0, expBits: 8, type: 0, expCh: 1 },
    { rate: 1, expRate: 11025, size: 1, expBits: 16, type: 1, expCh: 2 },
    { rate: 2, expRate: 22050, size: 0, expBits: 8, type: 0, expCh: 1 },
    { rate: 3, expRate: 44100, size: 1, expBits: 16, type: 1, expCh: 2 },
  ];
  for (const c of cases) {
    const p = mkParser();
    const log = collect(p);
    p.push(audioTag(soundByte(2, c.rate, c.size, c.type), Uint8Array.from([0x11, 0x22])));
    p.flush();
    const h = log.audio[0].hint;
    assert.equal(h.legacyRate, c.expRate, `rate ${c.rate}`);
    assert.equal(h.sampleSizeBits, c.expBits, `bits ${c.size}`);
    assert.equal(h.channels, c.expCh, `channels ${c.type}`);
  }
});

test('AAC 序列头：提取 ASC 且 parseAscInfo 还原采样率/声道', () => {
  const asc = Uint8Array.from([0x12, 0x10]); // AOT=2 LC, idx=4→44.1k, ch=2
  const p = mkParser();
  const log = collect(p);
  p.push(audioTag(soundByte(10, 3, 1, 1), concat([Uint8Array.from([0x00]), asc])));
  p.flush();
  assert.equal(log.audio[0].packetType, 'config');
  assert.deepEqual([...log.audio[0].asc], [...asc]);
  const info = parseAscInfo(log.audio[0].asc);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.aot, 2);
});

test('AAC 24bit 采样率扩展（idx=15）与 channels=0 回退到 2', () => {
  // 位布局：AOT(5)=00010, freqIdx(4)=1111(15, escape) → 24bit 采样率=48000(0x00BB80) → 4bit channels=0010
  // rate 按位读取：R = (b1&0x7F)<<17 | b2<<9 | b3<<1 | b4>>7
  //   0x80→b1&0x7F=0；0x5D=93 → 93<<9=47616；0xC0=192 → 192<<1=384；合计 48000
  // b4 = [rate 末位=0][channels=0010][pad 000] = 0x10
  const extAsc = Uint8Array.from([0x17, 0x80, 0x5d, 0xc0, 0x10]);
  const info = parseAscInfo(extAsc);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.aot, 2);

  // 0x13 = AOT=2, freqIdx=6(24000) ; channels 字段=0 → 应回退为 2
  const ch0Asc = Uint8Array.from([0x13, 0x00]);
  const info2 = parseAscInfo(ch0Asc);
  assert.equal(info2.sampleRate, 24000);
  assert.equal(info2.channels, 2);
});

test('AAC 裸帧：packetType=1 时音轨负载正确剥离 2 字节头', () => {
  const raw = new Uint8Array([0x55, 0x66, 0x77]);
  const p = mkParser();
  const log = collect(p);
  p.push(audioTag(soundByte(10, 3, 1, 1), concat([Uint8Array.from([0x01]), raw])));
  p.flush();
  assert.equal(log.audio[0].packetType, 'raw');
  assert.deepEqual([...log.audio[0].data], [...raw]);
});

test('MP3 直通：剥离 1 字节 sound 头，整段作为裸样本', () => {
  const raw = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const p = mkParser();
  const log = collect(p);
  p.push(audioTag(soundByte(2, 3, 1, 1), raw));
  p.flush();
  assert.equal(log.audio[0].packetType, 'raw');
  // audioTag 的 tag data = [sound 头, ...raw]，解析器 slice(1) 剥掉 sound 头后恰好还原 raw
  assert.deepEqual([...log.audio[0].data], [...raw]);
});

test('未知 sound format → 透传 unknown(n) 且仍按裸样本处理', () => {
  const p = mkParser();
  const log = collect(p);
  p.push(audioTag(soundByte(9, 0, 0, 0), Uint8Array.from([0xab, 0xcd])));
  p.flush();
  assert.equal(log.audio[0].soundFormat, 'unknown(9)');
  assert.equal(log.audio[0].packetType, 'raw');
});

test('AAC Tag 仅 1 字节（缺 packetType）→ 不产生 audio 事件', () => {
  const p = mkParser();
  const log = collect(p);
  p.push(audioTag(soundByte(10, 3, 1, 1), Uint8Array.from([])));
  p.flush();
  assert.equal(log.audio.length, 0);
});

test('零长度音频 Tag（无数据）→ 不产生 audio 事件', () => {
  const p = mkParser();
  const log = collect(p);
  p.push(tag(8, new Uint8Array(0)));
  p.flush();
  assert.equal(log.audio.length, 0);
});
