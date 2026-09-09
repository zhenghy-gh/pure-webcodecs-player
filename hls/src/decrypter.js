/**
 * decrypter.js —— HLS AES-128 整段分片解密（CONTRACTS v0.2 §2.6）
 *
 * 范围与约定：
 *  - 仅支持 METHOD=AES-128；METHOD=NONE 直通；SAMPLE-AES/DRM → NOT_SUPPORTED；
 *  - 密钥固定 16 字节，经可注入 keyLoader(keyUri) 获取（缺省全局 fetch，单测注入 mock）；
 *  - 算法：WebCrypto subtle AES-CBC，PKCS7 填充由 subtle 自动剥离；
 *  - IV：KEY 带 IV 属性 → 16 字节十六进制；未带 → 媒体序号 sn 的 128 位大端
 *    （序号按无符号 64 位处理，高 64 位补零）；
 *  - 同构：crypto 提供方可注入（浏览器 crypto.subtle / node:crypto webcrypto），
 *    同一套代码双环境测试；
 *  - 错误映射（封闭）：subtle 不可用或密钥长度≠16 → NOT_SUPPORTED；
 *    密钥获取失败 → NETWORK_ERROR；解密后首块校验失败（TS 应 0x47 /
 *    fMP4 应合法 box 头）→ PARSE_ERROR。
 */

import { PlayerError, ErrorCode } from '../../core/src/errors.js';
import { assertSafeUrl } from '../../core/src/url-guard.js';
import {
  DEFAULT_MAX_SMALL_RESOURCE_BYTES,
  BoundedMapCache,
} from '../../core/src/limits.js';
import { aesCbcDecryptNoPadding, stripPkcs7 } from './aes-cbc.js';


/** 默认密钥加载器：全局 fetch 拉取二进制 key */
async function defaultKeyLoader(uri) {
  if (typeof fetch !== 'function') {
    throw new PlayerError(ErrorCode.NOT_SUPPORTED, '当前环境无 fetch 且未注入 keyLoader');
  }
  // I5：密钥 URI 来自清单，必须过协议白名单（file:/data:/javascript: 一律拒绝）
  assertSafeUrl(uri, { what: 'AES-128 密钥' });
  const res = await fetch(uri);
  if (!res.ok) {
    throw new PlayerError(ErrorCode.SOURCE_ERROR, `密钥获取失败: HTTP ${res.status} ${uri}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > DEFAULT_MAX_SMALL_RESOURCE_BYTES) {
    throw new PlayerError(
      ErrorCode.SOURCE_ERROR,
      `密钥响应过大 (${buf.byteLength} 字节，上限 ${DEFAULT_MAX_SMALL_RESOURCE_BYTES}): ${uri}`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * 由媒体序号推导 IV：sn 视为无符号 64 位整数，128 位大端表示。
 * @param {number} sn
 * @returns {Uint8Array} 16 字节
 */
export function ivFromMediaSequence(sn) {
  const out = new Uint8Array(16);
  const big = typeof sn === 'bigint' ? sn : BigInt(Math.max(0, Math.floor(sn)));
  const dv = new DataView(out.buffer);
  // 高 64 位补零，低 64 位放序号
  dv.setBigUint64(8, big & 0xffffffffffffffffn);
  return out;
}

/** 首块合法性校验：TS 包定界符 0x47 或 ISO-BMFF 合法 box 头 */
export function looksLikePlaintext(data) {
  if (!data || data.length < 8) return false;
  if (data[0] === 0x47) return true; // TS sync byte
  const size = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
  if (size >= 8 && size <= data.length + 16) {
    const t = String.fromCharCode(data[4], data[5], data[6], data[7]);
    return /^[a-zA-Z0-9\x20]{4}$/.test(t); // box type 四字符
  }
  return false;
}

export class Aes128Decrypter {
  /**
   * @param {{crypto?:{subtle:SubtleCrypto}, keyLoader?:(uri:string)=>Promise<Uint8Array>}} [options]
   */
  constructor(options = {}) {
    // 注入优先：显式传入 crypto 对象时以其为准（可为 null 模拟无 subtle 环境）
    this.subtle =
      options.crypto !== undefined
        ? options.crypto?.subtle ?? null
        : (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) || null;
    this.keyLoader = options.keyLoader || defaultKeyLoader;
    /**
     * uri -> 已导入的密钥。
     * I5：有界缓存（默认 64 条 FIFO），防长直播轮换 KEY 时无界增长。
     * @type {BoundedMapCache}
     */
    this._keys = new BoundedMapCache(options.maxCachedKeys ?? 64);
    this.hasSubtle = !!this.subtle;
  }

  /**
   * 校验清单级加密能力：遇到不支持的 METHOD 立即报错（契约要求不得静默跳过）。
   * @param {{method:string}} key parseMedia 分片上的 key 结构
   */
  assertSupported(key) {
    if (!key || key.method === 'NONE') return;
    if (key.method !== 'AES-128') {
      throw new PlayerError(
        ErrorCode.NOT_SUPPORTED,
        `暂不支持的加密方式: ${key.method}（本期仅支持 AES-128，见 CONTRACTS §2.6）`
      );
    }
    if (!this.hasSubtle) {
      throw new PlayerError(
        ErrorCode.NOT_SUPPORTED,
        '当前环境不可用 crypto.subtle，无法解密 AES-128 分片（明文清单不受影响）'
      );
    }
  }

  /**
   * 获取（并缓存）密钥。
   * @param {string} uri KEY URI
   * @returns {Promise<{raw:Uint8Array, imported:CryptoKey}>}
   */
  async getKey(uri) {
    // I5：密钥 URI 来自清单（可被诱导为 file:/data:/javascript:），
    // 在任何 keyLoader（含注入实现）被调用之前先过协议白名单
    assertSafeUrl(uri, { what: 'AES-128 密钥' });
    const cached = this._keys.get(uri);
    if (cached) return cached;
    let raw;
    try {
      raw = await this.keyLoader(uri);
    } catch (err) {
      if (err instanceof PlayerError) throw err;
      throw new PlayerError(ErrorCode.NETWORK_ERROR, `密钥获取失败: ${err.message}`, { cause: err });
    }
    if (!(raw instanceof Uint8Array) || raw.length !== 16) {
      throw new PlayerError(
        ErrorCode.NOT_SUPPORTED,
        `AES-128 密钥长度必须为 16 字节，实际 ${raw ? raw.length : 'null'}`
      );
    }
    const imported = await this.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    const entry = { raw, imported };
    this._keys.set(uri, entry);
    return entry;
  }

  /**
   * 解密一个整段分片。
   * @param {Uint8Array} data 密文字节
   * @param {{method:string, uri:string, iv:{bytes:Uint8Array}|null}} keyInfo 分片继承的 KEY 结构
   * @param {{sn:number, containerHint?:'ts'|'fmp4'}} ctx 分片上下文（sn 用于 IV 推导）
   * @returns {Promise<Uint8Array>} 明文
   */
  async decryptSegment(data, keyInfo, ctx) {
    this.assertSupported(keyInfo);
    if (!keyInfo || keyInfo.method !== 'AES-128') return data;

    const { raw, imported } = await this.getKey(keyInfo.uri);
    // RFC 8216：显式 IV 优先，否则用媒体序号推导
    const iv =
      keyInfo.iv && keyInfo.iv.bytes && keyInfo.iv.bytes.length === 16
        ? keyInfo.iv.bytes
        : ivFromMediaSequence(ctx.sn);

    let plain;
    try {
      plain = await this.subtle.decrypt({ name: 'AES-CBC', iv }, imported, data);
    } catch (err) {
      // subtle 强制校验 PKCS7：个别服务端未按 RFC 8216 填充时失败。
      // 兜底：纯软件 CBC 无填充解密，再尽力剥离填充（合规流等价、非合规流可救）。
      plain = this._decryptSoftware(data, iv, raw, err);
    }

    const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
    if (!looksLikePlaintext(bytes)) {
      throw new PlayerError(
        ErrorCode.PARSE_ERROR,
        '解密后首块校验失败（非 TS/fMP4 形态），疑似密钥错误或数据损坏'
      );
    }
    return bytes;
  }

  /**
   * 纯软件兜底：无填充 CBC 解密 + 尽力剥 PKCS7。
   * 填充合法 → 与 subtle 路径结果一致；填充非法 → 按未填充流原样返回。
   */
  _decryptSoftware(data, iv, rawKey, cause) {
    if (data.length % 16 !== 0 || data.length < 16) {
      throw new PlayerError(
        ErrorCode.PARSE_ERROR,
        `AES-128 分片长度非法（${data.length}，需为非零 16 的倍数）`
      );
    }
    try {
      const plain = aesCbcDecryptNoPadding(rawKey, iv, data);
      return stripPkcs7(plain) ?? plain;
    } catch (err) {
      throw new PlayerError(ErrorCode.DECODE_ERROR, 'AES-CBC 解密失败', { cause: cause ?? err });
    }
  }

  destroy() {
    this._keys.clear();
  }
}
