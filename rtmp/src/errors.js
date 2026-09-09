/**
 * 错误体系（对齐 CONTRACTS §11.3 封闭枚举；传输层自含最小实现，形状与 core PlayerError 一致）。
 */

const CODES = new Set([
  'PROBE_FAILED',
  'PARSE_ERROR',
  'NOT_SUPPORTED',
  'SOURCE_ERROR',
  'NETWORK_ERROR',
  'DECODE_ERROR',
  'SEEK_UNSUPPORTED',
  'TIMEOUT',
  'ABORTED',
  'STATE_ERROR',
]);

export class PlayerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PlayerError';
    if (!CODES.has(code)) throw new Error(`未登记的错误码: ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

export const errors = {
  network: (msg, detail) => new PlayerError('NETWORK_ERROR', msg, detail),
  timeout: (msg, detail) => new PlayerError('TIMEOUT', msg, detail),
  state: (msg, detail) => new PlayerError('STATE_ERROR', msg, detail),
  aborted: (msg = '用户主动中断') => new PlayerError('ABORTED', msg),
  parse: (msg, detail) => new PlayerError('PARSE_ERROR', msg, detail),
  notSupported: (msg, detail) => new PlayerError('NOT_SUPPORTED', msg, detail),
};
