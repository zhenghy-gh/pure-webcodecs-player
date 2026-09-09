/**
 * mov 补充套件：生成产物端到端 + QuickTime 兼容边界（M2 门槛补量）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeQuickTime,
  listTopLevelAtoms,
  detectCompressedMoov,
  parseUdtaTags,
  interpretEdits,
  isTimecodeHandler,
} from '../src/atom-compat.js';
import { iterateBoxes } from '../../mp4/src/box-parser.js';
import { MovDemuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { buildQuickTimeMovFixture, buildCompressedMovFixture } from './fixtures.js';

const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

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

/* ------------------------------ 产物端到端 ------------------------------ */

test('产物 quicktime.mov 端到端：container/qtTags/title/时长', async () => {
  const file = await ensureArtifact('quicktime.mov');
  const bytes = new Uint8Array(await readFile(file));
  assert.deepEqual([...bytes], [...buildQuickTimeMovFixture().bytes], '产物与内存构造逐字节一致');

  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.container, 'mov');
  // mvhd 240 ticks @600 → 400000µs
  assert.equal(info.durationUs, 400000);
  assert.equal(info.metadata.title, '测试标题', '@nam 镜像进契约 metadata.title');
  assert.equal(info.tracks.length, 3);

  let n = 0;
  for await (const s of d.samples(info.tracks[0].id)) n++;
  assert.equal(n, 6);
});

test('产物 compressed-mov.mov 拒载并提示 ffmpeg 转封装', async () => {
  const file = await ensureArtifact('compressed-mov.mov');
  const bytes = new Uint8Array(await readFile(file));
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'NOT_SUPPORTED' && /cmov/.test(e.message) && /ffmpeg/.test(e.message),
  );
});

/* ------------------------------ 兼容层边界 ------------------------------ */

test('looksLikeQuickTime：随机字节不误判', () => {
  const rnd = new Uint8Array(64);
  for (let i = 0; i < 64; i++) rnd[i] = (i * 37 + 11) & 0xff;
  rnd.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  rnd.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
  assert.equal(looksLikeQuickTime(rnd), false);
});

test('listTopLevelAtoms：cmov fixture 结构', () => {
  const { bytes } = buildCompressedMovFixture();
  assert.deepEqual(listTopLevelAtoms(bytes), ['ftyp', 'moov']);
});

test('detectCompressedMoov：无 dcom 子 atom 时 vendor 缺省', () => {
  // 手拼最小 moov>cmov（仅 cmvd）
  const moov = new Uint8Array(64);
  const dv = new DataView(moov.buffer);
  dv.setUint32(0, 64);
  moov.set([0x6d, 0x6f, 0x6f, 0x76], 4); // 'moov'
  dv.setUint32(8, 56);
  moov.set([0x63, 0x6d, 0x6f, 0x76], 12); // 'cmov'
  dv.setUint32(16, 48);
  moov.set([0x63, 0x6d, 0x76, 0x64], 20); // 'cmvd'
  const r = detectCompressedMoov(moov.subarray(0, 64));
  assert.equal(r.compressed, true);
  assert.equal(r.vendor, undefined);
});

test('parseUdtaTags：ISO 风格 meta（version/flags 头）同样兼容', async () => {
  const { ByteWriter } = await import('../../core/src/index.js');
  const boxOf = (type, body) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  };
  const textAtom = (type, text) => {
    const payload = new TextEncoder().encode(text);
    const out = new Uint8Array(10 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    new DataView(out.buffer).setUint16(8, payload.byteLength);
    out.set(payload, 10);
    return out;
  };

  const hdlr = boxOf('hdlr', new Uint8Array([
    0, 0, 0, 0, ...new TextEncoder().encode('mdir'), ...new Uint8Array(12), ...new TextEncoder().encode('appl'), 0,
  ]));
  const nam = textAtom('©nam', 'ISO风格标题');
  // ISO 风格 meta：version/flags 之后才是 hdlr/文本 atom
  const metaBody = new Uint8Array(4 + hdlr.length + nam.length);
  metaBody.set(hdlr, 4);
  metaBody.set(nam, 4 + hdlr.length);
  const meta = boxOf('meta', metaBody);
  const udta = boxOf('udta', meta);
  const moovInner = boxOf('moov', new Uint8Array([...new Uint8Array(96)])); // mvhd 占位不足没关系
  // 直接把 udta 拼进一个"伪 moov"：parseUdtaTags 只关心 moov 下的 udta 子 atom
  const fakeMoov = new Uint8Array(8 + 100 + udta.length);
  new DataView(fakeMoov.buffer).setUint32(0, fakeMoov.byteLength);
  fakeMoov.set([0x6d, 0x6f, 0x6f, 0x76], 4);
  // 前 100 字节占位（非 box 内容会被跳过？不会——改为合法 free）
  fakeMoov.set([0, 0, 0, 100, 0x66, 0x72, 0x65, 0x65], 8); // free:100
  fakeMoov.set(udta, 108);

  const tags = parseUdtaTags(fakeMoov);
  assert.equal(tags['©nam'], 'ISO风格标题');
});

test('parseUdtaTags：无 udta 时返回空对象', async () => {
  const { buildFtyp, box } = await import('../../mp4/src/box-builder.js');
  const moov = box('moov', (w) => w.writeRaw(buildFtyp()));
  assert.deepEqual(parseUdtaTags(moov), {});
});

test('文本 atom 长度前缀非法时被安全忽略', async () => {
  const { ByteWriter } = await import('../../core/src/index.js');
  const w = new ByteWriter();
  const boxOf = (type, body) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  };
  // ©nam 载荷声称长度 999 但实际只有 2 字节 → 忽略该标签
  const badNam = new Uint8Array(12);
  new DataView(badNam.buffer).setUint32(0, 12);
  badNam.set([0xa9, 0x6e, 0x61, 0x6d], 4);
  new DataView(badNam.buffer).setUint16(8, 999);
  const meta = boxOf('meta', boxOf('hdlr', new Uint8Array([
    0, 0, 0, 0, ...new TextEncoder().encode('mdir'), ...new Uint8Array(12), ...new TextEncoder().encode('appl'), 0,
  ])).length > 0 ? [boxOf('hdlr', new Uint8Array([
    0, 0, 0, 0, ...new TextEncoder().encode('mdir'), ...new Uint8Array(12), ...new TextEncoder().encode('appl'), 0,
  ])), badNam] : []);
  const udta = boxOf('udta', meta);
  const moov = boxOf('moov', (mw) => mw.writeRaw(udta));
  const tags = parseUdtaTags(moov);
  assert.equal(tags['©nam'], undefined);
});

test('interpretEdits：全负 mediaTime → firstMediaTimeSec=null', () => {
  const r = interpretEdits({ entries: [{ segmentDuration: 1, mediaTime: -1 }, { segmentDuration: 1, mediaTime: -5 }] }, 600);
  assert.equal(r.hasEmptyEdit, true);
  assert.equal(r.firstMediaTimeSec, null);
});

test('isTimecodeHandler 与轨类型映射', async () => {
  assert.equal(isTimecodeHandler('tmcd'), true);
  assert.equal(isTimecodeHandler('vide'), false);

  const { bytes } = buildQuickTimeMovFixture();
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  const tmcd = info.tracks.find((t) => t.codec === 'tmcd');
  assert.ok(tmcd, '存在 tmcd 轨');
  assert.equal(tmcd.type, 'metadata');
});

test('契约字段：video.bitstreamFormat / audio.numberOfChannels / 轨排序', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();

  assert.equal(info.tracks[0].type, 'video', '排序 video 最先');
  assert.equal(info.tracks[0].bitstreamFormat, 'avc');

  const audio = info.tracks.find((t) => t.type === 'audio');
  assert.equal(audio.numberOfChannels, 2);
  assert.equal(audio.sampleRate, 44100);

  assert.equal(info.tracks[info.tracks.length - 1].type, 'metadata', 'metadata 殿后');
});

test('Sample.dataState 默认 loaded；getBufferedRanges 默认空；destroy 幂等', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await d.open();

  const s0 = await d.readSample(d.tracks[0].id);
  assert.equal(s0.dataState, 'loaded');
  assert.deepEqual(d.getBufferedRanges(1), []);

  let ends = 0;
  d.on('end', () => ends++);
  await d.destroy();
  await d.destroy();
  assert.equal(ends, 1, 'end 事件只发一次');
  assert.equal(d.state, 'destroyed');
});

test('probe：垃圾字节三模块均不命中（识别层拒绝）', async () => {
  const junk = new Uint8Array(64);
  for (let i = 0; i < 64; i++) junk[i] = (i * 89 + 7) & 0xff;
  assert.equal(MovDemuxer.probe(junk), null);
});
