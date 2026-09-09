/**
 * ape/src/errors.js — 统一错误体系（core 再导出）
 * ------------------------------------------------------------
 * S1 错误体系收口：PlayerError / ErrorCode 直接复用 core 的
 * 十码封闭枚举定稿实现（CONTRACTS v0.2 §11.3），本模块不再
 * 私设错误码或错误类（webtorrent 同款模式）。
 *
 * · 既有具名导出 PlayerError、ErrorCode 与四个快捷构造器
 *   （notSupported / parseError / sourceError / stateError）
 *   签名与语义不变，仅实现切换为 core；
 * · 其余六码经 ErrorCode 与同名快捷构造器同样可用；
 *   模块特定细分需求一律走 detail 字段，不在 core 外扩码。
 */
export {
  PlayerError,
  ErrorCode,
  probeFailed,
  parseError,
  notSupported,
  sourceError,
  networkError,
  decodeError,
  seekUnsupported,
  timeoutError,
  abortedError,
  stateError,
} from '../../core/src/errors.js';
