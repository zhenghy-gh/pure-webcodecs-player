/**
 * TsDemuxer 残余分支补测（128 波）：
 * 数据源归一化（Blob/非法）、_feed 与 engine error 转发、chunk 模式
 * 挂起等数据/readSample waiter、metadata 时长回填、_refreshMediaInfoTracks、
 * DataSource 泵失败三形态（无 PSI EOF/read 抛错/空读）、start() 暂停与错误捕获、
 * _doSeek 拒绝、getBufferedRanges、createTsDemuxer fetch/Blob/兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TsDemuxer, createTsDemuxer } from '../src/ts-demuxer.js';
import { assembleTs, dataToPackets, buildPes, h264Sps, h264Pps, h264IdrSlice, h264NonIdrSlice, annexb, adtsFrame } from './fixtures/build-ts.mjs';
import { VIDEO_PID, AUDIO_PID, concatBytes, makeProgram } from './ts-testkit.mjs';
import { MemoryDataSource } from '../../core/src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标准双轨流：H264(320x240,gop4)×8 帧 + AAC×6 帧 */
function stdFile() {
  return assembleTs({
    video: { codec: 'h264', width: 320, height: 240, frames: 8, gopSize: 4 },
    audio: { mode: 'adts', count: 6 },
  });
}

/** 视频 PES → TS 包序列 */
function videoPes(nalus, pts) {
  return dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(...nalus), { pts, dts: pts }));
}

/** withFetch：临时替换 globalThis.fetch，finally 还原 */
async function withFetch(mock, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: mock, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
  }
}

/* ------------------------------ 数据源归一化 ------------------------------ */

test('_normalizeSource：Blob → BlobDataSource 且可正常打开', async () => {
  const blob = new Blob([stdFile()], { type: 'video/mp2t' });
  const d = new TsDemuxer(blob);
  const info = await d.open();
  assert.equal(info.container, 'ts');
  assert.equal(info.tracks.length, 2);
  const s = await d.readSample(VIDEO_PID);
  assert.ok(s && s.data.byteLength > 0);
  await d.destroy();
});

test('_normalizeSource：无法识别的数据源 → STATE_ERROR', () => {
  assert.throws(
    () => new TsDemuxer(42),
    (e) => e.code === 'STATE_ERROR' && /无法识别的数据源/.test(e.message),
  );
});

/* ------------------------------ 错误转发 ------------------------------ */

test('_feed：引擎 push 抛错 → 转 error 事件且解析循环不打断', () => {
  const d = new TsDemuxer(null);
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d._feed(() => {
    throw new Error('engine exploded');
  });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'engine exploded');
});

test("engine 'error' 事件 → demuxer 'error' 透传", () => {
  const d = new TsDemuxer(null);
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.engine.emit('error', new Error('eng fault'));
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'eng fault');
});

/* ------------------------------ chunk 模式全流程 ------------------------------ */

test('chunk 模式：readSample 挂起等数据、tracks 刷新、end 后时长回填', async () => {
  const chunk = { write() {}, end() {} };
  const d = new TsDemuxer(chunk);
  const openP = d.open();
  // PAT/PMT + SPS/PPS（配置到位即可 openReady，无样本产出）
  chunk.write(
    concatBytes([
      ...makeProgram([{ streamType: 0x0f, pid: AUDIO_PID }]),
      ...videoPes([h264Sps(), h264Pps()], 90000),
    ]),
  );
  await openP;
  assert.equal(d.state, 'ready');

  // 参数集 PES 也按样本产出（open 喂入时已入队，readSample 立即返回）
  const sParam = await d.readSample(VIDEO_PID);
  assert.equal(sParam.index, 0);
  assert.ok(!sParam.keyframe);

  // 队列已空且非 datasource → 挂入 _waiters 等待新数据（405 分支）；
  // 引擎按 AU 边界惰性出样：IDR 由下一 PES 到达冲出
  const pending = d.readSample(VIDEO_PID);
  chunk.write(
    concatBytes([
      ...videoPes([h264IdrSlice()], 93000),
      ...videoPes([h264NonIdrSlice()], 96000),
    ]),
  );
  const sIdr = await pending;
  assert.equal(sIdr.index, 1);
  assert.ok(sIdr.keyframe);

  // 音频 PES → 引擎轨道补齐 → _refreshMediaInfoTracks 把新轨刷进 MediaInfo。
  // 引擎按 AU 边界惰性出样：需下一个音频 PES 到达才冲出前一个 AU（建立 ASC config）；
  // 第二个 PES 与首个同 DTS，不扩大全局 DTS 跨度（时长断言仍为 67000/66667）。
  chunk.write(
    concatBytes([
      ...dataToPackets(AUDIO_PID, buildPes(0xc0, adtsFrame(new Uint8Array(32)), { pts: 90000 })),
      ...dataToPackets(AUDIO_PID, buildPes(0xc0, adtsFrame(new Uint8Array(32)), { pts: 90000 })),
    ]),
  );
  const aTrack = d.mediaInfo.tracks.find((t) => t.id === AUDIO_PID);
  assert.ok(aTrack && aTrack.type === 'audio');
  assert.match(aTrack.codec, /^mp4a\.40\.\d+$/);

  // end → flush → metadata(durationMs=67) → MediaInfo 时长回填
  chunk.end();
  assert.equal(d.mediaInfo.durationUs, 67000); // dts 跨度 90000→96000 ticks @90k
  const vTrack = d.mediaInfo.tracks.find((t) => t.id === VIDEO_PID);
  assert.equal(vTrack.durationUs, 66667);

  // flush 冲出末个 AU（nonIdr），随后该轨 EOS
  const s2 = await d.readSample(VIDEO_PID);
  assert.equal(s2.index, 2);
  assert.ok(!s2.keyframe);
  assert.equal(await d.readSample(VIDEO_PID), null);
  await d.destroy();
});

/* ------------------------------ DataSource 泵失败形态 ------------------------------ */

test('泵：0x47 同步字节但无任何 PSI 直到 EOF → PARSE_ERROR', async () => {
  const packets = Array.from({ length: 10 }, () => mkNullPacket());
  const d = new TsDemuxer(new MemoryDataSource(concatBytes(packets)));
  await assert.rejects(
    d.open(),
    (e) => e.code === 'PARSE_ERROR' && /先于任何 PAT\/PMT 结束/.test(e.message),
  );
});

/** 188B null 包（0x47 头 + 0x1fff + 全零） */
function mkNullPacket() {
  const p = new Uint8Array(188);
  p[0] = 0x47;
  p[1] = 0x1f;
  p[2] = 0xff;
  return p;
}

test('泵：源 read 抛错 → 视为 EOF 收尾 → 同一 PARSE_ERROR 面', async () => {
  const src = { size: 1000, read: async () => { throw new Error('io down'); } };
  const d = new TsDemuxer(src);
  await assert.rejects(
    d.open(),
    (e) => e.code === 'PARSE_ERROR' && /先于任何 PAT\/PMT 结束/.test(e.message),
  );
});

test('泵：源返回空数据 → 视为 EOF 收尾 → 同一 PARSE_ERROR 面', async () => {
  const src = { size: 1000, read: async () => new Uint8Array(0) };
  const d = new TsDemuxer(src);
  await assert.rejects(
    d.open(),
    (e) => e.code === 'PARSE_ERROR' && /先于任何 PAT\/PMT 结束/.test(e.message),
  );
});

/* ------------------------------ start() 直播推送 ------------------------------ */

test('start()：pause 期间不吐样本，resume 后恢复', async () => {
  const d = await createTsDemuxer(stdFile());
  const events = [];
  d.on('sample', (x) => events.push(x));
  d.pause();
  d.start();
  await sleep(120);
  const frozen = events.length;
  await sleep(80);
  assert.equal(events.length, frozen); // 暂停期间挂起在 25ms 轮询，不吐样本
  d.resume();
  await sleep(400);
  assert.ok(events.length > frozen, `resume 后应恢复吐样本（${events.length} vs ${frozen}）`);
  await d.destroy();
});

test('start()：消费循环 readSample 抛错 → error 事件且不因 destroyed 吞并', async () => {
  const d = await createTsDemuxer(stdFile());
  const errs = [];
  d.on('error', (e) => errs.push(e));
  d.readSample = async () => {
    throw new Error('pump boom');
  };
  d.start();
  await sleep(60);
  assert.ok(errs.some((e) => /pump boom/.test(e.message)));
  await d.destroy();
});

/* ------------------------------ seek / buffered ------------------------------ */

test('_doSeek：无索引容器拒绝 seek；getBufferedRanges 恒空', async () => {
  const d = await createTsDemuxer(stdFile());
  await assert.rejects(
    TsDemuxer.prototype._doSeek.call(d, 1000),
    (e) => e.code === 'SEEK_UNSUPPORTED' && /不支持 seek/.test(e.message),
  );
  assert.deepEqual(d.getBufferedRanges(VIDEO_PID), []);
  await d.destroy();
});

test('createTsDemuxer：异步 DataSource size 用于限长 probe', async () => {
  const bytes = stdFile();
  const reads = [];
  const source = {
    size: Promise.resolve(bytes.byteLength),
    read: async (offset, length) => {
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
  };
  const demuxer = await createTsDemuxer(source);
  assert.ok(demuxer);
  assert.deepEqual(reads[0], [0, Math.min(4096, bytes.byteLength)]);
});

test('createTsDemuxer：异步 DataSource size 解析为非法值时拒绝', async () => {
  const source = { size: Promise.resolve(-1), read: async () => new Uint8Array(0) };
  await assert.rejects(() => createTsDemuxer(source), (error) => error.code === 'PROBE_FAILED');
});

/* ------------------------------ createTsDemuxer 工厂 ------------------------------ */

test('工厂：URL + fetch 成功路径全链', async () => {
  const bytes = stdFile();
  const d = await withFetch(
    async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
    () => createTsDemuxer('http://example.test/stream.ts'),
  );
  assert.equal(d.state, 'ready');
  assert.equal(d.mediaInfo.tracks.length, 2);
  await d.destroy();
});

test('工厂：fetch 非 2xx → PROBE_FAILED 携带状态码', async () => {
  await withFetch(
    async () => ({ ok: false, status: 404 }),
    () => assert.rejects(
      createTsDemuxer('http://example.test/missing.ts'),
      (e) => e.code === 'PROBE_FAILED' && /HTTP 404/.test(e.message),
    ),
  );
});

test('工厂：Blob 源 sniffBytes 走 slice().arrayBuffer() 路径', async () => {
  const d = await createTsDemuxer(new Blob([stdFile()]));
  assert.equal(d.state, 'ready');
  assert.equal(d.mediaInfo.tracks.length, 2);
  await d.destroy();
});

test('工厂：不可识别源 → sniffBytes 兜底空字节 → PROBE_FAILED', async () => {
  await assert.rejects(
    createTsDemuxer(42),
    (e) => e.code === 'PROBE_FAILED' && /probe 未命中/.test(e.message),
  );
});
