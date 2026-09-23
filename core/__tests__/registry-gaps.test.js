/**
 * registry 残余分支补测（第一百二十一波）
 * ------------------------------------------------------------
 * 覆盖：createDemuxerAuto detail 聚合的嗅探异常兜底、命中容器名无对应
 * 注册项、detectFromUrl 无 fetch / 头请求失败 / body.cancel 同步抛错 /
 * 内容不可识别。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerDemuxer,
  resetRegistry,
  createDemuxerAuto,
  detectFromUrl,
} from '../src/registry.js';
import { createProbeResult, MemoryDataSource } from '../src/index.js';

const GARBAGE = new Uint8Array(64).fill(0x33);

test('createDemuxerAuto：detail 聚合时单模块嗅探异常记 0', async () => {
  resetRegistry();
  registerDemuxer({
    containerName: 'boom',
    probe: () => { throw new Error('boom'); },
    createDemuxer: async () => ({}),
  });
  await assert.rejects(
    () => createDemuxerAuto(new MemoryDataSource(GARBAGE)),
    (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.equal(e.detail.boom, 0, '异常模块置信度记 0');
      return true;
    },
  );
  resetRegistry();
});

test('createDemuxerAuto：探测命中的容器名无注册模块 → PROBE_FAILED（携带 hit）', async () => {
  resetRegistry();
  // probe 返回的 container 与注册名解耦（别名/漂移场景）
  registerDemuxer({
    containerName: 'alias-mod',
    probe: (bytes) => (bytes[0] === 0xa0 ? createProbeResult(0.9, 'ghost') : null),
    createDemuxer: async () => ({}),
  });
  await assert.rejects(
    () => createDemuxerAuto(new MemoryDataSource(new Uint8Array([0xa0, 1, 2, 3]))),
    (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.match(e.message, /命中 ghost 但未注册对应模块/);
      assert.equal(e.detail?.hit?.container, 'ghost');
      return true;
    },
  );
  resetRegistry();
});

test('detectFromUrl：环境无 fetch → PROBE_FAILED', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
  return detectFromUrl('http://fixture.invalid/a.mp4')
    .then(
      () => assert.fail('should reject'),
      (e) => {
        assert.equal(e.code, 'PROBE_FAILED');
        assert.match(e.message, /fetch unavailable/);
      },
    )
    .finally(() => {
      if (saved) Object.defineProperty(globalThis, 'fetch', saved);
      else delete globalThis.fetch;
    });
});

test('detectFromUrl rejects unsafe URL before fetching', async () => {
  let calls = 0;
  await assert.rejects(() => detectFromUrl('file:///etc/passwd', { fetchImpl: async () => { calls += 1; } }), (e) => e.code === 'NETWORK_ERROR');
  assert.equal(calls, 0);
});

test('detectFromUrl: HTTP failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: { get: () => null } });
  await assert.rejects(
    () => detectFromUrl('http://fixture.internal/a.mp4', { fetchImpl }),
    (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.match(e.message, /head request failed \(500\)/);
      return true;
    },
  );
});

test('detectFromUrl：body.cancel 同步抛错被吞并，探测继续', async () => {
  resetRegistry();
  const bytes = new Uint8Array(64).fill(0x33);
  const fetchImpl = async () => ({
    ok: true,
    status: 206,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer,
    body: { cancel() { throw new Error('sync cancel boom'); } },
  });
  await assert.rejects(
    () => detectFromUrl('http://fixture.internal/g.mp4', { fetchImpl }),
    (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.match(e.message, /无法识别该 URL 内容/);
      return true;
    },
  );
  resetRegistry();
});
