/**
 * 错误体系（对齐 CONTRACTS §11.3：code 封闭枚举）。
 *
 * 本模块自含最小实现（传输层不依赖 core），字段形状与 core/src/errors.js 的
 * PlayerError 一致（name/code/message/detail），后续统一接入波次可直接互换。
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
  /**
   * @param {string} code §11.3 封闭枚举之一
   * @param {string} message 中文文案
   * @param {*} [detail] 附加诊断信息（禁止携带二进制本体）
   */
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
  source: (msg, detail) => new PlayerError('SOURCE_ERROR', msg, detail),
};
