/**
 * limits.js —— 畸形输入防护的字节上界（评审第二轮 I5 安全项）
 *
 * 背景：容器头里的长度字段（moov size / stsz sample size / mdat 长度…）在畸形文件里
 * 可以是任意 32 位值。此前 demuxer 直接把 `sample.size` 交给 `source.read()`，
 * 一个声明 2GB 的样本会触发一次性 2GB 的 Range 请求与内存分配（OOM / 卡死）。
 * 契约 I5 要求「Range 读取上界、解出的 sample 长度和与源长度互检」。
 *
 * 本模块只提供常量与断言原语，具体数值由各 demuxer 通过 options 覆盖，
 * 默认值取「正常内容不可能触及、畸形内容立刻暴露」的量级。
 */

import { parseError } from './errors.js';

/** 单次 DataSource.read 的默认上界：64MB（4K 高码率样本通常 < 2MB） */
export const DEFAULT_MAX_READ_BYTES = 64 << 20;

/** moov/moof 单次读入上界：64MB（常规 moov < 数 MB） */
export const DEFAULT_MAX_MOOV_BYTES = 64 << 20;

/** 单个样本上界：32MB */
export const DEFAULT_MAX_SAMPLE_BYTES = 32 << 20;

/** 密钥/初始化段等小资源上界：1MB */
export const DEFAULT_MAX_SMALL_RESOURCE_BYTES = 1 << 20;

/** 全文件扫描型 demuxer（如 FLAC 建帧索引）的上界：256MB */
export const DEFAULT_MAX_SCAN_BYTES = 256 << 20;

/**
 * 断言一个字节长度在给定上界内；越界抛 PARSE_ERROR（畸形长度字段属解析错误面）。
 *
 * @param {number} value 待校验长度（负数/NaN 视为越界）
 * @param {number} max 上界
 * @param {string} what 用途描述，进入错误信息
 * @returns {number} 原值，便于就地使用
 */
export function assertByteLength(value, max, what = '长度') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw parseError(
      `${what}越界: ${value}（上限 ${max} 字节）；疑似畸形长度字段，已拒绝以防内存爆炸`,
    );
  }
  return n;
}

/**
 * 取一个受上界保护的读取长度：超出上界直接抛错（不静默截断，避免半截数据被当正常内容）。
 * @param {number} want 期望长度
 * @param {number} max 上界
 * @param {string} what 用途描述
 */
export function clampReadLength(want, max, what) {
  return assertByteLength(want, max, what);
}

/**
 * 极简 FIFO 上限缓存：防止 key/metadata 类小缓存在长直播下无限增长。
 * 与 Map 同面（get/set/has/delete/clear/size），超限时按插入序淘汰最旧项。
 */
export class BoundedMapCache {
  /** @param {number} maxEntries 上限（<=0 表示不缓存） */
  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(0, Math.floor(maxEntries));
    /** @type {Map<any, any>} */
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    return this._map.get(key);
  }

  has(key) {
    return this._map.has(key);
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  set(key, value) {
    if (this.maxEntries === 0) return this;
    this._map.set(key, value);
    while (this._map.size > this.maxEntries) {
      this._map.delete(this._map.keys().next().value);
    }
    return this;
  }
}
