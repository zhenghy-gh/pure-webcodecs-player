/**
 * 第一轮评审 §17.3 回归：fetch credentials 可配置。
 * 旧实现 segment-loader 硬编码 credentials:'omit'，带 Cookie 的授权源无法接入。
 * 验证：默认保持 'omit'（向后兼容）、配置贯通 load/loadText、非法取值构造期即抛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentLoader } from '../src/segment-loader.js';
import { HlsPlayer } from '../src/player.js';
import { PlayerError, ErrorCode } from '../../core/src/errors.js';

/** 最小 fetch 桩：记录每次调用的 init，返回 8 字节空响应 */
function makeFetchStub() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null, // 走 arrayBuffer 退化路径
      arrayBuffer: async () => new ArrayBuffer(8),
    };
  };
  return { impl, calls };
}

test('默认凭据策略保持 omit（向后兼容）', async () => {
  const { impl, calls } = makeFetchStub();
  const loader = new SegmentLoader({ fetchImpl: impl });
  assert.equal(loader.credentials, 'omit');
  await loader.load('https://example.com/seg.ts');
  assert.equal(calls[0].init.credentials, 'omit');
});

test('配置 include 贯通 load 与 loadText', async () => {
  const { impl, calls } = makeFetchStub();
  const loader = new SegmentLoader({ fetchImpl: impl, credentials: 'include' });
  assert.equal(loader.credentials, 'include');
  await loader.load('https://example.com/seg.ts');
  await loader.loadText('https://example.com/index.m3u8');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].init.credentials, 'include');
});

test('配置 same-origin 同样贯通', async () => {
  const { impl, calls } = makeFetchStub();
  const loader = new SegmentLoader({ fetchImpl: impl, credentials: 'same-origin' });
  await loader.load('https://example.com/seg.ts');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('非法 credentials 构造期即抛 STATE_ERROR', () => {
  assert.throws(
    () => new SegmentLoader({ credentials: 'cookies' }),
    (err) => err instanceof PlayerError && err.code === ErrorCode.STATE_ERROR
  );
});

test('HlsPlayer 配置贯通到 loader；缺省回落 omit', () => {
  const withCfg = new HlsPlayer({ credentials: 'include' });
  assert.equal(withCfg.loader.credentials, 'include');
  const default_ = new HlsPlayer();
  assert.equal(default_.loader.credentials, 'omit');
});

test('HlsPlayer 非法 credentials 同样快速失败', () => {
  assert.throws(
    () => new HlsPlayer({ credentials: 'auto' }),
    (err) => err instanceof PlayerError && err.code === ErrorCode.STATE_ERROR
  );
});
