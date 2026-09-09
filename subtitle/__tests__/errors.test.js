/**
 * subtitle/src/errors.js 专项测试（S1 错误体系收口）。
 *
 * 该文件此前无直接测试：各解析模块都走 `new SubtitleError(...)` 直构，
 * 10 个快捷构造器零调用，覆盖率全靠间接。这里表驱动覆盖全部构造器，
 * 并固化跨模块继承链语义（subtitle.SubtitleError instanceof core.PlayerError）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../src/errors.js';
import { PlayerError as CorePlayerError, ErrorCode as CoreErrorCode } from '../../core/src/errors.js';

const { SubtitleError, PlayerError, ErrorCode } = mod;

/** 构造器名 → 期望 code（CONTRACTS §11.3 十码封闭枚举） */
const CONSTRUCTORS = [
  ['probeFailed', 'PROBE_FAILED'],
  ['parseError', 'PARSE_ERROR'],
  ['notSupported', 'NOT_SUPPORTED'],
  ['sourceError', 'SOURCE_ERROR'],
  ['networkError', 'NETWORK_ERROR'],
  ['decodeError', 'DECODE_ERROR'],
  ['seekUnsupported', 'SEEK_UNSUPPORTED'],
  ['timeoutError', 'TIMEOUT'],
  ['abortedError', 'ABORTED'],
  ['stateError', 'STATE_ERROR'],
];

describe('ErrorCode 再导出', () => {
  it('与 core 十码封闭枚举完全一致且冻结', () => {
    assert.deepEqual(ErrorCode, CoreErrorCode, '应直接复用 core 定稿，不在模块外扩码');
    assert.ok(Object.isFrozen(ErrorCode));
    assert.equal(Object.keys(ErrorCode).length, 10);
    for (const [key, value] of Object.entries(ErrorCode)) {
      assert.equal(key, value, `码名与码值应同名（${key}）`);
    }
  });
});

describe('SubtitleError', () => {
  it('继承 core PlayerError，name 保持 SubtitleError', () => {
    const e = new SubtitleError(ErrorCode.PARSE_ERROR, '字幕解析失败');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof CorePlayerError, '应可跨模块被 core 侧捕获');
    assert.equal(e.name, 'SubtitleError');
    assert.equal(e.code, 'PARSE_ERROR');
    assert.equal(e.message, '字幕解析失败');
  });

  it('透传 cause 与 detail（契约 §11.3 双附加字段）', () => {
    const cause = new Error('boom');
    const detail = { line: 12, raw: '[xx]' };
    const e = new SubtitleError(ErrorCode.PARSE_ERROR, '坏行', { cause, detail });
    assert.equal(e.cause, cause);
    assert.deepEqual(e.detail, detail);
  });

  it('未传 options 时不挂 cause/detail 字段', () => {
    const e = new SubtitleError(ErrorCode.TIMEOUT, '超时');
    assert.equal(e.cause, undefined);
    assert.equal(e.detail, undefined);
    assert.equal('cause' in e, false);
    assert.equal('detail' in e, false);
  });
});

describe('PlayerError 兼容别名', () => {
  it('是 SubtitleError 子类且 name 为 PlayerError', () => {
    const e = new PlayerError(ErrorCode.NOT_SUPPORTED, '不支持的格式');
    assert.ok(e instanceof SubtitleError, '别名应保持可被子模块 catch 捕获');
    assert.ok(e instanceof CorePlayerError, '同时天然 instanceof core PlayerError');
    assert.equal(e.name, 'PlayerError');
    assert.equal(e.code, 'NOT_SUPPORTED');
  });
});

describe('快捷构造器', () => {
  for (const [fn, code] of CONSTRUCTORS) {
    it(`${fn}() → code=${code} 的 SubtitleError`, () => {
      const build = mod[fn];
      assert.equal(typeof build, 'function', `应导出 ${fn}`);

      const detail = { at: fn };
      const e = build(`${fn} 失败`, detail);
      assert.ok(e instanceof SubtitleError);
      assert.equal(e.name, 'SubtitleError');
      assert.equal(e.code, code, `${fn} 应映射到 ${code}`);
      assert.equal(e.message, `${fn} 失败`);
      assert.deepEqual(e.detail, detail, 'detail 应透传');
    });

    it(`${fn}() 省略 detail 时不挂字段`, () => {
      const e = mod[fn]('无附加信息');
      assert.equal(e.code, code);
      assert.equal('detail' in e, false);
    });
  }

  it('十个构造器产出的 code 两两不同（无映射撞车）', () => {
    const codes = CONSTRUCTORS.map(([fn]) => mod[fn]('x').code);
    assert.equal(new Set(codes).size, CONSTRUCTORS.length);
  });
});
