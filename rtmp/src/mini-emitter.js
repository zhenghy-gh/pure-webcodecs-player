/**
 * 传输层事件发射器兼容别名。
 * 事件语义统一复用 core Emitter；on/off/once 返回取消函数，emit 支持多参数。
 */
import { Emitter } from '../../core/src/emitter.js';

export class MiniEmitter extends Emitter {}
