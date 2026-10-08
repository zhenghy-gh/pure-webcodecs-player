#!/usr/bin/env node
/** Small offline demos generated from the repository's real H.264 test encoder.
 * No download, runtime dependency or external fixture directory is required.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { buildFlvTags, serializeTag, flvFileHeader } from '../samples/gateway/src/flv-builder.js';
import { createDemuxer } from '../flv/src/index.js';
import { Fmp4Remuxer } from '../mp4/src/index.js';
import { box, fullBox } from '../mp4/src/box-builder.js';
import { ByteWriter } from '../core/src/index.js';
import { EbmlWriter } from '../mkv/src/index.js';
import { makeTS } from '../samples/fixtures/ts.js';
import { buildMac, buildTag } from '../ape/__tests__/fixtures/gen.mjs';

const out = new URL('../site/assets/samples/', import.meta.url);
await mkdir(out, { recursive: true });
const frames = buildFlvTags(60).tags;
function amfString(value) {
  const text = Buffer.from(value, 'utf8'), length = Buffer.alloc(2);
  length.writeUInt16BE(text.length);
  return Buffer.concat([Buffer.from([2]), length, text]);
}
function amfNumber(value) { const bytes = Buffer.alloc(9); bytes[0] = 0; bytes.writeDoubleBE(value, 1); return bytes; }
function demoMetadata() {
  const entries = Object.entries({ duration: 4, width: 16, height: 16, framerate: 15, videocodecid: 7, videodatarate: 600 });
  const count = Buffer.alloc(4); count.writeUInt32BE(entries.length);
  const fields = entries.flatMap(([key, value]) => {
    const name = Buffer.from(key); const length = Buffer.alloc(2); length.writeUInt16BE(name.length);
    return [length, name, amfNumber(value)];
  });
  return Buffer.concat([amfString('onMetaData'), Buffer.from([8]), count, ...fields, Buffer.from([0, 0, 9])]);
}
const metadata = demoMetadata();
const flv = Buffer.concat([flvFileHeader(), ...frames.map(tag => serializeTag(tag.type, tag.ts, tag.type === 18 ? metadata : tag.data))]);
await writeFile(new URL('color-bars.flv', out), flv);
const demux = await createDemuxer(new Uint8Array(flv));
const track = demux.tracks.find(item => item.type === 'video');
const samples = [];
for await (const sample of demux.samples(track.id)) { sample.duration = 66_667; samples.push(sample); }
track.durationUs = 4_000_020;
demux.mediaInfo.durationUs = 4_000_020;
track.sampleEntryType = 'avc1';
track.timescale = 1000;
const remux = new Fmp4Remuxer();
const initBase = remux.createInitSegment(track);
const topView = new DataView(initBase.buffer, initBase.byteOffset, initBase.byteLength);
const ftypLength = topView.getUint32(0);
const moovStart = ftypLength;
const moovLength = topView.getUint32(moovStart);
let mvexStart = moovStart + 8;
while (mvexStart < moovStart + moovLength) {
  const childLength = topView.getUint32(mvexStart);
  if (String.fromCharCode(...initBase.subarray(mvexStart + 4, mvexStart + 8)) === 'mvex') break;
  mvexStart += childLength;
}
if (mvexStart >= moovStart + moovLength) throw new Error('Generated init segment has no mvex');
const oldMvexLength = topView.getUint32(mvexStart);
const mehd = fullBox('mehd', 1, 0, writer => writer.writeU64(4_000n));
const mvex = box('mvex', writer => {
  writer.writeRaw(initBase.subarray(mvexStart + 8, mvexStart + oldMvexLength));
  writer.writeRaw(mehd);
});
const init = new Uint8Array(initBase.length + mehd.length);
init.set(initBase.subarray(0, mvexStart), 0);
const nextView = new DataView(init.buffer);
nextView.setUint32(moovStart, moovLength + mehd.length);
nextView.setUint32(mvexStart, mvex.length);
init.set(mvex, mvexStart);
init.set(initBase.subarray(mvexStart + oldMvexLength), mvexStart + mvex.length);
const segment = remux.createMediaSegment(track, samples);
const mp4 = Buffer.concat([init, segment.data]);
await writeFile(new URL('color-bars.mp4', out), mp4);
const movInit = new Fmp4Remuxer({ majorBrand: 'qt  ', compatible: ['qt  ', 'isom'] }).createInitSegment(track);
await writeFile(new URL('color-bars.mov', out), Buffer.concat([movInit, segment.data]));
await writeFile(new URL('init.mp4', out), init);
await writeFile(new URL('segment.m4s', out), segment.data);
await writeFile(new URL('playlist.m3u8', out), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nsegment.m4s\n#EXT-X-ENDLIST\n');
const mkv = new EbmlWriter();
mkv.master(0x1A45DFA3, writer => writer.u(0x4286, 1).u(0x42F7, 1).u(0x42F2, 4).u(0x42F3, 8).s(0x4282, 'matroska').u(0x4287, 4).u(0x4285, 2));
mkv.master(0x18538067, writer => {
  writer.master(0x1549A966, info => info.u(0x2AD7B1, 1_000_000).f(0x4489, 4000).s(0x4D80, 'PurePlay demo').s(0x5741, 'PurePlay demo'));
  writer.master(0x1654AE6B, tracks => tracks.master(0xAE, entry => {
    entry.u(0xD7, 1).u(0x73C5, 1).u(0x83, 1).s(0x86, 'V_MPEG4/ISO/AVC').b(0x63A2, track.description);
    entry.master(0xE0, video => video.u(0xB0, track.width).u(0xBA, track.height));
  }));
  writer.master(0x1F43B675, cluster => {
    cluster.u(0xE7, 0);
    for (const sample of samples) {
      const time = Math.round(sample.timestamp / 1000);
      const block = new Uint8Array(4 + sample.data.length);
      block.set([0x81, time >> 8, time & 255, 0x80]); block.set(sample.data, 4);
      cluster.b(0xA3, block);
    }
  });
});
await writeFile(new URL('color-bars.mkv', out), mkv.done());
await writeFile(new URL('parser.ts', out), makeTS({ auCount: 12, withAudio: true }).bytes);
await writeFile(new URL('metadata.ape', out), Buffer.concat([buildMac(), new Uint8Array(256), buildTag([['Title', 'PurePlay 内置元数据样例'], ['Artist', '程序生成（非可播放音频）']])]));
await demux.destroy();
console.log('Offline demo media generated:', out.pathname);
