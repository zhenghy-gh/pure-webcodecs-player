/**
 * subtitle/src/errors.js — 统一错误体系（core 子类扩展）
 * ------------------------------------------------------------
 * S1 错误体系收口（CONTRACTS v0.2 §11.3，webtorrent 同款模式）：
 * · 本地四码枚举删除，ErrorCode 直接再导出 core 十码封闭枚举；
 * · 主类型 SubtitleError 改为 extends core PlayerError，
 *   保留本模块 error.name === 'SubtitleError' 语义；
 * · PlayerError 为兼容别名（SubtitleError 子类，
 *   error.name === 'PlayerError'），同时天然 instanceof core PlayerError；
 * · 既有四个快捷构造器签名不变，另补齐全量十码构造器；
 *   模块特定细分需求一律走 detail 字段，不在 core 外扩码。
 */
import { PlayerError as CorePlayerError, ErrorCode } from '../../core/src/errors.js';

/** 十码封闭枚举：直接复用 core 定稿（原本地四码枚举已删除） */
export { ErrorCode };

/** 字幕模块错误基类：上层 UI 按 error.code 分类提示，不解析 message */
export class SubtitleError extends CorePlayerError {
  /**
   * @param {string} code core ErrorCode 封闭枚举之一
   * @param {string} message 中文描述
   * @param {{cause?: unknown, detail?: object}} [options]
   */
  constructor(code, message, options = undefined) {
    super(code, message, options);
    this.name = 'SubtitleError';
  }
}

/** 兼容别名：与其他媒体模块的 PlayerError 同构（SubtitleError 子类） */
export class PlayerError extends SubtitleError {
  constructor(code, message, options = undefined) {
    super(code, message, options);
    this.name = 'PlayerError';
  }
}

/* ------------------------------ 快捷构造器 ------------------------------ */

/** 构造 PROBE_FAILED 错误 */
export function probeFailed(message, detail) {
  return new SubtitleError(ErrorCode.PROBE_FAILED, message, { detail });
}

/** 构造 PARSE_ERROR 错误 */
export function parseError(message, detail) {
  return new SubtitleError(ErrorCode.PARSE_ERROR, message, { detail });
}

/** 构造 NOT_SUPPORTED 错误 */
export function notSupported(message, detail) {
  return new SubtitleError(ErrorCode.NOT_SUPPORTED, message, { detail });
}

/** 构造 SOURCE_ERROR 错误 */
export function sourceError(message, detail) {
  return new SubtitleError(ErrorCode.SOURCE_ERROR, message, { detail });
}

/** 构造 NETWORK_ERROR 错误 */
export function networkError(message, detail) {
  return new SubtitleError(ErrorCode.NETWORK_ERROR, message, { detail });
}

/** 构造 DECODE_ERROR 错误 */
export function decodeError(message, detail) {
  return new SubtitleError(ErrorCode.DECODE_ERROR, message, { detail });
}

/** 构造 SEEK_UNSUPPORTED 错误 */
export function seekUnsupported(message, detail) {
  return new SubtitleError(ErrorCode.SEEK_UNSUPPORTED, message, { detail });
}

/** 构造 TIMEOUT 错误 */
export function timeoutError(message, detail) {
  return new SubtitleError(ErrorCode.TIMEOUT, message, { detail });
}

/** 构造 ABORTED 错误 */
export function abortedError(message, detail) {
  return new SubtitleError(ErrorCode.ABORTED, message, { detail });
}

/** 构造 STATE_ERROR 错误 */
export function stateError(message, detail) {
  return new SubtitleError(ErrorCode.STATE_ERROR, message, { detail });
}
