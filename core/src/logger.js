/**
 * 四级日志（CONTRACTS §11.4）：debug < info < warn < error，默认 warn。
 *
 * - createLogger('mp4') 产出带模块前缀的 logger；
 * - debug=逐 box/Tag/包，info=生命周期节点，warn=可恢复异常，error=终止故障；
 * - **禁止打印二进制本体**（最多前 16 字节 hex）——logBytes 工具内置该规则；
 * - 文案中文；Node 与浏览器共用 console。
 */

/** 日志级别（数值越大越严重） */
export const LogLevel = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

let currentLevel = LogLevel.warn;

/** 设置全局日志级别（默认 'warn'；测试可调 'debug'） */
export function setLogLevel(level) {
  const v = typeof level === 'number' ? level : LogLevel[level];
  if (!Number.isFinite(v)) throw new TypeError(`unknown log level: ${level}`);
  currentLevel = v;
}

/** 二进制安全预览：最多前 16 字节 hex（§11.4 禁打印二进制本体） */
export function logBytes(bytes, max = 16) {
  if (!bytes || typeof bytes.byteLength !== 'number') return String(bytes);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = Math.min(max, u8.byteLength);
  let s = '';
  for (let i = 0; i < n; i++) s += u8[i].toString(16).padStart(2, '0');
  return `hex[${u8.byteLength}B] ${s}${u8.byteLength > n ? '…' : ''}`;
}

const CONSOLE_METHOD = {
  [LogLevel.debug]: 'debug',
  [LogLevel.info]: 'info',
  [LogLevel.warn]: 'warn',
  [LogLevel.error]: 'error',
};

/**
 * 创建模块级 logger。
 * @param {string} prefix 模块前缀，如 'mp4' / 'core'
 * @returns {{debug:(...args:any[])=>void, info:(...args:any[])=>void, warn:(...args:any[])=>void, error:(...args:any[])=>void}}
 */
export function createLogger(prefix) {
  const tag = `[${prefix}]`;
  const make = (level) => (...args) => {
    if (level < currentLevel) return;
    const fn = console[CONSOLE_METHOD[level]] ?? console.log;
    fn(tag, ...args);
  };
  return {
    debug: make(LogLevel.debug),
    info: make(LogLevel.info),
    warn: make(LogLevel.warn),
    error: make(LogLevel.error),
  };
}
