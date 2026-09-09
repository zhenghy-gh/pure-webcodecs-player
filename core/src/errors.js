/**
 * 统一错误体系（CONTRACTS v0.2 §11.3 定稿）。
 *
 * - 错误类定名 PlayerError（裁决 12.1-2，草案名 MediaError 废弃）；
 * - 错误码封闭枚举，取双方并集共 **10 码**，禁止在 core 之外扩展新码；
 * - 规则：同步 throw / 异步 reject 同类型并同时 emit('error')；禁止吞错。
 */

/** 错误码封闭枚举（CONTRACTS §11.3，十码并集） */
export const ErrorCode = Object.freeze({
  /** 所有注册 demuxer 均无法识别 */
  PROBE_FAILED: 'PROBE_FAILED',
  /** 结构损坏/校验失败 */
  PARSE_ERROR: 'PARSE_ERROR',
  /** codec/SAMPLE-AES/DRM 等特性不支持 */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** 数据源越界、File/Range 读写失败 */
  SOURCE_ERROR: 'SOURCE_ERROR',
  /** fetch/WS 网关连接失败或异常断开 */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** WebCodecs/MSE 解码报错 */
  DECODE_ERROR: 'DECODE_ERROR',
  /** 直播/无索引容器 seek */
  SEEK_UNSUPPORTED: 'SEEK_UNSUPPORTED',
  /** open/网络等待超时 */
  TIMEOUT: 'TIMEOUT',
  /** 用户主动中断 */
  ABORTED: 'ABORTED',
  /** 生命周期非法迁移（≈草案 INVALID_STATE，定稿此名） */
  STATE_ERROR: 'STATE_ERROR',
});

/** 播放器错误基类：{ code, detail } 双附加字段（契约 §11.3） */
export class PlayerError extends Error {
  /**
   * @param {string} code ErrorCode 封闭枚举之一
   * @param {string} message 中文人类可读描述
   * @param {{cause?: unknown, detail?: object}} [options]
   */
  constructor(code, message, options = undefined) {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    if (options && options.cause !== undefined) this.cause = options.cause;
    if (options && options.detail !== undefined) this.detail = options.detail;
  }
}

/* ------------------------------ 快捷构造器 ------------------------------ */

export function probeFailed(message, detail) {
  return new PlayerError(ErrorCode.PROBE_FAILED, message, { detail });
}

export function parseError(message, detail) {
  return new PlayerError(ErrorCode.PARSE_ERROR, message, { detail });
}

export function notSupported(message, detail) {
  return new PlayerError(ErrorCode.NOT_SUPPORTED, message, { detail });
}

export function sourceError(message, detail) {
  return new PlayerError(ErrorCode.SOURCE_ERROR, message, { detail });
}

export function networkError(message, detail) {
  return new PlayerError(ErrorCode.NETWORK_ERROR, message, { detail });
}

export function decodeError(message, detail) {
  return new PlayerError(ErrorCode.DECODE_ERROR, message, { detail });
}

export function seekUnsupported(message, detail) {
  return new PlayerError(ErrorCode.SEEK_UNSUPPORTED, message, { detail });
}

export function timeoutError(message, detail) {
  return new PlayerError(ErrorCode.TIMEOUT, message, { detail });
}

export function abortedError(message, detail) {
  return new PlayerError(ErrorCode.ABORTED, message, { detail });
}

export function stateError(message, detail) {
  return new PlayerError(ErrorCode.STATE_ERROR, message, { detail });
}
