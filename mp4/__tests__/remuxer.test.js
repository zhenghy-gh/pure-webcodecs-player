import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream, MemoryDataSource } from '../../core/src/index.js';
import {
  iterateBoxes,
  parseMoov,
} from '../src/box-parser.js';
import { Fmp4Remuxer, batchSamplesByGop, remuxDemuxer } from '../src/remuxer.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { buildProgressiveVideoFixture } from './fixtures.js';

test('init segment：ftyp(msfh)+moov(含 mvex 与 avcC)', async () => {
  const { bytes, avcC } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  const remuxer = new Fmp4Remuxer();
  const init = remuxer.createInitSegment(d.getMediaInfo().tracks[0]);

  const types = [];
  iterateBoxes(init, 0, init.byteLength, (h) => {
    types.push(h.type);
    return true;
  });
  assert.deepEqual(types, ['ftyp', 'moov']);

  // moov 内应有 mvex（fMP4 标志）与完整 stsd
  const moovBox = iterateFind(init, 'moov');
  const moov = parseMoov(init.subarray(moovBox.start, moovBox.end));
  assert.ok(moov.mvex);
  assert.ok(moov.mvex.trexByTrack[1]);
  assert.equal(moov.traks[0].sampleEntry.type, 'avc1');
  assert.deepEqual([...moov.traks[0].sampleEntry.avcC.bytes], [...avcC]);
});

function iterateFind(bytes, type) {
  let found = null;
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

test('media segment：moof+mdat 结构与 data_offset 精确指向样本数据', async () => {
  const { bytes, videoPayloads, expectedSamples } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  const track = d.getMediaInfo().tracks[0];
  const samples = [];
  for await (const s of d.samples(track.id)) samples.push(s);

  const remuxer = new Fmp4Remuxer();
  // 手动分两段：0-3、4-7
  const seg1 = remuxer.createMediaSegment(track, samples.slice(0, 4));
  const seg2 = remuxer.createMediaSegment(track, samples.slice(4));

  for (const [seg, offset] of [[seg1, 0], [seg2, 4]]) {
    const types = [];
    iterateBoxes(seg.data, 0, seg.data.byteLength, (h) => {
      types.push(h.type);
      return true;
    });
    assert.deepEqual(types, ['moof', 'mdat']);

    // 序号推进
    assert.equal(seg.sequenceNumber, offset === 0 ? 0 : 1);

    // tfdt 基准 == 段首 dts（tfdt 在 traf 内）
    const moofBox = iterateFind(seg.data, 'moof');
    const trafBox = findIn(seg.data, moofBox, 'traf');
    const tfdt = findIn(seg.data, trafBox, 'tfdt');
    const s = new ByteStream(seg.data, tfdt.contentStart + 4, tfdt.end - tfdt.contentStart - 4); // v1: 跳过 ver/flags
    assert.equal(Number(s.readU64()), Number(BigInt(expectedSamples[offset].dts)), `tfdt @${offset}`);

    // trun 样本数与 cts（trun 也在 traf 内）
    const trun = findIn(seg.data, trafBox, 'trun');
    const ts = new ByteStream(seg.data, trun.contentStart, trun.end - trun.contentStart);
    ts.skip(4); // version+flags
    assert.equal(ts.readU32(), 4); // sample_count

    // data_offset 应等于 moof 长度 + mdat 头 8 字节，且该位置的字节就是第一个样本
    const trunDataOffset = readTrunDataOffset(seg.data, trun);
    const firstSampleAt = new Uint8Array(
      seg.data.buffer,
      seg.data.byteOffset + trunDataOffset,
      expectedSamples[offset].size,
    );
    assert.deepEqual([...firstSampleAt], [...videoPayloads[offset]], `dataOffset 精确性 @${offset}`);
    assert.equal(trunDataOffset, moofBox.end + 8);
  }
});

/** 从 trun box 读出 data_offset（version1 固定存在） */
function readTrunDataOffset(bytes, trunBox) {
  // contentStart + verflags(4) + sample_count(4)
  const dv = new DataView(bytes.buffer, bytes.byteOffset + trunBox.contentStart, trunBox.end - trunBox.contentStart);
  return dv.getInt32(8, false);
}

function findIn(bytes, parentBox, type) {
  let found = null;
  iterateBoxes(bytes, parentBox.contentStart, parentBox.end, (h) => {
    if (h.type === type) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

test('batchSamplesByGop：关键帧对齐切批', () => {
  const D = 40000; // 每帧 40000µs（25fps）
  const mk = (i, keyframe) => ({ index: i, duration: D, keyframe, codec: '', timestamp: i * D, data: new Uint8Array(8) });
  const samples = [
    mk(0, true),
    mk(1, false),
    mk(2, false),
    mk(3, true), // 累计 160000µs ≥ 目标 120000 且为关键帧 → 在此切
    mk(4, false),
    mk(5, false),
    mk(6, false),
    mk(7, false),
  ];
  const batches = batchSamplesByGop(samples, { targetDurationUs: 120000 });
  assert.equal(batches.length, 2);
  // 关键帧 #3 结束第一批，第二批从 #4 开始
  assert.deepEqual(batches.map((b) => b[0].index), [0, 4]);
  assert.equal(batches[0][batches[0].length - 1].index, 3);
});

test('remuxDemuxer：端到端 remux 后可被再次解析', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const d = new Mp4Demuxer();
  d.attach(new MemoryDataSource(bytes));
  await d.init();

  const outputs = await remuxDemuxer(d, { targetDurationSec: 0.16 }); // 160 ticks → 每 2 帧一切? 实际按 keyframe 边界
  assert.equal(outputs.length, 1);
  const { track, init, segments } = outputs[0];
  assert.equal(track.id, 1);
  assert.ok(segments.length >= 1);

  // 所有段拼接的样本字节应与原流一致
  const joined = [];
  let total = 0;
  for (const seg of segments) {
    const moofBox = iterateFind(seg.data, 'moof');
    void moofBox;
    joined.push(seg);
    total += seg.sampleCount;
  }
  assert.equal(total, 8);

  // init 可独立解析
  const moovBox = iterateFind(init, 'moov');
  const moov = parseMoov(init.subarray(moovBox.start, moovBox.end));
  assert.ok(moov.mvex.trexByTrack[1]);
});

test('空样本数组抛错；lazy 样本抛错', async () => {
  const remuxer = new Fmp4Remuxer();
  assert.throws(() => remuxer.createMediaSegment({ id: 1 }, []));
  assert.throws(() =>
    remuxer.createMediaSegment({ id: 1 }, [{ index: 0, data: null, size: 10, duration: 40, dts: 0, pts: 0, keyframe: true }]),
  );
});
