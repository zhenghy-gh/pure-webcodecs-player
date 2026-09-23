/**
 * FlvDemuxer 残余防御分支直测（第一百九十七波）
 * ------------------------------------------------------------
 * 补齐 flv-demuxer.js 最后 6 处未覆盖行：
 *   - _feedParser / 泵路径 _pumpOnce / 旧式 push 三处 parser.push 抛错 → error 事件；
 *   - _doSeek 双守卫（ChunkSource 模式、关键帧索引缺失含 null 与空数组两形态）；
 *   - start() 逐轨消费任务异常上抛：非 destroyed 发 error 事件、destroyed 静默。
 * 均为直接调用内部方法的白盒回归（先例：waitForTracksOrEos 直测），
 * 固化「异常不外泄、统一转 error 事件」的既有行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer } from '../src/flv-demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';

import { flvHeader, aacSequenceTag, assembleFlv } from './fixtures/build-flv.mjs';

const ASC = Uint8Array.from([0x12, 0x10]);

function stdFile() {
  return assembleFlv({ video: { frames: 12, gopSize: 4 }, audio: { count: 2 } });
}

function makeChunkSink() {
  const sink = { write() {}, end() {} };
  const d = new FlvDemuxer(sink);
  return { d, sink };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 三处 push 异常 → error 事件 ------------------------------ */

test('_feedParser：parser.push 抛错 → 转 error 事件不外泄', async () => {
  const { d, sink } = makeChunkSink();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.parser.push = () => { throw new Error('feed-boom'); };
  sink.write(new Uint8Array([1, 2, 3])); // patched write → _feedParser
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'feed-boom');
  await d.destroy();
});

test('_pumpOnce：DataSource 泵路径 parser.push 抛错 → error 事件且泵本身正常返回', async () => {
  const d = new FlvDemuxer(new MemoryDataSource(stdFile()));
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.parser.push = () => { throw new Error('pump-boom'); };
  assert.equal(await d._pumpOnce(), true, '首块读取成功 → 返回 true');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'pump-boom');
  await d.destroy();
});

test('push（旧式兼容通道）：parser.push 抛错 → error 事件', async () => {
  const d = new FlvDemuxer(new Uint8Array(0)); // idle → push 内触发 open()（空源自行收尾）
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.parser.push = () => { throw new Error('legacy-boom'); };
  d.push(new Uint8Array([1]));
  assert.ok(errs.some((e) => e.message === 'legacy-boom'));
  await sleep(0); // 等 open() 的内部 reject 被 .catch 吞掉，不外泄
  await d.destroy();
});

/* ------------------------------ _doSeek 双守卫 ------------------------------ */

test('_doSeek：ChunkSource 流式模式 → SEEK_UNSUPPORTED（不可回退）', async () => {
  const { d } = makeChunkSink();
  await assert.rejects(() => d._doSeek(0), (e) => {
    assert.equal(e.code, 'SEEK_UNSUPPORTED');
    assert.match(e.message, /ChunkSource/);
    return true;
  });
  await d.destroy();
});

test('_doSeek：关键帧索引未建立 → SEEK_UNSUPPORTED（空数组与 null 两形态）', async () => {
  const d = new FlvDemuxer(new MemoryDataSource(stdFile()));
  assert.equal(d.parser.keyframeIndex.length, 0, '未解析即无索引');
  await assert.rejects(() => d._doSeek(0), (e) => {
    assert.equal(e.code, 'SEEK_UNSUPPORTED');
    assert.match(e.message, /尚未建立关键帧索引/);
    return true;
  });
  d.parser.keyframeIndex = null; // 防御 !index 形态
  await assert.rejects(() => d._doSeek(0), (e) => e.code === 'SEEK_UNSUPPORTED');
  await d.destroy();
});

/* ------------------------------ start() 任务异常出口 ------------------------------ */

async function startWithThrowingReadSample(onThrow) {
  const { d, sink } = makeChunkSink();
  sink.write(flvHeader());
  sink.write(aacSequenceTag(ASC, 0));
  await d.open();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.readSample = async () => {
    onThrow(d);
    throw new Error('task-boom');
  };
  d.start();
  await sleep(10);
  return { d, errs };
}

test('start()：消费任务抛错（非 destroyed）→ error 事件', async () => {
  const { d, errs } = await startWithThrowingReadSample(() => {});
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'task-boom');
  await d.destroy();
});

test('start()：消费任务抛错时已 destroyed → 静默不发 error 事件', async () => {
  const { d, errs } = await startWithThrowingReadSample(
    (dmx) => { dmx.stateValue = 'destroyed'; },
  );
  assert.equal(errs.length, 0, 'destroyed 态吞掉异常');
  d.stateValue = 'ready'; // 复位以便幂等收尾
  await d.destroy();
});
