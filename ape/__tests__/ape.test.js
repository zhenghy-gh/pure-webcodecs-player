/**
 * ape/__tests__/ape.test.js — MAC 头与 APE TAG 解析单测（node --test）
 * fixture 全程序化生成：合成 descriptor/legacy 两种容器 + v1/v2 标签。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMacHeader,
  findApeTag,
  tagValue,
  summarizeApe,
  probeApe,
} from '../src/index.js';

/* ============================================================
 * fixture 构造
 * ============================================================ */

/** 合成 APE_DESCRIPTOR 形态文件（版本 3990） */
function buildDescriptorFile(opt = {}) {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, opt.version ?? 3990, true);
  dv.setUint32(6, 56 + 24, true);   // descriptorLen（含头与 seek 表的总量，示意值）
  dv.setUint32(10, 24, true);       // headerLen
  dv.setUint32(14, opt.seekTableLen ?? 0, true);
  dv.setUint32(18, 44, true);       // waveHeaderLen
  dv.setUint32(22, opt.audioLen ?? 100000, true);
  dv.setUint32(26, 0, true);
  // p=32 起为 HEADER 24 字节
  let p = 32;
  dv.setUint16(p, opt.compression ?? 4001, true); p += 2;   // normal
  dv.setUint16(p, opt.flags ?? 0x02, true); p += 2;
  dv.setUint32(p, opt.blocksPerFrame ?? 73728, true); p += 4;
  dv.setUint32(p, opt.finalBlocks ?? 12345, true); p += 4;
  dv.setUint32(p, opt.totalFrames ?? 10, true); p += 4;
  dv.setUint16(p, opt.bps ?? 16, true); p += 2;
  dv.setUint16(p, opt.channels ?? 2, true); p += 2;
  dv.setUint32(p, opt.sampleRate ?? 44100, true); p += 4;
  return b;
}

/** 合成 legacy 形态（版本 3950） */
function buildLegacyFile() {
  const b = new Uint8Array(20);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, 3950, true);
  dv.setUint16(6, 4000, true);      // fast
  dv.setUint16(8, 0x02, true);
  dv.setUint16(10, 2, true);        // channels
  dv.setUint32(12, 44100, true);    // sampleRate
  return b;
}

/** 构造一个 APE 标签（footer [+ header]）字节 */
function buildTag(items, { version = 2000, withHeader = false } = {}) {
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const itemParts = [];
  for (const [key, value] of items) {
    const vb = typeof value === 'string' ? enc.encode(value) : value;
    const kb = enc.encode(key);
    const len = 8 + kb.length + 1 + vb.length;
    const arr = new Uint8Array(len);
    const dv = new DataView(arr.buffer);
    dv.setUint32(0, vb.length, true);
    const flags = typeof value === 'string' ? 0 : (1 << 1); // binary → type=1
    dv.setUint32(4, flags, true);
    arr.set(kb, 8);
    arr[kb.length + 8] = 0;
    arr.set(vb, 9 + kb.length);
    itemParts.push(arr);
  }
  const itemsBytes = concat(itemParts);

  const mkFooter = (tagSize, count, flags) => {
    const f = new Uint8Array(32);
    const dv = new DataView(f.buffer);
    for (const [i, ch] of [...'APETAGEX'].entries()) f[i] = ch.charCodeAt(0);
    dv.setUint32(8, version, true);
    dv.setUint32(12, tagSize, true);
    dv.setUint32(16, count, true);
    dv.setUint32(20, flags, true);
    return f;
  };

  if (!withHeader) {
    const footer = mkFooter(itemsBytes.length + 32, items.length, 0);
    return concat([itemsBytes, footer]);
  }
  const total = itemsBytes.length + 64;
  const header = mkFooter(total, items.length, 0x80000000 | 0x20000000); // contains+isHeader
  const footer = mkFooter(total, items.length, 0x80000000);
  return concat([header, itemsBytes, footer]);
}

function concat(list) {
  const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

/* ============================================================
 * MAC 头解析
 * ============================================================ */

describe('parseMacHeader', () => {
  test('descriptor 形态：字段齐全、时长换算正确', () => {
    const info = parseMacHeader(buildDescriptorFile());
    assert.equal(info.version, 3990);
    assert.equal(info.kind, 'descriptor');
    assert.equal(info.compressionLevel, 'normal');
    assert.equal(info.channels, 2);
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.bitsPerSample, 16);
    assert.equal(info.totalFrames, 10);
    const totalSamples = 9 * 73728 + 12345;
    assert.equal(info.durationUs, Math.round((totalSamples / 44100) * 1e6));
    assert.equal(info.formatFlags.noWaveHeader, false);
  });

  test('legacy 形态：块大小按版本推导、帧数未知', () => {
    const info = parseMacHeader(buildLegacyFile());
    assert.equal(info.kind, 'legacy');
    assert.equal(info.version, 3950);
    assert.equal(info.blocksPerFrame, 73728); // ≥3900
    assert.equal(info.totalFrames, null);
    assert.equal(info.durationUs, null);
  });

  test('压缩级别映射与未知码兜底', () => {
    assert.equal(parseMacHeader(buildDescriptorFile({ compression: 4002 })).compressionLevel, 'high');
    assert.equal(parseMacHeader(buildDescriptorFile({ compression: 4711 })).compressionLevel, 'code-4711');
  });

  test('非法魔数 / 非法声道抛 PARSE_ERROR', () => {
    assert.throws(() => parseMacHeader(new TextEncoder().encode('RIFFxxxxxxxx')),
      (e) => e.code === 'PARSE_ERROR');
    assert.throws(() => parseMacHeader(buildDescriptorFile({ channels: 99 })),
      (e) => e.code === 'PARSE_ERROR');
  });
});

/* ============================================================
 * APE TAG 解析
 * ============================================================ */

describe('APE TAG', () => {
  test('v2 footer-only：utf8 与 binary 项解析正确', () => {
    const cover = new Uint8Array([0x69, 0x6d, 0x61, 0x67, 0x65, 0x2f, 0x70, 0x6e, 0x67, 0, 0x89, 0x50]);
    const file = concat([buildDescriptorFile(), buildTag([
      ['Title', '测试曲目'], ['Artist', 'ox-alpha'], ['Cover Art (front)', cover],
    ])]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.version, 2000);
    assert.equal(tag.itemCount, 3);
    assert.equal(tagValue(tag, 'TITLE'), '测试曲目'); // key 大小写不敏感
    const coverItem = tag.items.find((i) => i.type === 'binary');
    assert.ok(coverItem && coverItem.value instanceof Uint8Array);
    assert.deepEqual([...coverItem.value.subarray(9)], [0, 0x89, 0x50]);
  });

  test('含 ID3v1 尾巴时能跳过定位标签', () => {
    const tagBytes = buildTag([['Album', '演示专辑']]);
    const id3v1 = new Uint8Array(128);
    id3v1[0] = 0x54; id3v1[1] = 0x41; id3v1[2] = 0x47; // 'TAG'
    const file = concat([buildDescriptorFile(), tagBytes, id3v1]);
    const tag = findApeTag(file);
    assert.equal(tagValue(tag, 'ALBUM'), '演示专辑');
  });

  test('无标签返回 null 不抛异常', () => {
    assert.equal(findApeTag(buildDescriptorFile()), null);
    assert.equal(findApeTag(new Uint8Array(40)), null);
  });

  test('summarize 汇总封面二进制（mime\\0data 结构）', () => {
    const cover = concat([new TextEncoder().encode('image/png'), new Uint8Array([0, 1, 2, 3])]);
    const file = concat([buildDescriptorFile(), buildTag([['Cover Art (front)', cover]])]);
    const s = summarizeApe(file);
    assert.equal(s.info.channels, 2);
    assert.equal(s.cover.mime, 'image/png');
    assert.deepEqual([...s.cover.data], [1, 2, 3]);
  });
});

/* ============================================================
 * probe 与边界
 * ============================================================ */

describe('probeApe', () => {
  test('命中 MAC 魔数且置信度达标', () => {
    const r = probeApe(buildDescriptorFile());
    assert.ok(r && r.container === 'ape' && r.confidence >= 0.8);
  });
  test('非 APE 返回 null', () => {
    assert.equal(probeApe(new Uint8Array(4)), null);
    assert.equal(probeApe(new TextEncoder().encode('fLaC')), null);
  });
});
