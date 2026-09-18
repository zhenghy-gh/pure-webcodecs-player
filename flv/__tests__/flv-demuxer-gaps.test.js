/**
 * flv-demuxer 残余分支补测（第一百一十八波）
 * ------------------------------------------------------------
 * 覆盖此前零覆盖的分支：probe 防御性 catch、非法数据源、ChunkSource write
 * 异常吞并、非法 avcC/ASC 序列头降级、open 后到达的 onMetaData 回填、
 * 泵路径 EOF 三形态（size 用尽/读取抛错/空数据/短读）、解析器异常上抛转
 * error 事件、迭代器内泵推进、ChunkSource waiter 交付、旧式 push 异常吞并、
 * start() 暂停/恢复循环、createFlvDemuxer 工厂 fetch/Blob/DataSource 三入口。
 * 不覆盖：_doSeek 内部守卫（基类 seekable 前置校验使其不可达，属防御性重复）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer, createFlvDemuxer } from '../src/flv-demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';

import {
  flvHeader, scriptTag, avcSequenceTag, aacSequenceTag, aacRawTag,
  buildAvcC, defaultH264Sps, defaultH264Pps, assembleFlv,
} from './fixtures/build-flv.mjs';

function concat(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

function stdFile() {
  return assembleFlv({ video: { frames: 12, gopSize: 4 }, audio: { count: 2 } });
}

const AVC_C = buildAvcC(defaultH264Sps(), defaultH264Pps());
const ASC = Uint8Array.from([0x12, 0x10]);

function makeChunkSink() {
  const sink = { write() {}, end() {} };
  const d = new FlvDemuxer(sink);
  return { d, sink };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// open() 内部先 await source.open?.() 让出一拍微任务后才注册轨道/complete 监听，
// 同步紧跟的 sink.write/end 会先于监听触发事件 → 必须等一个宏任务再喂数据
const tick = () => new Promise((r) => setImmediate(r));

/* ------------------------------ probe 与数据源形态 ------------------------------ */

test('probe：字节访问抛错时防御性返回 null', () => {
  const evil = { byteLength: 10 };
  Object.defineProperty(evil, 0, { get() { throw new Error('boom'); } });
  assert.equal(FlvDemuxer.probe(evil), null);
});

test('无法识别的数据源：构造即抛 STATE_ERROR', () => {
  assert.throws(() => new FlvDemuxer(42), (e) => e.code === 'STATE_ERROR');
});

/* ------------------------------ ChunkSource 异常与序列头降级 ------------------------------ */

test('ChunkSource：write 喂入非 FLV 字节 → 解析器异常转为 error 事件，不中断', async () => {
  const { d, sink } = makeChunkSink();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  const openP = d.open(); // 先发起 open（注册 complete 监听）再喂数据
  await tick();
  sink.write(new Uint8Array(16).fill(0x07)); // ≥13 字节才触发魔数校验
  sink.end();
  await openP; // 无轨道信号但已 EOF → 空轨道信息
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /魔数不匹配/);
  await d.destroy();
});

test('ChunkSource：avcC 序列头非法 → error 事件且轨道不建', async () => {
  const { d, sink } = makeChunkSink();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  const openP = d.open();
  await tick();
  sink.write(flvHeader());
  sink.write(avcSequenceTag(new Uint8Array([0x01, 0x02]), 0)); // 长度 < 7 → 非法 avcC
  sink.end();
  const info = await openP;
  assert.ok(errs.some((e) => /非法 avcC/.test(e.message)));
  assert.deepEqual(info.tracks, []);
  await d.destroy();
});

test('ChunkSource：ASC 序列头非法 → error 事件', async () => {
  const { d, sink } = makeChunkSink();
  const errs = [];
  d.on('error', (e) => errs.push(e));
  const openP = d.open();
  await tick();
  sink.write(flvHeader());
  sink.write(aacSequenceTag(new Uint8Array(0), 0)); // 空 ASC → BitReader 越界
  sink.end();
  await openP;
  assert.ok(errs.length >= 1, '非法 ASC 应派发 error');
  await d.destroy();
});

test('ChunkSource：open 后到达的 onMetaData → 回填 durationUs 与 seekable', async () => {
  const { d, sink } = makeChunkSink();
  const openP = d.open();
  await tick();
  sink.write(flvHeader());
  sink.write(avcSequenceTag(AVC_C, 0));
  const info = await openP; // 序列头就绪即返回（此时 metadata 未到）
  assert.equal(info.durationUs, null);
  sink.write(scriptTag({ duration: 12.5, encoder: 'demo' }, 100));
  await new Promise((r) => setImmediate(r));
  assert.equal(d.mediaInfo.durationUs, 12_500_000, 'open 后的 metadata 回填 durationUs');
  assert.equal(d.mediaInfo.seekable, false, '流式模式 seekable 恒 false');
  assert.equal(d.metadata.durationUs, 12_500_000, 'metadata 活视图透出回填后的时长');
  await d.destroy();
});

/* ------------------------------ 泵路径 EOF 三形态与解析器异常 ------------------------------ */

test('泵：size 用尽（want<=0）→ EOF，open 拒绝「先于轨道信息结束」', async () => {
  const d = new FlvDemuxer(new MemoryDataSource(new Uint8Array(0)));
  await assert.rejects(() => d.open(), /文件先于任何可用轨道信息结束/);
});

test('泵：读取抛错 → 视为 EOF，open 拒绝', async () => {
  const d = new FlvDemuxer({ size: 100, read: async () => { throw new Error('io boom'); } });
  await assert.rejects(() => d.open(), /文件先于任何可用轨道信息结束/);
});

test('泵：读取返回空数据 → EOF，open 拒绝', async () => {
  const d = new FlvDemuxer({ size: 100, read: async () => new Uint8Array(0) });
  await assert.rejects(() => d.open(), /文件先于任何可用轨道信息结束/);
});

test('泵：短读（data.length < want）→ EOF', async () => {
  const file = stdFile();
  const src = {
    size: file.length,
    read: async (pos, want) => file.subarray(pos, Math.min(pos + 5, file.length)), // 每次只给 5 字节
  };
  const d = new FlvDemuxer(src);
  await assert.rejects(() => d.open(), /文件先于任何可用轨道信息结束/);
});

test('泵：解析器抛错（非 FLV 数据）→ error 事件且 open 终止', async () => {
  const garbage = new Uint8Array(64).fill(0x07);
  const d = new FlvDemuxer({ size: 64, read: async (pos, want) => garbage.subarray(pos, pos + want) });
  const errs = [];
  d.on('error', (e) => errs.push(e));
  await assert.rejects(() => d.open(), /文件先于任何可用轨道信息结束/);
  assert.ok(errs.some((e) => /魔数不匹配/.test(e.message)));
});

/* ------------------------------ 迭代与等待 ------------------------------ */

test('迭代器内泵：open 仅拿配置即返回，剩余数据经迭代器内泵推进直到 EOS', async () => {
  // 文件 > PUMP_CHUNK(64KB)：open 的首个泵块拿到序列头配置即返回，源未耗尽；
  // 注意 read 按请求量返回（want 内截断）——短读（< want）在契约上即 EOF
  const file = assembleFlv({ video: { frames: 2400, gopSize: 50 }, audio: null });
  assert.ok(file.length > 64 * 1024, 'fixture 应大于单个泵块');
  const src = {
    size: file.length,
    read: async (pos, want) => file.subarray(pos, Math.min(pos + want, file.length)),
  };
  const d = new FlvDemuxer(src);
  await d.open();
  assert.equal(d._sourceEof, false, 'open 后源未耗尽');
  const vs = [];
  for await (const s of d.samples(1)) vs.push(s);
  assert.equal(vs.length, 2400, '2400 帧全部经迭代器内泵推进消费');
  await d.destroy();
});

test('ChunkSource：readSample 无数据时挂起等待，写入后交付', async () => {
  const { d, sink } = makeChunkSink();
  sink.write(flvHeader());
  sink.write(aacSequenceTag(ASC, 0));
  await d.open(); // 音频序列头就绪
  const pending = d.readSample(2); // AUDIO_TRACK_ID，队列空 → waiter
  sink.write(aacRawTag(new Uint8Array([0x55]), 0));
  const s = await pending;
  assert.ok(s, 'waiter 被新样本唤醒');
  assert.equal(s.trackId, 2);
  await d.destroy();
});

/* ------------------------------ 旧式 push 与 start() ------------------------------ */

test('push：喂入垃圾字节 → 异常吞并为 error 事件', async () => {
  const d = new FlvDemuxer(new Uint8Array(0));
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.push(new Uint8Array(16).fill(0x09)); // idle 态触发 open（内部 catch），≥13 字节触发魔数校验
  await new Promise((r) => setImmediate(r));
  assert.ok(errs.some((e) => /魔数不匹配/.test(e.message)));
  d.destroy();
});

test('start()：pause 期间循环挂起不吐包，resume 后恢复直至 EOS', async () => {
  const { d, sink } = makeChunkSink();
  const samples = [];
  d.on('sample', ({ sample }) => samples.push(sample));
  sink.write(flvHeader());
  sink.write(aacSequenceTag(ASC, 0));
  await d.open();
  d.pause();
  d.start();
  await sleep(80); // ≥3 轮 25ms 暂停循环
  sink.write(aacRawTag(new Uint8Array([0x55]), 0));
  await sleep(10);
  assert.equal(samples.length, 0, '暂停期间不吐包');
  d.resume();
  await sleep(30);
  assert.equal(samples.length, 1, '恢复后交付样本');
  sink.end(); // EOS → start 任务退出
  await sleep(30);
  d.destroy();
});

/* ------------------------------ createFlvDemuxer 工厂 ------------------------------ */

function withFetch(stub, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: stub, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  });
}

test('createFlvDemuxer：fetch 网络失败 → PROBE_FAILED（无法连接）', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    await assert.rejects(() => createFlvDemuxer('http://x/f.flv'), (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.match(e.message, /无法连接/);
      return true;
    });
  });
});

test('createFlvDemuxer：HTTP 非 200 → PROBE_FAILED（HTTP 状态码）', async () => {
  await withFetch(async () => ({ ok: false, status: 404 }), async () => {
    await assert.rejects(() => createFlvDemuxer('http://x/f.flv'), (e) => {
      assert.equal(e.code, 'PROBE_FAILED');
      assert.match(e.message, /HTTP 404/);
      return true;
    });
  });
});

test('createFlvDemuxer：fetch 成功 → 全量缓冲后打开', async () => {
  const file = stdFile();
  await withFetch(async () => ({ ok: true, arrayBuffer: async () => file.buffer }), async () => {
    const d = await createFlvDemuxer('http://x/f.flv');
    assert.equal(d.mediaInfo.container, 'flv');
    assert.ok(d.mediaInfo.tracks.length >= 1);
    await d.destroy();
  });
});

test('createFlvDemuxer：Blob 源（sniff 走 slice/arrayBuffer）', async () => {
  const d = await createFlvDemuxer(new Blob([stdFile()]));
  assert.equal(d.mediaInfo.container, 'flv');
  await d.destroy();
});

test('createFlvDemuxer：DataSource 源（sniff 走 read）', async () => {
  const d = await createFlvDemuxer(new MemoryDataSource(stdFile()));
  assert.equal(d.mediaInfo.container, 'flv');
  await d.destroy();
});
