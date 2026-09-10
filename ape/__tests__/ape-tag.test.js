/**
 * ape/__tests__/ape-tag.test.js — APE 标签解析边界补强（node --test）
 * 覆盖 ape-tag.js 的未测分支：
 *   · findApeTag 长度守卫（<32B 直接 null；<160B 不触发 ID3v1 跳过）
 *   · tagValue 对 null/undefined 标签安全返回 undefined
 *   · item valueLen 超出剩余字节：Math.min 钳制不越界、不抛
 *   · 非零但过小的 tagSize 致 itemsStart>itemsEnd → PARSE_ERROR
 *   · APE_TAG_VERSION 契约常量与版本边界（2001 视为异常）
 * 全部内联 fixture，离线可测。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findApeTag,
  tagValue,
  APE_TAG_VERSION,
  summarizeApe,
} from '../src/index.js';

const enc = new TextEncoder();
function u8(...b) { return Uint8Array.from(b); }
function concat(list) {
  const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

/** 标准 64B descriptor 头 */
function buildDescriptorFile() {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, 3990, true);
  dv.setUint32(6, 80, true);
  dv.setUint32(10, 24, true);
  dv.setUint32(18, 44, true);
  dv.setUint32(22, 100000, true);
  let p = 32;
  dv.setUint16(p, 4001, true); p += 2;
  dv.setUint16(p, 0x02, true); p += 2;
  dv.setUint32(p, 73728, true); p += 4;
  dv.setUint32(p, 12345, true); p += 4;
  dv.setUint32(p, 10, true); p += 4;
  dv.setUint16(p, 16, true); p += 2;
  dv.setUint16(p, 2, true); p += 2;
  dv.setUint32(p, 44100, true);
  return b;
}

/** 通用 footer 构造；sizeOverride 可注入畸形 tagSize */
function footer(version, tagSize, count, flags = 0) {
  const f = new Uint8Array(32);
  const dv = new DataView(f.buffer);
  for (const [i, ch] of [...'APETAGEX'].entries()) f[i] = ch.charCodeAt(0);
  dv.setUint32(8, version, true);
  dv.setUint32(12, tagSize, true);
  dv.setUint32(16, count, true);
  dv.setUint32(20, flags, true);
  return f;
}

/** 单个 item：valueLen(4)+flags(4)+key\0+value，valueLen 可强制覆盖 */
function item(key, value, flags, forceLen) {
  const vb = typeof value === 'string' ? enc.encode(value) : value;
  const kb = enc.encode(key);
  const arr = new Uint8Array(8 + kb.length + 1 + vb.length);
  const dv = new DataView(arr.buffer);
  dv.setUint32(0, forceLen ?? vb.length, true);
  dv.setUint32(4, flags >>> 0, true);
  arr.set(kb, 8);
  arr[8 + kb.length] = 0;
  arr.set(vb, 9 + kb.length);
  return arr;
}

describe('findApeTag 长度守卫', () => {
  test('文件 <32B 直接返回 null', () => {
    assert.equal(findApeTag(new Uint8Array(31)), null);
    assert.equal(findApeTag(new Uint8Array(0)), null);
  });

  test('<160B 末尾形似 TAG 但不触发 ID3v1 跳过 → null', () => {
    // 159B：尾部 [31..33] = 'TAG'，但 n<160 无法容纳前置标签区域
    const b = new Uint8Array(159);
    b[0] = 0x4d; b[1] = 0x41; b[2] = 0x43; b[3] = 0x20; // 前置合法 MAC 防早退
    b[31] = 0x54; b[32] = 0x41; b[33] = 0x47;
    assert.equal(findApeTag(b), null);
  });
});

describe('tagValue 容错', () => {
  test('null / undefined 标签安全返回 undefined 不抛', () => {
    assert.equal(tagValue(null, 'TITLE'), undefined);
    assert.equal(tagValue(undefined, 'ARTIST'), undefined);
    assert.equal(tagValue({ version: 2000, itemCount: 0, items: [] }, 'X'), undefined);
  });
});

describe('item valueLen 越界钳制', () => {
  test('声明 valueLen 大于实际剩余字节：钳制到 itemsEnd 不崩溃', () => {
    // item 声明 valueLen=10，但仅 2 字节可用 → 解析为 2 字节（binary 项保留原始字节）
    const it = item('K', u8(0xaa, 0xbb), 0x02, 10);
    const tagLen = it.length + 32; // footer-only
    const file = concat([buildDescriptorFile(), it, footer(2000, tagLen, 1)]);
    const tag = findApeTag(file);
    assert.ok(tag);
    const k = tag.items.find((i) => i.key === 'K');
    assert.ok(k);
    assert.deepEqual([...k.value], [0xaa, 0xbb]);
    assert.equal(k.value.length, 2);
  });
});

describe('畸形 tagSize：itemsStart>itemsEnd 抛 PARSE_ERROR', () => {
  test('非零过小 tagSize（16 < 32）：itemsStart 回退越界 → 抛错', () => {
    const it = item('T', 'x', 0);
    // 故意写入过小的 tagSize，使 itemsStart = itemsEnd - (16-32) > itemsEnd
    const file = concat([buildDescriptorFile(), it, footer(2000, 16, 1)]);
    assert.throws(() => findApeTag(file), (e) => e.code === 'PARSE_ERROR');
  });
});

describe('APE_TAG_VERSION 契约与版本边界', () => {
  test('导出常量 V1=1000 / V2=2000', () => {
    assert.deepEqual(APE_TAG_VERSION, { V1: 1000, V2: 2000 });
  });

  test('版本 2001（非 1000/2000）解析抛 PARSE_ERROR', () => {
    const it = item('T', 'x', 0);
    const tagLen = it.length + 32;
    const file = concat([buildDescriptorFile(), it, footer(2001, tagLen, 1)]);
    assert.throws(() => findApeTag(file), (e) => e.code === 'PARSE_ERROR');
  });

  test('版本 1000 与 2000 均正常解析', () => {
    for (const v of [1000, 2000]) {
      const it = item('T', 'v' + v, 0);
      const tagLen = it.length + 32;
      const file = concat([buildDescriptorFile(), it, footer(v, tagLen, 1)]);
      const tag = findApeTag(file);
      assert.equal(tag.version, v, `版本 ${v}`);
      assert.equal(tagValue(tag, 'T'), 'v' + v);
    }
  });
});

describe('summarizeApe 对无标签二进制封面键不产生封面', () => {
  test('非封面二进制项不误报为 cover', () => {
    const it = item('Lyrics', u8(1, 2, 3), 0x02);
    const tagLen = it.length + 32;
    const s = summarizeApe(concat([buildDescriptorFile(), it, footer(2000, tagLen, 1)]));
    assert.equal(s.cover, null);
    assert.equal(s.tag.items.length, 1);
  });
});
