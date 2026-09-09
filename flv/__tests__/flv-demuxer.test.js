/**
 * FlvDemuxer 契约适配壳单测（CONTRACTS v0.2 §2.2 / §10 / §0.5 / §2.5-flv 行）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer, createFlvDemuxer } from '../src/flv-demuxer.js';
import * as Mod from '../src/index.js';
import { MemoryDataSource } from '../../core/src/index.js';

import {
  assembleFlv, buildAvcC, buildHvcC, defaultH264Sps, defaultH264Pps,
  hevcEnhancedSequenceTag, hevcEnhancedVideoTag, toAvcc,
} from './fixtures/build-flv.mjs';

function stdFile() {
  return assembleFlv({
    metadata: { duration: 0.3 },
    video: { frames: 8, gopSize: 4 },
    audio: { count: 6 },
  });
}

/* ------------------------------ §10 注册形状 ------------------------------ */

test('§10 导出形状：containerName/extensions/mimeTypes/probe/createDemuxer', () => {
  assert.equal(Mod.containerName, 'flv');
  assert.deepEqual(Mod.extensions, ['flv']);
  assert.ok(Mod.mimeTypes.every((m) => m.includes('flv')));
  assert.equal(typeof Mod.probe, 'function');
  assert.equal(typeof Mod.createDemuxer, 'function');
});

/* ------------------------------ static probe ------------------------------ */

test('probe：命中 ProbeResult；垃圾字节 null 且不抛异常', () => {
  const pr = FlvDemuxer.probe(stdFile().subarray(0, 64));
  assert.equal(pr.container, 'flv');
  assert.ok(pr.confidence >= 0.8);
  assert.equal(FlvDemuxer.probe(new Uint8Array(64).fill(1)), null);
  assert.equal(FlvDemuxer.probe(null), null);
});

/* ------------------------------ open / MediaInfo ------------------------------ */

test('open()：MediaInfo 形状（durationUs=onMetaData×1e6、seekable、轨道排序）', async () => {
  const d = await createFlvDemuxer(stdFile());
  assert.equal(d.state, 'ready');
  const mi = d.mediaInfo;
  assert.equal(mi.container, 'flv');
  assert.equal(mi.durationUs, 300_000);          // 0.3s → 300000µs
  assert.equal(mi.seekable, true);               // DataSource + 关键帧索引
  assert.equal(mi.live, false);
  assert.equal(mi.tracks[0].type, 'video');
  assert.equal(mi.tracks[1].type, 'audio');

  const [v, a] = mi.tracks;
  assert.match(v.codec, /^avc1\.[0-9A-F]{6}$/);  // core codec-string 生成
  assert.equal(v.bitstreamFormat, 'avc');         // AVCC 形态（契约字段）
  assert.ok(v.description instanceof Uint8Array); // avcC
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);

  assert.match(a.codec, /^mp4a\.40\.\d$/);
  assert.equal(a.sampleRate, 44100);
  assert.equal(a.numberOfChannels, 2);            // 定名字段（非 channelCount）
  assert.deepEqual([...a.description], [0x12, 0x10]);
  await d.destroy();
});

test('readSample：毫秒→微秒精确换算黄金值', async () => {
  const d = await createFlvDemuxer(stdFile());
  const s1 = await d.readSample(1);
  const s2 = await d.readSample(1);
  assert.equal(s1.timestamp, 0);            // 帧0 @0ms
  assert.equal(s2.timestamp, 33_000);       // 帧1 @33ms → 33000µs
  assert.equal(s2.keyframe, false);
  assert.equal(s2.codec, d.tracks[0].codec);
  assert.ok(s2.data instanceof Uint8Array);
  await d.destroy();
});

test('samples() 迭代至 EOS；EOS 后 readSample 为 null', async () => {
  const d = await createFlvDemuxer(stdFile());
  let n = 0;
  for await (const s of d.samples(1)) n++;
  assert.equal(n, 8);
  assert.equal(await d.readSample(1), null);
  let an = 0;
  for await (const s of d.samples(2)) an++;
  assert.equal(an, 6);
  await d.destroy();
});

test('Enhanced-FLV HEVC（FourCC hvc1）契约轨道', async () => {
  const vps = new Uint8Array([0x40, 0x01]);
  const sps = new Uint8Array([0x42, 0x01, 0xaa]);
  const pps = new Uint8Array([0x44, 0x01]);
  const head = stdFile().subarray(0, 13);   // 仅文件头
  const file = concatBytes([
    head,
    hevcEnhancedSequenceTag(buildHvcC(vps, sps, pps), 0),
    hevcEnhancedVideoTag(true, toAvcc([new Uint8Array([0x26, 1, 2, 3])]), 0),
    hevcEnhancedVideoTag(false, toAvcc([new Uint8Array([0x02, 1])]), 33),
  ]);
  const d = await createFlvDemuxer(new Uint8Array(file));
  const v = d.tracks.find((t) => t.type === 'video');
  assert.ok(v, '应识别出 HEVC 轨道');
  assert.match(v.codec, /^hvc1\.1\.[0-9A-F]+\.L93$/);
  assert.equal(v.bitstreamFormat, 'avc');
  const vs = [];
  for await (const s of d.samples(1)) vs.push(s);
  assert.deepEqual(vs.map((s) => s.keyframe), [true, false]);
  await d.destroy();
});

function concatBytes(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

/* ------------------------------ seek ------------------------------ */

test('seek：关键帧对齐并返回 actualTimestampUs；后续样本从关键帧继续', async () => {
  const d = await createFlvDemuxer(assembleFlv({ video: { frames: 12, gopSize: 4 }, audio: null }));
  // GOP=4 → 关键帧位于 0ms/132ms/264ms…
  const r = await d.seek(200_000);                 // 目标 200ms
  assert.equal(r.actualTimestampUs, 132_000);      // ≤目标最近关键帧
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 132_000);
  assert.equal(s.keyframe, true);
  await d.destroy();
});

test('seek：早于首关键帧时钳制到首关键帧', async () => {
  const d = await createFlvDemuxer(assembleFlv({ video: { frames: 8 } }));
  const r = await d.seek(1);
  assert.equal(r.actualTimestampUs, 0);
  await d.destroy();
});

test('ChunkSource 流式模式 seekable=false → SEEK_UNSUPPORTED', async () => {
  const file = stdFile();
  const sink = { write() {}, end() {} };
  const d = new FlvDemuxer(sink);
  setTimeout(() => {
    for (let o = 0; o < file.length; o += 400) sink.write(file.subarray(o, o + 400));
    sink.end();
  }, 5);
  await d.open();
  assert.equal(d.mediaInfo.seekable, false);
  await assert.rejects(() => d.seek(50_000), (e) => e.code === 'SEEK_UNSUPPORTED');
  await d.destroy();
});

/* ------------------------------ 生命周期 ------------------------------ */

test('未 open 调 readSample/samples → STATE_ERROR；destroy 幂等', async () => {
  const d = new FlvDemuxer(new MemoryDataSource(stdFile()));
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(
    async () => { for await (const s of d.samples(1)) void s; },
    (e) => e.code === 'STATE_ERROR',
  );

  const d2 = await createFlvDemuxer(stdFile());
  await d2.destroy();
  await d2.destroy();
  await assert.rejects(() => d2.readSample(1), (e) => e.code === 'STATE_ERROR');
});

test('parseInit() 为 open() 的过渡别名（§2.4）', async () => {
  const d = new FlvDemuxer(new MemoryDataSource(stdFile()));
  const info = await d.parseInit();
  assert.equal(info.container, 'flv');
  await d.destroy();
});

test('工厂：垃圾输入 reject PROBE_FAILED', async () => {
  await assert.rejects(
    () => createFlvDemuxer(new Uint8Array(4096).fill(7)),
    (e) => e.code === 'PROBE_FAILED',
  );
});

/* ------------------------------ 补充覆盖 ------------------------------ */

test('AMF0 onMetaData 黄金值：数值/布尔/字符串叶子完整保留', async () => {
  const file = assembleFlv({
    metadata: { duration: 1.5, width: 999, height: 999, videocodecid: 7, audiocodecid: 10, creator: 'pureplay' },
    video: { frames: 2 },
    audio: { count: 2 },
  });
  const d = await createFlvDemuxer(file);
  // 时长与字符串叶子按元数据承载；宽高以 SPS 解析为准（元数据仅参考）
  assert.equal(d.mediaInfo.durationUs, 1_500_000);
  assert.equal(d.tracks[0].width, 320);
  assert.equal(d.metadata.creator, 'pureplay');
  await d.destroy();
});

test('无 onMetaData 时 durationUs=null 且 seekable=false（纯音频流）', async () => {
  const { assembleFlv: asm } = await import('./fixtures/build-flv.mjs');
  const raw = asm({});   // 仅头，无任何 Tag
  const parts = [];
  // 追加最小音频序列头+一帧，但不带 script 标签 → 无 duration 元数据
  const { aacSequenceTag, aacRawTag } = await import('./fixtures/build-flv.mjs');
  const asc = Uint8Array.from([0x12, 0x10]);
  parts.push(asm({}).subarray(0, 13), aacSequenceTag(asc, 0), aacRawTag(new Uint8Array(16), 0));
  const d = await createFlvDemuxer(new Uint8Array(concatBytes(parts)));
  assert.equal(d.mediaInfo.durationUs, null);
  assert.equal(d.mediaInfo.seekable, false);
  assert.equal(d.tracks.length, 1);
  await d.destroy();
});

test('getBufferedRanges：可 seek 时返回 [0,duration] 区间', async () => {
  const d = await createFlvDemuxer(stdFile());
  assert.deepEqual(d.getBufferedRanges(1), [{ startUs: 0, endUs: 300_000 }]);
  await d.destroy();
});

/* ------------------------------ 直播推送模式 ------------------------------ */

test("start()+'sample' 推送：事件序列与 pull 一致", async () => {
  const file = assembleFlv({ video: { frames: 6 }, audio: null });
  const d = await createFlvDemuxer(file);
  const got = [];
  d.on('sample', ({ trackId, sample }) => got.push([trackId, sample.timestamp]));
  d.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 6);
  assert.deepEqual(got.map((g) => g[1]), [0, 33_000, 66_000, 99_000, 132_000, 165_000]);
  await d.destroy();
});

/* ------------------------------ 零参构造与 push/flush 兼容通道 ------------------------------ */

test('零参构造 + push/flush：旧式用法全链路可用', async () => {
  const d = new FlvDemuxer();
  const file = assembleFlv({ video: { frames: 3 }, audio: null });
  for (let off = 0; off < file.length; off += 64) d.push(file.subarray(off, Math.min(off + 64, file.length)));
  d.flush();
  await d.open().catch(() => {});
  let n = 0;
  for await (const s of d.samples(1)) n++;
  assert.equal(n, 3);
  await d.destroy();
});
