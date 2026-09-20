/**
 * atom-compat-gaps.test.js —— QuickTime atom 兼容层防御性 catch 补测（wave 151）
 *
 * 覆盖：
 *   - hasQuickTimeHints：顶层扫描遇残字节 → catch → false（looksLikeQuickTime 不炸）；
 *   - detectCompressedMoov：cmov 内 dcom 扫描遇越界 size → 尽力读取仍报 compressed；
 *   - parseUdtaTags：外层 moov 扫描残字节 → 返回已收集 tags（空）；
 *   - parseMetaAtom：ISO 风格 meta 内子盒残缺 → 内部 catch 不外抛。
 *
 * 登记（不硬造）：readTextAtom 233-234 的 TextDecoder.decode catch——
 * `new TextDecoder('utf-8')` 默认 fatal:false，对任意字节序列以 U+FFFD 替换而不抛；
 * 标签名（'utf-8'）为合法编码，构造器亦不抛。该 catch 在现行 API 契约下不可达。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeQuickTime,
  detectCompressedMoov,
  parseUdtaTags,
} from '../src/atom-compat.js';

const U8 = (arr) => Uint8Array.from(arr);

/** box(size+fourcc+payload)，size 自动按总长写 */
function box(type, payload = U8([])) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** 显式 size 的 box 头（用于制造越界/残缺） */
function boxRawSize(type, size) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  return out;
}

test('looksLikeQuickTime：moov 开头但顶层含残缺字节 → 扫描抛错被吞，返回 false', () => {
  // moov 空盒（size=8）后跟 3 个非零残字节 → truncated box header
  const bytes = concat([box('moov'), U8([0xaa, 0xbb, 0xcc])]);
  assert.equal(looksLikeQuickTime(bytes), false);
});

test('detectCompressedMoov：cmov 内 dcom 声明越界 size → 内层 catch 后仍判 compressed', () => {
  // cmov 内容：dcom 头声明 size=200（远超 cmov 边界 16），仅再给 4 字节
  const cmovContent = concat([boxRawSize('dcom', 200), U8([0x78, 0x61, 0x6c, 0x00])]);
  const moovContent = box('cmov', cmovContent);
  const r = detectCompressedMoov(moovContent);
  assert.equal(r.compressed, true);
  assert.equal(r.vendor, undefined, 'dcom 读取失败不影响 compressed 判定');
});

test('parseUdtaTags：moov 扫描遇残字节 → catch 返回空表不抛', () => {
  const bytes = concat([U8([0xaa, 0xbb, 0xcc])]); // 无完整 box 头
  assert.deepEqual(parseUdtaTags(bytes), {});
});

test('parseUdtaTags：ISO 风格 meta 内子盒残缺 → parseMetaAtom 内部吞错不外抛', () => {
  // meta = version/flags(4B) + 4B 非零残片（不足 box 头）；udta 包 meta
  const metaPayload = U8([0, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0xdd]);
  const moovContent = box('udta', box('meta', metaPayload));
  assert.doesNotThrow(() => {
    const tags = parseUdtaTags(moovContent);
    assert.deepEqual(tags, {});
  });
});

test('登记取证：非 fatal TextDecoder 对非法 UTF-8 不抛（233-234 不可达依据）', () => {
  // 0xFF/0xFE 非合法 UTF-8 起始字节 → U+FFFD 替换而非抛错
  assert.doesNotThrow(() => new TextDecoder('utf-8').decode(U8([0xff, 0xfe, 0xfd])));
});

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
