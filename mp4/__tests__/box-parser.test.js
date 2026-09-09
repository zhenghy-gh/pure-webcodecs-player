import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteStream } from '../../core/src/index.js';
import {
  iterateBoxes,
  parseMoov,
  parseFtyp,
} from '../src/box-parser.js';
import { parseMoofTracks } from '../src/demuxer.js';
import {
  buildProgressiveVideoFixture,
  buildFragmentedFixture,
} from './fixtures.js';

function findBox(bytes, type) {
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

test('渐进 fixture：顶层结构 ftyp+moov+mdat', () => {
  const { bytes } = buildProgressiveVideoFixture();
  const types = [];
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    types.push(h.type);
    return true;
  });
  assert.deepEqual(types, ['ftyp', 'moov', 'mdat']);
});

test('ftyp 解析品牌', () => {
  const { bytes } = buildProgressiveVideoFixture();
  const box = findBox(bytes, 'ftyp');
  const ftyp = parseFtyp(new ByteStream(bytes, box.contentStart, box.end - box.contentStart));
  assert.equal(ftyp.majorBrand, 'isom');
  assert.deepEqual(ftyp.compatible.slice(0, 2), ['isom', 'iso2']);
});

test('parseMoov 完整结构树（tkhd/mdhd/hdlr/stbl/sample entry）', () => {
  const { bytes, avcC } = buildProgressiveVideoFixture();
  const moovBox = findBox(bytes, 'moov');
  const moov = parseMoov(bytes.subarray(moovBox.start, moovBox.end));

  assert.equal(moov.mvhd.timescale, 1000);
  assert.equal(moov.mvhd.duration, 320);
  assert.equal(moov.traks.length, 1);

  const trak = moov.traks[0];
  assert.equal(trak.tkhd.trackId, 1);
  assert.equal(trak.tkhd.width, 320);
  assert.equal(trak.tkhd.height, 240);
  assert.equal(trak.tkhd.enabled, true);

  assert.equal(trak.mdhd.timescale, 1000);
  assert.equal(trak.mdhd.language, 'und');
  assert.equal(trak.hdlr.handlerType, 'vide');

  // stbl 表
  assert.deepEqual(trak.stbl.stts.runs, [{ count: 8, delta: 40 }]);
  assert.equal(trak.stbl.stsz.sizes.length, 8);
  assert.equal(trak.stbl.stsc.entries.length, 1);
  assert.equal(trak.stbl.stco.offsets.length, 4);
  assert.deepEqual(trak.stbl.stss.indices, [0, 4]);
  assert.equal(trak.stbl.ctts.version, 1); // 有符号版本
  assert.ok(trak.stbl.ctts.runs.some((r) => r.offset < 0));

  // sample entry 与解码配置
  const entry = trak.sampleEntry;
  assert.equal(entry.type, 'avc1');
  assert.equal(entry.width, 320);
  assert.equal(entry.height, 240);
  assert.deepEqual([...entry.avcC.bytes], [...avcC]);
});

test('损坏 box 尺寸抛 PARSE_ERROR', () => {
  const bad = new Uint8Array(16);
  const dv = new DataView(bad.buffer);
  dv.setUint32(0, 9999); // size 超界
  bad.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  assert.throws(() => iterateBoxes(bad, 0, 16, () => {}), (e) => e.code === 'PARSE_ERROR');
});

/* ------------------------------ 分片侧 ------------------------------ */

test('分片 fixture 的 moof/trun 解析', async () => {
  const { bytes, expectedSamples } = buildFragmentedFixture();
  const boxes = [];
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => boxes.push(h));
  const moofs = boxes.filter((b) => b.type === 'moof');
  assert.equal(moofs.length, 2);

  let sampleCursor = 0;
  for (const m of moofs) {
    const frags = parseMoofTracks(bytes, m.contentStart, m.end);
    assert.equal(frags.length, 1);
    const frag = frags[0];
    assert.equal(frag.trackId, 1);
    const batch = expectedSamples.slice(sampleCursor, sampleCursor + frag.samples.length);
    assert.equal(frag.baseMediaDecodeTime, batch[0].dts);
    frag.samples.forEach((rec, i) => {
      assert.equal(rec.duration, batch[i].duration);
      assert.equal(rec.size, batch[i].size);
      assert.equal(rec.cts, 0);
    });
    sampleCursor += frag.samples.length;
  }
  assert.equal(sampleCursor, expectedSamples.length);
});
