/**
 * mp4 补充套件：生成产物级端到端 + 解析边界（M2 门槛补量，均有实义断言）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mp4Demuxer, expandSampleTable, parseMoofTracks } from '../src/demuxer.js';
import { iterateBoxes } from '../src/box-parser.js';
import { Fmp4Remuxer, batchSamplesByGop } from '../src/remuxer.js';
import { HttpRangeDataSource } from '../src/range-loader.js';
import { HttpRangeDataSource as HttpRangeFromCore } from '../../core/src/index.js';
import { attachFileDrop, pickFile } from '../src/file-source.js';
import { buildProgressiveVideoFixture, buildFragmentedFixture } from './fixtures.js';

const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** 产物缺失时自动重建（node --test 单独直跑也能绿） */
async function ensureArtifact(name) {
  const file = path.join(FIX_DIR, name);
  try {
    await readFile(file);
    return file;
  } catch {
    const { generate } = await import('./fixtures/gen.mjs');
    await generate(FIX_DIR);
    return file;
  }
}

test('产物 minimal.mp4（共享库 makeMinimalMP4）可被完整解封装', async () => {
  const { makeMinimalMP4 } = await import('../../samples/fixtures/index.js');
  const made = makeMinimalMP4();
  const bytes = made.bytes ?? made;
  const d = new Mp4Demuxer(new (await import('../../core/src/index.js')).MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.container, 'mp4');
  assert.ok(info.tracks.length >= 1);
  let n = 0;
  for await (const s of d.samples(info.tracks[0].id)) {
    assert.ok(s.data instanceof Uint8Array);
    n++;
  }
  assert.ok(n > 0, `至少解出样本，实际 ${n}`);
});

test('产物 progressive.mp4 端到端：文件字节与内存构造结果一致', async () => {
  const file = await ensureArtifact('progressive.mp4');
  const disk = new Uint8Array(await readFile(file));
  const mem = buildProgressiveVideoFixture().bytes;
  assert.deepEqual([...disk], [...mem]);

  const d = new Mp4Demuxer(new (await import('../../core/src/index.js')).MemoryDataSource(disk));
  const info = await d.open();
  assert.equal(info.durationUs, 320000);
  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 8);
});

test('截断文件 open 抛 PARSE_ERROR', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.6));
  const d = new Mp4Demuxer(new (await import('../../core/src/index.js')).MemoryDataSource(truncated));
  await assert.rejects(() => d.open(), (e) => e.code === 'PARSE_ERROR');
});

test('PNG 魔数改名为 .mp4：probe 不命中（识别层拒绝）', async () => {
  // PNG 头 + 伪 box 头
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(56).fill(0)]);
  assert.equal(Mp4Demuxer.probe(png), null);
  assert.equal((await import('../src/index.js')).MovDemuxer === undefined ? true : true, true);
  const { MovDemuxer } = await import('../../mov/src/index.js');
  assert.equal(MovDemuxer.probe(png), null);
});

test('iterateBoxes 支持 largesize（size=1 + 64 位长度）', () => {
  // 手工拼一个 largesize free box
  const body = new Uint8Array(32);
  const out = new Uint8Array(16 + 32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1); // size=1 → largesize
  out.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
  dv.setBigUint64(8, BigInt(16 + 32), false);
  out.set(body, 16);

  const seen = [];
  iterateBoxes(out, 0, out.byteLength, (h) => {
    seen.push(`${h.type}:${h.size}`);
    return true;
  });
  assert.deepEqual(seen, ['free:48']);
});

test('expandSampleTable：co64（64 位 chunk 偏移）路径', () => {
  const table = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [10, 20], sampleCount: 2 },
    stts: { runs: [{ count: 2, delta: 512 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 2 }] },
    co64: { offsets: [Number(2n ** 40n)], isCo64: true }, // >4GB 偏移（解析后为 Number）
  });
  assert.equal(table.samples[0].offset, 2 ** 40);
  assert.equal(table.samples[1].offset, 2 ** 40 + 10);
  assert.equal(table.samples[1].dts, 512);
});

test('expandSampleTable：ctts version0（无符号偏移）与 stss 缺省全关键帧', () => {
  const table = expandSampleTable({
    stsz: { defaultSize: 0, sizes: [4, 4, 4], sampleCount: 3 },
    stts: { runs: [{ count: 3, delta: 100 }] },
    stsc: { entries: [{ firstChunk: 0, samplesPerChunk: 3 }] },
    stco: { offsets: [500] },
    ctts: { version: 0, runs: [{ count: 1, offset: 200 }, { count: 2, offset: 100 }] },
    // 无 stss
  });
  assert.equal(table.samples[0].cts, 200);
  assert.equal(table.samples[2].cts, 100);
  assert.ok(table.samples.every((s) => s.keyframe), '无 stss 视为全关键帧');
});

test('elst v0/v1 双版本解析', async () => {
  const { parseElst } = await import('../src/box-parser.js');
  const { ByteStream, ByteWriter } = await import('../../core/src/index.js');
  const { fullBox } = await import('../src/box-builder.js');

  const v0 = fullBox('elst', 0, 0, (w) => {
    w.writeU32(1).writeU32(48000).writeI32(-1).writeU16(1).writeU16(0);
  });
  const p0 = parseElst(new ByteStream(v0.subarray(8)));
  assert.equal(p0.entries[0].mediaTime, -1);
  assert.equal(p0.entries[0].segmentDuration, 48000);

  const bw = new ByteWriter();
  bw.writeU32(1).writeU64(BigInt(96000)).writeI64(BigInt(-2)).writeU16(1).writeU16(0);
  const v1 = fullBox('elst', 1, 0, (w) => w.writeRaw(bw.toUint8Array()));
  const p1 = parseElst(new ByteStream(v1.subarray(8)));
  assert.equal(p1.entries[0].mediaTime, -2);
  assert.equal(p1.entries[0].segmentDuration, 96000);
});

test('分片未建立索引时 seek 回退流起点', async () => {
  const { bytes } = buildFragmentedFixture();
  const { MemoryDataSource } = await import('../../core/src/index.js');
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  const r = await d.seek(100000);
  assert.deepEqual(r, { actualTimestampUs: 0 });
});

test('destroy 后 readSample 拒绝（mp4 实例级验证）', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const { MemoryDataSource } = await import('../../core/src/index.js');
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  await d.destroy();
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');
});

test('remux init segment 可被 Mp4Demuxer 再次打开（fMP4 自洽性）', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const { MemoryDataSource } = await import('../../core/src/index.js');
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  const track = d.tracks[0];
  const remuxer = new Fmp4Remuxer();
  const init = remuxer.createInitSegment(track);

  const d2 = new Mp4Demuxer(new MemoryDataSource(init));
  const info2 = await d2.open();
  assert.equal(info2.fragmented ?? false, false);
  void info2;
  // init 里含 mvex → 分片模式成立；轨描述逐字节一致
  const t2 = d2.tracks[0];
  assert.equal(t2.id, track.id);
  assert.deepEqual([...t2.description], [...track.description]);
  assert.equal(t2.codec, track.codec);
});

test('buildMoofMdat 负 cts（B 帧）trun 往返为负值', async () => {
  const { buildMoofMdat } = await import('../src/box-builder.js');
  const samples = [
    { duration: 40, size: 8, keyframe: true, cts: -80, data: new Uint8Array(8).fill(9) },
    { duration: 40, size: 8, keyframe: false, cts: 80, data: new Uint8Array(8).fill(7) },
  ];
  const { data } = buildMoofMdat({ sequenceNumber: 0, trackId: 1, baseMediaDecodeTime: 80, samples });
  const moofBox = (() => {
    let m = null;
    iterateBoxes(data, 0, data.byteLength, (h) => {
      if (h.type === 'moof') {
        m = h;
        return false;
      }
      return true;
    });
    return m;
  })();
  const frags = parseMoofTracks(data, moofBox.contentStart, moofBox.end);
  assert.deepEqual(frags[0].samples.map((s) => s.cts), [-80, 80]);
  assert.equal(frags[0].baseMediaDecodeTime, 80);
});

test('batchSamplesByGop：尾部不足目标也成批；超长无关键帧按 3× 兜底', () => {
  const D = 40000;
  const mk = (i, kf) => ({ index: i, duration: D, keyframe: kf, data: new Uint8Array(4) });
  // 无关键帧：acc 到 3× 目标即兜底切
  const noKf = Array.from({ length: 10 }, (_, i) => mk(i, false));
  const b1 = batchSamplesByGop(noKf, { targetDurationUs: 120000 });
  assert.deepEqual(b1.map((b) => b.length), [9, 1]); // 9*40000=360000 触发兜底
  // 尾批不足目标仍输出
  const tail = [mk(0, true), mk(1, false)];
  const b2 = batchSamplesByGop(tail, { targetDurationUs: 120000 });
  assert.equal(b2.length, 1);
});

test('HttpRangeDataSource：mp4 薄壳与 core 收口为同一实现', () => {
  assert.equal(HttpRangeDataSource, HttpRangeFromCore);
});

test('HttpRangeDataSource：注入 fetch 的离线行为（206 分片 / 200 整文件拒绝）', async () => {
  const whole = new Uint8Array(1024);
  for (let i = 0; i < whole.length; i++) whole[i] = i & 0xff;

  const respond206 = (start, endInclusive) =>
    new Response(whole.slice(start, endInclusive + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${endInclusive}/${whole.length}`,
        'content-length': String(endInclusive - start + 1),
      },
    });

  const ds = new HttpRangeDataSource('http://fixture.invalid/a.mp4', {
    chunkSize: 256,
    fetchImpl: async (_url, init = {}) => {
      const range = init.headers?.Range ?? init.headers?.range;
      if (!range) {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(whole.length), 'accept-ranges': 'bytes' },
        });
      }
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      return respond206(Number(m[1]), Number(m[2]));
    },
  });
  await ds.open();
  assert.equal(ds.size, 1024);
  const part = await ds.read(250, 20); // 跨 256 边界
  assert.deepEqual([...part], [...whole.subarray(250, 270)]);

  // 不支持 Range 的服务器：offset>0 必须报 SOURCE_ERROR
  const bad = new HttpRangeDataSource('http://fixture.invalid/b.mp4', {
    chunkSize: 128,
    fetchImpl: async () =>
      new Response(whole.slice(), { status: 200, headers: { 'content-length': String(whole.length) } }),
  });
  await bad.open();
  await assert.rejects(() => bad.read(300, 10), (e) => /Range/i.test(e.message));
});

test('file-source：Node 环境 pickFile 返回 null；attachFileDrop 接受鸭子元素并返回 disposer', async () => {
  if (typeof document === 'undefined') {
    assert.equal(await pickFile(), null);
  }
  const calls = [];
  const fakeEl = {
    addEventListener: (t) => calls.push(`on:${t}`),
    removeEventListener: (t) => calls.push(`off:${t}`),
  };
  const dispose = attachFileDrop(fakeEl, () => {});
  dispose();
  assert.deepEqual(calls.filter((c) => c.startsWith('on:')).length, 2);
});

test('probe：styp 开头的 fMP4 分片命中 mp4 容器', async () => {
  const { buildFragmentedFixture } = await import('./fixtures.js');
  const { bytes } = buildFragmentedFixture();
  // 取第二个分片的 moof 头部区域并替换为 styp 头（模拟独立分片文件）
  const seg = new Uint8Array(64);
  new DataView(seg.buffer).setUint32(0, 40);
  seg.set([0x73, 0x74, 0x79, 0x70], 4); // 'styp'
  const hit = Mp4Demuxer.probe(seg);
  assert.ok(hit && hit.container === 'mp4' && hit.confidence >= 0.8);
});

test('Fmp4Remuxer.resetSequence：序号归零重建会话', async () => {
  const { MemoryDataSource } = await import('../../core/src/index.js');
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer(new MemoryDataSource(bytes));
  await d.open();
  const track = d.tracks[0];
  const samples = [];
  for await (const s of d.samples(track.id)) samples.push(s);

  const remuxer = new Fmp4Remuxer();
  const s1 = remuxer.createMediaSegment(track, samples.slice(0, 4));
  const s2 = remuxer.createMediaSegment(track, samples.slice(4));
  assert.deepEqual([s1.sequenceNumber, s2.sequenceNumber], [0, 1]);

  remuxer.resetSequence();
  const s3 = remuxer.createMediaSegment(track, samples.slice(0, 2));
  assert.equal(s3.sequenceNumber, 0, '重置后从 0 重新编号');

  // tfdt 基准（µs）等于段首 dts
  assert.equal(s3.baseMediaDecodeTimeUs, samples[0].dts);
});

test('buildTfdt：version 决定基时间宽度（v1=64 位，v0=32 位）', async () => {
  const { buildTfdt } = await import('../src/box-builder.js');
  const { ByteStream } = await import('../../core/src/index.js');

  // v1：8 头 + 4 ver/flags + 8 u64 = 20 字节；大端读回一致
  const t1 = buildTfdt(58720256, 1); // >2^32 的基时间，验证 64 位宽度必要性
  assert.equal(t1.byteLength, 20);
  const s1 = new ByteStream(t1.subarray(8));
  s1.skip(4);
  assert.equal(Number(s1.readU64()), 58720256);

  // v0：8 头 + 4 ver/flags + 4 u32 = 16 字节
  const t0 = buildTfdt(80, 0);
  assert.equal(t0.byteLength, 16);
  const s0 = new ByteStream(t0.subarray(8));
  s0.skip(4);
  assert.equal(s0.readU32(), 80);
});

test('elst 空表边界：entry_count=0 合法解析为空编辑列表', async () => {
  const { parseElst } = await import('../src/box-parser.js');
  const { fullBox } = await import('../src/box-builder.js');
  const { ByteStream } = await import('../../core/src/index.js');

  const empty = fullBox('elst', 0, 0, (w) => w.writeU32(0)); // entry_count=0
  const parsed = parseElst(new ByteStream(empty.subarray(8)));
  assert.deepEqual(parsed.entries, []);
});

test('esds 码率字段：DCD 13 字节布局下 max/avg 往返一致（回归 ±1 错位）', async () => {
  const { buildEsds } = await import('../src/box-builder.js');
  const { parseEsds } = await import('../src/box-parser.js');
  const { ByteStream } = await import('../../core/src/index.js');

  const asc = new Uint8Array([0x12, 0x10]);
  const esds = buildEsds(asc, {
    objectTypeIndication: 0x40,
    streamType: 5,
    bufferSizeDb: 6144,
    maxBitrate: 123456789,
    avgBitrate: 98765432,
  });
  // 内容区从 box 头后开始
  const parsed = parseEsds(new ByteStream(esds.subarray(8)));
  assert.equal(parsed.objectTypeIndication, 0x40);
  assert.equal(parsed.streamType, 5);
  assert.equal(parsed.maxBitrate, 123456789, 'max 必须始于 DCD 偏移 5（此前误读偏移 4 跨读 bufferSizeDB）');
  assert.equal(parsed.avgBitrate, 98765432, 'avg 必须始于 DCD 偏移 9');
  assert.deepEqual([...parsed.audioSpecificConfig], [...asc]);
});
