import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource } from '../../core/src/index.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { iterateBoxes } from '../src/box-parser.js';
import { buildFragmentedFixture } from './fixtures.js';
import { box, buildMdat, buildMfhd, buildTfdt, fullBox } from '../src/box-builder.js';

function findBoxes(bytes, start, end, type) {
  const found = [];
  iterateBoxes(bytes, start, end, (header) => {
    if (header.type === type) found.push(header);
  });
  return found;
}

function makeFragmentedFixture({ samples, tfhdDefaults = {}, trexDefaults = {}, firstSampleFlags, perSampleFields = 0x0300 }) {
  const { bytes: base } = buildFragmentedFixture();
  const firstMoof = findBoxes(base, 0, base.byteLength, 'moof')[0];
  const init = base.slice(0, firstMoof.start);
  const moov = findBoxes(init, 0, init.byteLength, 'moov')[0];
  const mvex = findBoxes(init, moov.contentStart, moov.end, 'mvex')[0];
  const trex = findBoxes(init, mvex.contentStart, mvex.end, 'trex')[0];
  const initView = new DataView(init.buffer, init.byteOffset, init.byteLength);
  if (trexDefaults.defaultSampleDuration !== undefined) initView.setUint32(trex.contentStart + 12, trexDefaults.defaultSampleDuration, false);
  if (trexDefaults.defaultSampleSize !== undefined) initView.setUint32(trex.contentStart + 16, trexDefaults.defaultSampleSize, false);
  if (trexDefaults.defaultSampleFlags !== undefined) initView.setUint32(trex.contentStart + 20, trexDefaults.defaultSampleFlags, false);

  const tfhdFlags = 0x020000 |
    (tfhdDefaults.defaultSampleDuration === undefined ? 0 : 0x000008) |
    (tfhdDefaults.defaultSampleSize === undefined ? 0 : 0x000010) |
    (tfhdDefaults.defaultSampleFlags === undefined ? 0 : 0x000020);
  const makeMoof = (dataOffset) => box('moof', (w) => {
    w.writeRaw(buildMfhd(0));
    w.writeRaw(box('traf', (tw) => {
      tw.writeRaw(fullBox('tfhd', 0, tfhdFlags, (fw) => {
        fw.writeU32(1);
        if (tfhdFlags & 0x000008) fw.writeU32(tfhdDefaults.defaultSampleDuration);
        if (tfhdFlags & 0x000010) fw.writeU32(tfhdDefaults.defaultSampleSize);
        if (tfhdFlags & 0x000020) fw.writeU32(tfhdDefaults.defaultSampleFlags);
      }));
      tw.writeRaw(buildTfdt(0));
      const flags = 0x000001 | (firstSampleFlags === undefined ? 0 : 0x000004) | perSampleFields;
      tw.writeRaw(fullBox('trun', 0, flags, (rw) => {
        rw.writeU32(samples.length);
        rw.writeI32(dataOffset);
        if (firstSampleFlags !== undefined) rw.writeU32(firstSampleFlags);
        for (const sample of samples) {
          if (perSampleFields & 0x000100) rw.writeU32(sample.duration);
          if (perSampleFields & 0x000200) rw.writeU32(sample.size);
          if (perSampleFields & 0x000400) rw.writeU32(sample.flags);
          if (perSampleFields & 0x000800) rw.writeI32(sample.cts ?? 0);
        }
      }));
    }));
  });
  const moof = makeMoof(0);
  const finalMoof = makeMoof(moof.byteLength + 8);
  const payloads = samples.map((sample) => sample.data);
  const mdat = buildMdat(payloads);
  const bytes = new Uint8Array(init.byteLength + finalMoof.byteLength + mdat.byteLength);
  bytes.set(init, 0);
  bytes.set(finalMoof, init.byteLength);
  bytes.set(mdat, init.byteLength + finalMoof.byteLength);
  return bytes;
}

async function readSamples(bytes) {
  const demuxer = new Mp4Demuxer(new MemoryDataSource(bytes));
  await demuxer.open();
  const samples = [];
  for (;;) {
    const sample = await demuxer.readSample(1);
    if (!sample) break;
    samples.push(sample);
  }
  await demuxer.destroy();
  return samples;
}

test('fragment sample_is_non_sync_sample bit marks samples non-key even with unspecified dependency', async () => {
  const data = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const bytes = makeFragmentedFixture({
    samples: data.map((payload, i) => ({ duration: 40, size: payload.length, flags: i === 0 ? 0x02000000 : 0x00010000, data: payload })),
    perSampleFields: 0x0300 | 0x0400,
  });
  const samples = await readSamples(bytes);
  assert.deepEqual(samples.map((sample) => sample.keyframe), [true, false]);
});

test('trun first_sample_flags override track defaults for the first sample only', async () => {
  const data = [new Uint8Array([5, 6]), new Uint8Array([7, 8])];
  const bytes = makeFragmentedFixture({
    samples: data.map((payload) => ({ duration: 40, size: payload.length, data: payload })),
    firstSampleFlags: 0x00010000,
    perSampleFields: 0x0300,
  });
  const samples = await readSamples(bytes);
  assert.deepEqual(samples.map((sample) => sample.keyframe), [false, true]);
});

test('sample size, duration and flags inherit tfhd defaults before trex defaults', async () => {
  const data = [new Uint8Array([11, 12]), new Uint8Array([13, 14])];
  const bytes = makeFragmentedFixture({
    samples: data.map((payload) => ({ data: payload })),
    tfhdDefaults: { defaultSampleDuration: 20, defaultSampleSize: 2, defaultSampleFlags: 0x00010000 },
    trexDefaults: { defaultSampleDuration: 40, defaultSampleSize: 4, defaultSampleFlags: 0 },
    perSampleFields: 0,
  });
  const samples = await readSamples(bytes);
  assert.deepEqual(samples.map((sample) => sample.duration), [20_000, 20_000]);
  assert.deepEqual(samples.map((sample) => sample.size), [2, 2]);
  assert.deepEqual(samples.map((sample) => sample.keyframe), [false, false]);
  assert.deepEqual(samples.map((sample) => [...sample.data]), data.map((payload) => [...payload]));
});

test('sample defaults fall back to trex when tfhd and trun omit them', async () => {
  const data = [new Uint8Array([21, 22, 23]), new Uint8Array([24, 25, 26])];
  const bytes = makeFragmentedFixture({
    samples: data.map((payload) => ({ data: payload })),
    trexDefaults: { defaultSampleDuration: 30, defaultSampleSize: 3, defaultSampleFlags: 0x00010000 },
    perSampleFields: 0,
  });
  const samples = await readSamples(bytes);
  assert.deepEqual(samples.map((sample) => sample.duration), [30_000, 30_000]);
  assert.deepEqual(samples.map((sample) => sample.size), [3, 3]);
  assert.deepEqual(samples.map((sample) => sample.keyframe), [false, false]);
  assert.deepEqual(samples.map((sample) => [...sample.data]), data.map((payload) => [...payload]));
});
