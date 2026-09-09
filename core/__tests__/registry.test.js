/**
 * 注册表（CONTRACTS §10）单测：注册/嗅探/自动工厂/URL 入口（注入 fetch 离线可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerDemuxer,
  unregisterDemuxer,
  resetRegistry,
  listRegistered,
  probeBuffer,
  createDemuxerAuto,
  detectFromUrl,
} from '../src/registry.js';
import { MemoryDataSource, createProbeResult } from '../src/index.js';

/** 伪模块工厂 */
function fakeModule(name, confidence, container = name) {
  return {
    containerName: name,
    extensions: [name],
    mimeTypes: [`application/x-${name}`],
    probe: (bytes) => (bytes[0] === 0xa0 ? createProbeResult(confidence, container) : null),
    createDemuxer: async () => ({ containerName: name, opened: true }),
  };
}

test('registerDemuxer：幂等覆盖同容器名；listRegistered 快照', () => {
  resetRegistry();
  registerDemuxer(fakeModule('alpha', 0.9));
  const v2 = { ...fakeModule('alpha', 0.95), extra: true };
  registerDemuxer(v2);
  assert.equal(listRegistered().length, 1);
  assert.ok(listRegistered()[0].extensions.includes('alpha'));
  unregisterDemuxer('alpha');
  assert.equal(listRegistered().length, 0);
});

test('registerDemuxer：缺 probe/createDemuxer 抛 TypeError', () => {
  assert.throws(() => registerDemuxer({ containerName: 'x' }), TypeError);
});

test('probeBuffer：取最高置信度；无 ≥0.8 命中返回 null', () => {
  resetRegistry();
  const bytes = new Uint8Array([0xa0, 1, 2, 3]);
  registerDemuxer(fakeModule('low', 0.5));
  registerDemuxer(fakeModule('high', 0.95));
  const hit = probeBuffer(bytes);
  assert.equal(hit.container, 'high');
  assert.equal(hit.confidence, 0.95);

  resetRegistry();
  registerDemuxer(fakeModule('low', 0.5));
  assert.equal(probeBuffer(bytes), null);
});

test('probeBuffer：单模块嗅探异常按未命中兜底', () => {
  resetRegistry();
  registerDemuxer({
    containerName: 'boom',
    probe: () => {
      throw new Error('boom');
    },
    createDemuxer: async () => ({}),
  });
  registerDemuxer(fakeModule('ok', 0.9));
  const hit = probeBuffer(new Uint8Array([0xa0]));
  assert.equal(hit.container, 'ok');
});

test('createDemuxerAuto：命中胜者并完成 open；全不识别 reject PROBE_FAILED 聚合置信度', async () => {
  resetRegistry();
  const bytes = new Uint8Array([0xa0, 9]);
  const src = new MemoryDataSource(bytes);

  registerDemuxer(fakeModule('a', 0.7));
  registerDemuxer({
    containerName: 'b',
    probe: () => createProbeResult(0.99, 'b'),
    createDemuxer: async (source) => {
      // 验证 source 原样透传
      const head = await source.read(0, 2);
      return { containerName: 'b', head: [...head] };
    },
  });
  const d = await createDemuxerAuto(src);
  assert.equal(d.containerName, 'b');
  assert.deepEqual(d.head, [0xa0, 9]);

  resetRegistry();
  registerDemuxer(fakeModule('low', 0.3));
  await assert.rejects(
    () => createDemuxerAuto(src),
    (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.ok(e.detail && e.detail.low === 0.3, 'detail 携带各模块置信度聚合');
      return true;
    },
  );
});

test('createDemuxerAuto：真实 mp4/mov 注册后可识别渐进 fixture', async () => {
  resetRegistry();
  const mp4mod = await import('../../mp4/src/index.js');
  const movmod = await import('../../mov/src/index.js');
  registerDemuxer(mp4mod);
  registerDemuxer(movmod);

  const { buildProgressiveVideoFixture, buildFragmentedFixture } = await import('../../mp4/__tests__/fixtures.js');
  const prog = buildProgressiveVideoFixture();
  const d = await createDemuxerAuto(new MemoryDataSource(prog.bytes));
  assert.equal(d.metadata.container, 'mp4');

  const frag = buildFragmentedFixture();
  const d2 = await createDemuxerAuto(new MemoryDataSource(frag.bytes));
  assert.equal(d2.mediaInfo.container, 'mp4');

  // mov fixture → mov 胜出
  const { buildQuickTimeMovFixture } = await import('../../mov/__tests__/fixtures.js');
  const qt = buildQuickTimeMovFixture();
  const d3 = await createDemuxerAuto(new MemoryDataSource(qt.bytes));
  assert.equal(d3.metadata.container, 'mov');

  // 垃圾字节 → PROBE_FAILED
  await assert.rejects(
    () => createDemuxerAuto(new MemoryDataSource(new Uint8Array(64).fill(0x33))),
    (e) => e.code === 'PROBE_FAILED',
  );
  resetRegistry();
});

test('detectFromUrl：注入 fetch 的离线路径', async () => {
  resetRegistry();
  const mp4mod = await import('../../mp4/src/index.js');
  registerDemuxer(mp4mod);
  const { buildProgressiveVideoFixture } = await import('../../mp4/__tests__/fixtures.js');
  const whole = buildProgressiveVideoFixture().bytes;

  const fetchImpl = async (_url, init = {}) => {
    const range = init.headers?.Range ?? '';
    if (!range) throw new Error('expected Range header');
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), whole.length - 1);
    return new Response(whole.slice(start, end + 1).slice(), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${whole.length}` },
    });
  };

  const demuxer = await detectFromUrl('http://fixture.invalid/movie.mp4', { fetchImpl });
  assert.equal(demuxer.metadata.container, 'mp4');
  assert.equal(demuxer.source.url, 'http://fixture.invalid/movie.mp4');
  await demuxer.destroy(); // 避免测试结束后残留异步活动
  resetRegistry();
});
