/**
 * flac/__tests__/contract.test.js — FLAC 契约面（CONTRACTS §10 注册形状 +
 * §2.2 定稿方法 open/readSample/destroy）回归
 * ------------------------------------------------------------
 * 覆盖：§10 五件套形状与 probe 语义；open() 别名；readSample pull 主通道
 * （EOS null）；destroy 幂等与销毁后 STATE_ERROR；ended seek 后恢复迭代
 * （wav#2 同款修复回归）；createDemuxer 工厂（PROBE_FAILED 路径）。
 * fixture：复用 gen.mjs 产物 sample-basic.flac（8000Hz 2 帧 CONSTANT）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFix } from './helpers.mjs';
import {
  FlacDemuxer,
  containerName,
  extensions,
  mimeTypes,
  probe,
  createDemuxer,
  ErrorCode,
} from '../src/index.js';

const mem = (b) => ({ size: b.length, async read(o, l) { return b.subarray(o, o + l); }, async close() {} });

test('§10 注册形状：containerName/extensions/mimeTypes/probe/createDemuxer 齐', async () => {
  const bytes = await readFix('sample-basic.flac');
  assert.equal(containerName, 'flac');
  assert.deepEqual(extensions, ['flac']);
  assert.ok(mimeTypes.length >= 1 && mimeTypes[0].startsWith('audio/'));
  assert.equal(typeof probe, 'function');
  assert.equal(typeof createDemuxer, 'function');

  const hit = probe(bytes);
  assert.equal(hit?.container, 'flac');
  assert.ok(hit.confidence >= 0.8, '命中须 ≥0.8');
  assert.equal(probe(new Uint8Array([0x01, 0x02, 0x03])), null, '未命中返回 null');
  assert.equal(probe(new Uint8Array(0)), null);
  assert.doesNotThrow(() => probe(new Uint8Array(300).fill(0xff)), '任意字节不抛');
});

test('open() 定稿名：解析初始化段并暴露 mediaInfo（= parseInit）', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = new FlacDemuxer(mem(bytes));
  const mi = await d.open();
  assert.equal(d.state, 'ready');
  assert.equal(mi.container, 'flac');
  assert.equal(d.mediaInfo.tracks[0].codec, 'flac');
  assert.ok(d.mediaInfo.tracks[0].description?.byteLength === 34, 'STREAMINFO 34B 作 description');
});

test('readSample pull 主通道：顺序出帧、EOS resolve null', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = new FlacDemuxer(mem(bytes));
  await d.open();
  const a = await d.readSample(1);
  const b = await d.readSample(1);
  const c = await d.readSample(1);
  assert.ok(a && b, '两帧都应产出');
  assert.equal(a.codec, 'flac');
  assert.ok(a.timestamp < b.timestamp, '时间戳递增');
  assert.equal(c, null, 'EOS 后 resolve null');
  assert.equal(d.state, 'ended');
});

test('ended seek 后恢复迭代（wav#2 同款修复回归）', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = new FlacDemuxer(mem(bytes));
  await d.open();
  assert.equal(await d.readSample(1) && await d.readSample(1) && await d.readSample(1), null, '拉完进入 ended');
  assert.equal(d.state, 'ended');
  const r = await d.seek(0);
  assert.equal(d.state, 'ready', 'seek 后必须回 ready，否则 samples/readSample 永久 STATE_ERROR');
  assert.ok(r.actualTimestampUs === 0);
  const again = await d.readSample(1);
  assert.ok(again, 'seek 后应能重新迭代产出首帧');
});

test('destroy 幂等 + 销毁后调用抛 STATE_ERROR', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = new FlacDemuxer(mem(bytes));
  await d.open();
  await d.destroy();
  assert.equal(d.state, 'destroyed');
  await d.destroy(); // 幂等
  await assert.rejects(async () => { await d.readSample(1); }, (e) => {
    assert.equal(e.code, ErrorCode.STATE_ERROR);
    return true;
  });
});

test('createDemuxer 工厂：DataSource → 已 ready；非 FLAC reject PROBE_FAILED', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = await createDemuxer(mem(bytes));
  assert.ok(d instanceof FlacDemuxer);
  assert.equal(d.state, 'ready');
  const s = await d.readSample(1);
  assert.ok(s, '工厂产物可直接拉流');

  await assert.rejects(
    () => createDemuxer(mem(new TextEncoder().encode('definitely not flac'))),
    (e) => { assert.equal(e.code, ErrorCode.PROBE_FAILED); return true; },
  );
});

test('§12.3 新增可选成员：readSample/samples 支持 options.signal（中断不吞帧）', async () => {
  const bytes = await readFix('sample-basic.flac');
  const d = new FlacDemuxer(mem(bytes));
  await d.open();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => d.readSample(1, { signal: ac.signal }), (e) => e?.code === 'ABORTED');
  await assert.rejects(async () => {
    for await (const s of d.samples(1, { signal: ac.signal })) void s;
  }, (e) => e?.code === 'ABORTED');
  // samples 迭代器内「先读后推进游标」：中断不吞帧，首帧仍完整可取
  const s = await d.readSample(1);
  assert.ok(s && s.data.byteLength > 0, '中断不得吞掉首帧');
  await d.destroy();
});
