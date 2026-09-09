/**
 * ape/src/ape-tag.js — APEv1 / APEv2 标签解析
 * ------------------------------------------------------------
 * TAG 尾部结构（footer 32B）：
 *   'APETAGEX'(8) + version(4le,1000/2000) + tagSize(4le) + itemCount(4le)
 *   + flags(4le) + reserved(8)
 * tagSize 含全部 item + footer（若含 header 再 +32）。
 * item：valueLen(4) + itemFlags(4) + key(ascii\0) + value(utf8/binary)
 *
 * 定位策略（与主流工具一致）：
 *   ① 文件尾 32B 即 footer；
 *   ② 否则跳过 ID3v1（128B 'TAG'）再查；
 *   ③ 均无 → null。
 */
import { parseError } from './errors.js';

export const APE_TAG_VERSION = Object.freeze({ V1: 1000, V2: 2000 });

/** item 类型 */
const ITEM_TYPE = ['utf8', 'binary', 'locator', 'reserved'];

/**
 * @typedef {Object} ApeTagItem
 * @property {string} key
 * @property {string|Uint8Array} value  utf8 项给字符串；binary/locator 给原始字节
 * @property {string} type              'utf8'|'binary'|'locator'
 * @property {boolean} readOnly
 */

/**
 * @typedef {Object} ApeTag
 * @property {number} version           1000 / 2000
 * @property {number} itemCount
 * @property {boolean} isHeader         本次解析的是 header 形态还是 footer
 * @property {ApeTagItem[]} items
 */

const textDecoder = new TextDecoder();

/**
 * 在文件字节中定位并解析 APE 标签；不存在返回 null。
 * @param {Uint8Array} bytes 完整文件字节
 * @returns {ApeTag|null}
 */
export function findApeTag(bytes) {
  const n = bytes.length;
  if (n < 32) return null;
  const tailIsFooter = magicAt(bytes, n - 32);
  if (tailIsFooter) return parseTagAt(bytes, n - 32, false);
  // 跳过 ID3v1（'TAG'+125 字节）
  if (n >= 160 && bytes[n - 128] === 0x54 && bytes[n - 127] === 0x41 && bytes[n - 126] === 0x47) {
    if (magicAt(bytes, n - 128 - 32)) return parseTagAt(bytes, n - 160, false);
  }
  return null;
}

/** 检查 offset 处是否为 APETAGEX 魔数 */
function magicAt(bytes, off) {
  return bytes[off] === 0x41 && bytes[off + 1] === 0x50 && bytes[off + 2] === 0x45 &&
    bytes[off + 3] === 0x54 && bytes[off + 4] === 0x41 && bytes[off + 5] === 0x47 &&
    bytes[off + 6] === 0x45 && bytes[off + 7] === 0x58;
}

/**
 * 从 footer（或 header）位置解析标签。
 * @param {Uint8Array} bytes
 * @param {number} footerPos footer 起始偏移
 * @param {boolean} isHeader 是否为 header 形态（其前是 items）
 */
function parseTagAt(bytes, footerPos, isHeader) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = footerPos + 8;
  const version = dv.getUint32(p, true); p += 4;
  if (version !== APE_TAG_VERSION.V1 && version !== APE_TAG_VERSION.V2) {
    throw parseError(`APE TAG 版本异常：${version}`);
  }
  const tagSize = dv.getUint32(p, true); p += 4;
  const itemCount = dv.getUint32(p, true); p += 4;
  const flags = dv.getUint32(p, true);
  const containsHeader = !!(flags & 0x80000000);

  // items 区域结束于本 footer/header 的起点
  const itemsEnd = footerPos;
  const itemsStart = itemsEnd - (tagSize - 32 - (containsHeader ? 32 : 0));
  if (itemsStart < 0 || itemsStart > itemsEnd) throw parseError('APE TAG 尺寸字段非法');

  /** @type {ApeTagItem[]} */
  const items = [];
  let q = itemsStart;
  for (let i = 0; i < itemCount && q + 8 <= itemsEnd; i++) {
    const valueLen = dv.getUint32(q, true);
    const itemFlags = dv.getUint32(q + 4, true);
    q += 8;
    // key：ASCII 直到 \0
    let keyEnd = q;
    while (keyEnd < itemsEnd && bytes[keyEnd] !== 0) keyEnd++;
    const key = textDecoder.decode(bytes.subarray(q, keyEnd)).trim();
    q = keyEnd + 1;
    const typeCode = (itemFlags >> 1) & 0x03;
    const valueBytes = bytes.slice(q, Math.min(q + valueLen, itemsEnd));
    q += valueLen;

    items.push({
      key,
      value: typeCode === 0 ? textDecoder.decode(valueBytes) : valueBytes,
      type: ITEM_TYPE[typeCode] || 'reserved',
      readOnly: !!(itemFlags & 0x01),
    });
  }

  return { version, itemCount, isHeader, items };
}

/** 便捷取值：按 key 取 utf8 字符串（大小写不敏感），无则 undefined */
export function tagValue(tag, key) {
  const hit = tag?.items.find((it) => it.type === 'utf8' && it.key.toUpperCase() === key.toUpperCase());
  return hit?.value;
}
