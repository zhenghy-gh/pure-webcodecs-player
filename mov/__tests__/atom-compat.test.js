import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeQuickTime,
  listTopLevelAtoms,
  detectCompressedMoov,
  parseUdtaTags,
  interpretEdits,
} from '../src/atom-compat.js';
import { iterateBoxes } from '../../mp4/src/box-parser.js';
import { MovDemuxer } from '../src/demuxer.js';
import { Mp4Demuxer } from '../../mp4/src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { buildProgressiveVideoFixture } from '../../mp4/__tests__/fixtures.js';
import {
  buildQuickTimeMovFixture,
  buildCompressedMovFixture,
} from './fixtures.js';

test('looksLikeQuickTime：品牌与 wide 特征', () => {
  const { bytes } = buildQuickTimeMovFixture();
  assert.equal(looksLikeQuickTime(bytes.subarray(0, 64)), true);
  const { bytes: cmovBytes } = buildCompressedMovFixture();
  assert.equal(looksLikeQuickTime(cmovBytes), true);

  const { bytes: isomBytes } = buildProgressiveVideoFixture();
  assert.equal(looksLikeQuickTime(isomBytes), false);
});

test('顶层 atom 序列：ftyp+wide+moov+mdat', () => {
  const { bytes } = buildQuickTimeMovFixture();
  assert.deepEqual(listTopLevelAtoms(bytes), ['ftyp', 'wide', 'moov', 'mdat']);
});

test('probe 打分：mov 对 QT 文件胜出，mp4 对 isom 文件胜出', () => {
  const { bytes: qt } = buildQuickTimeMovFixture();
  const head = qt.subarray(0, 64);
  const movHit = MovDemuxer.probe(head);
  const mp4OnQt = Mp4Demuxer.probe(head);
  assert.ok(movHit && movHit.container === 'mov' && movHit.confidence >= 0.8);
  assert.ok(mp4OnQt === null || movHit.confidence > mp4OnQt.confidence, 'QT 文件应由 MovDemuxer 接管');

  const { bytes: isom } = buildProgressiveVideoFixture();
  const isomHead = isom.subarray(0, 64);
  const mp4Hit = Mp4Demuxer.probe(isomHead);
  const movOnIsom = MovDemuxer.probe(isomHead);
  assert.ok(mp4Hit && mp4Hit.confidence >= 0.8);
  assert.ok(movOnIsom === null || mp4Hit.confidence > movOnIsom.confidence, 'isom 文件应由 Mp4Demuxer 接管');
});

function findMoov(bytes) {
  let found = null;
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    if (h.type === 'moov') {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

test('detectCompressedMoov：识别 cmov 与 dcom=zlib', () => {
  const { bytes } = buildCompressedMovFixture();
  const moovBox = findMoov(bytes);
  assert.ok(moovBox);
  const result = detectCompressedMoov(bytes.subarray(moovBox.start, moovBox.end));
  assert.equal(result.compressed, true);
  assert.equal(result.vendor, 'zlib');

  // 正常 moov 不误报
  const { bytes: qtBytes } = buildQuickTimeMovFixture();
  const normal = findMoov(qtBytes);
  assert.equal(detectCompressedMoov(qtBytes.subarray(normal.start, normal.end)).compressed, false);
});

test('parseUdtaTags：QT 风格 meta 提取 ©nam/©ART', () => {
  const { bytes, expectedTags } = buildQuickTimeMovFixture();
  const moovBox = findMoov(bytes);
  const tags = parseUdtaTags(bytes.subarray(moovBox.start, moovBox.end));
  assert.deepEqual(tags, expectedTags);
});

test('interpretEdits：空编辑与媒体起点秒换算', () => {
  const edits = interpretEdits(
    { entries: [{ segmentDuration: 120, mediaTime: -1 }, { segmentDuration: 120, mediaTime: 100 }] },
    600,
  );
  assert.equal(edits.hasEmptyEdit, true);
  assert.ok(Math.abs(edits.firstMediaTimeSec - 100 / 600) < 1e-9);

  const none = interpretEdits(null, 600);
  assert.deepEqual(none, { hasEmptyEdit: false, firstMediaTimeSec: null });
});

/* ------------------------------ MovDemuxer ------------------------------ */

test('MovDemuxer init：container/qt 标签/三轨类型', async () => {
  const { bytes, expectedTags } = buildQuickTimeMovFixture();
  const d = new MovDemuxer();
  d.attach(new MemoryDataSource(bytes));
  const info = await d.init();

  assert.equal(info.container, 'mov');
  assert.deepEqual(info.brands.majorBrand, 'qt  ');
  assert.deepEqual(info.qtTags, expectedTags);

  assert.equal(info.tracks.length, 3);
  const [video, audio, tmcd] = info.tracks;
  assert.equal(video.type, 'video');
  assert.equal(video.codec.startsWith('avc1.'), true);
  assert.equal(video.width, 320);

  assert.equal(audio.type, 'audio');
  assert.equal(audio.codec, 'mp4a.40.2');
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.channelCount, 2);
  assert.deepEqual([...audio.codecPrivate], [0x12, 0x10], 'AudioSpecificConfig 原样透出');

  assert.equal(tmcd.type, 'metadata');
  assert.equal(tmcd.codec, 'tmcd');
});

test('MovDemuxer：elst 空编辑暴露到 Track', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  const d = new MovDemuxer();
  d.attach(new MemoryDataSource(bytes));
  const info = await d.init();
  const video = info.tracks[0];
  assert.equal(video.emptyEdit, true);
  assert.equal(video.mediaTimeSec, 0); // 第二条编辑 mediaTime=0
});

const QT_TS = 600;
const toUs = (ticks) => Math.round((ticks * 1e6) / QT_TS);

test('MovDemuxer 视频样本迭代与 seek（复用 mp4 能力，µs 边界）', async () => {
  const { bytes, videoPayloads, expectedSamples } = buildQuickTimeMovFixture();
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();

  const samples = [];
  for await (const s of d.samples(1)) samples.push(s);
  assert.equal(samples.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(samples[i].dts, toUs(expectedSamples[i].dts), `dts µs #${i}`);
    assert.equal(samples[i].timestamp, toUs(expectedSamples[i].pts), `pts µs #${i}`);
    assert.equal(samples[i].duration, toUs(expectedSamples[i].duration));
    assert.equal(samples[i].codec, samples[0].codec, 'Sample.codec 恒等于轨 codec');
    assert.equal(samples[i].keyframe, expectedSamples[i].keyframe);
    assert.deepEqual([...samples[i].data], [...videoPayloads[i]]);
  }

  // seek(250000µs)：目标 150 ticks；关键帧 dts 0 与 120 ticks → 落点 #3（200000µs）
  const r = await d.seek(250000);
  assert.deepEqual(r, { actualTimestampUs: toUs(120) });
});

test('cmov 文件：init 拒绝并给出可操作提示', async () => {
  const { bytes } = buildCompressedMovFixture();
  const d = new MovDemuxer();
  d.attach(new MemoryDataSource(bytes));
  await assert.rejects(
    () => d.init(),
    (e) => e.code === 'NOT_SUPPORTED' && /cmov/.test(e.message) && /ffmpeg/.test(e.message),
  );
});
