/**
 * subtitle/src/index.js — 模块唯一入口（具名导出）
 *
 * PurePlay · subtitle —— SRT/WebVTT/ASS(SSA) 字幕解析与 Canvas 渲染。
 * 契约基线：docs/CONTRACTS.md v0.2（E-8 口径）（§0 纯 ESM/零依赖/µs 时间基；
 * §3 字幕 codec 串 x-srt/x-vtt/x-ass；§2.4 渲染归展示层，本模块提供渲染组件）。
 */

// 解析器
export { parseSrt, formatSrtTimestamp } from './srt.js';
export { parseVtt, formatVttTimestamp } from './vtt.js';
export { parseAss, formatAssTimestamp } from './ass.js';

// 嗅探与自动分派
export { detectFormat, probeSubtitleCodec, parseAuto } from './detect.js';

// CONTRACTS v0.2 §8 字幕轨公共接口
export { probe, parseCues, createTextTrack } from './track.js';

// 时间码工具
export { parseTimestamp } from './time.js';

// Cue 工具
export { normalizeText, stripCueTags, sortCues, shiftCues, findActiveCues, cuesDurationUs } from './cue.js';

// ASS 样式基础件
export { parseAssColor, rgbaToCss, createDefaultStyle } from './style.js';

// 覆盖标签（词法 + 白名单状态机）
export { TagState, TAG_WHITELIST, tokenizeDialogue, unescapeAssText } from './tags.js';

// 排版求解（纯函数，Node 可断言）
export {
  layoutEvents, wrapSegments, resolveCollisions,
  approximateMeasure, anchorToXY, anToAnchor, fadeFactor, resolveMove,
} from './layout.js';

// 渲染器（浏览器；Node 下 isRendererSupported()=false）
export { SubtitleCanvasRenderer, isRendererSupported } from './renderer.js';

// 错误类型（SubtitleError extends core PlayerError；ErrorCode 为 core 十码封闭枚举）
export { SubtitleError, PlayerError, ErrorCode } from './errors.js';
