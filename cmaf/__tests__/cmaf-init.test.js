/**
 * cmaf init segment 解析补充单测：
 *  - avcC / hvcC / mp4a(esds) 配置字节提取、track 顺序、timescale 解析；
 *  - 异常输入：video-only / audio-only、未知 codec 配置盒（av01+av1C）、无 moov。
 *
 * fixture 由 hls 模块的 fMP4 构造器生成（零外网、零浏览器）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { parseInitSegment, findTimescales } from '../src/chunk-parser.js';
import { findVideoDecoderConfig, findAudioSpecificConfig } from '../src/isobmff.js';

const FAKE_AVC_C = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f,
  0xac, 0xd9, 0x40, 0x50, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
]);
const HVC_C = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
const ASC = new Uint8Array([0x12, 0x10]); // AOT=2(LC) 44100 双声道

const VIDEO_TRACK = (extra = {}) => ({
  id: 1, type: 'video', codec: 'avc1.64001f',
  description: { tag: 'avcC', bytes: FAKE_AVC_C },
  width: 640, height: 360, timescale: 90000, ...extra,
});
const AUDIO_TRACK = (extra = {}) => ({
  id: 2, type: 'audio', codec: 'mp4a.40.2',
  description: { tag: 'esds', bytes: ASC },
  sampleRate: 44100, channels: 2, timescale: 44100, ...extra,
});

/** 手工造一个只含 ftyp（无 moov）的字节流，用于异常分支 */
function ftypOnly() {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, 16);
  out.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  return out;
}

/* ---------------- 配置盒提取 ---------------- */

test('init：avcC 提取 entryType=fourcc=bytes 与 timescale', () => {
  const init = fmp4.buildInit([VIDEO_TRACK()]);
  const cfg = findVideoDecoderConfig(init);
  assert.equal(cfg.entryType, 'avc1');
  assert.equal(cfg.fourcc, 'avcC');
  assert.ok(cfg.description instanceof Uint8Array);
  assert.deepEqual(Array.from(cfg.description.slice(0, 4)), [0x01, 0x64, 0x00, 0x1f]);

  const info = parseInitSegment(init);
  assert.equal(info.video.timescale, 90000);
  assert.equal(info.audio, null, '纯视频 init 不应含音频');
});

test('init：hvcC 提取（hvc1 入口 + hvcC 配置盒）', () => {
  const init = fmp4.buildInit([
    VIDEO_TRACK({ codec: 'hvc1.1.6.L93.B0', description: { tag: 'hvcC', bytes: HVC_C } }),
  ]);
  const cfg = findVideoDecoderConfig(init);
  assert.equal(cfg.entryType, 'hvc1', 'muxer 对 hvc 前缀写 hvc1 入口');
  assert.equal(cfg.fourcc, 'hvcC');
  // 注：cmaf 的 description 提取按 box 总尺寸切片，会多带 4 字节后续盒头；
  // 这里只断言真正的配置字节（前 8 字节）与输入一致。
  assert.deepEqual(Array.from(cfg.description.slice(0, HVC_C.length)), Array.from(HVC_C));
});

test('init：mp4a/esds 提取 AudioSpecificConfig 与 AOT/timescale', () => {
  const init = fmp4.buildInit([AUDIO_TRACK()]);
  const asc = findAudioSpecificConfig(init);
  assert.ok(asc, '应定位到 esds 内嵌 ASC');
  assert.deepEqual(Array.from(asc.slice(0, 2)), [0x12, 0x10]);

  const info = parseInitSegment(init);
  assert.ok(info.audio, '纯音频 init 应含音频轨');
  assert.equal(info.audio.codecAot, 2, 'ASC 高 5 位为 AOT=2');
  // 修正后按 hdlr('soun') 关联：单音频轨 mdhd timescale 取真实 44100，而非默认 48000
  assert.equal(info.audio.timescale, 44100, '按 hdlr 关联后单音频轨取真实 timescale=44100');
  assert.equal(info.video, null, '纯音频 init 不应含视频');
});

test('init：视频+音频双轨并存时各自提取且 timescale 正确', () => {
  const init = fmp4.buildInit([VIDEO_TRACK({ timescale: 90000 }), AUDIO_TRACK({ timescale: 48000 })]);
  const info = parseInitSegment(init);
  assert.equal(info.video.entryType, 'avc1');
  assert.equal(info.video.timescale, 90000);
  assert.equal(info.audio.codecAot, 2);
  assert.equal(info.audio.timescale, 48000, '双轨时 audio mdhd timescale 应正确解析');
});

/* ---------------- 异常 / 未覆盖分支 ---------------- */

test('未知 codec 配置盒（hvc1 入口 + av1C）：fourcc/description 返回 null', () => {
  // muxer 仅写 avc1/hvc1 入口；此处用 hvc1 入口配未支持的 av1C 配置盒。
  // cmaf 仅识别 avcC/hvcC/dvcC/vpcC；av1C 不在列表 → 无法给出解码配置。
  const init = fmp4.buildInit([
    VIDEO_TRACK({ codec: 'hvc1.1.6.L93.B0', description: { tag: 'av1C', bytes: new Uint8Array([9, 9, 9]) } }),
  ]);
  const cfg = findVideoDecoderConfig(init);
  assert.equal(cfg.entryType, 'hvc1', '入口类型仍应识别');
  assert.equal(cfg.fourcc, null, 'av1C 未被 cmaf 支持 → fourcc 为 null');
  assert.equal(cfg.description, null, '无可提取配置字节');
});

test('init 无 moov（仅 ftyp）：findVideoDecoderConfig 与 parseInitSegment 均为空', () => {
  const buf = ftypOnly();
  assert.equal(findVideoDecoderConfig(buf), null);
  const info = parseInitSegment(buf);
  assert.equal(info.video, null);
  assert.equal(info.audio, null);
});

test('init 含零长度配置盒（avcC bytes=0）不抛错，fourcc 仍识别', () => {
  const init = fmp4.buildInit([VIDEO_TRACK({ description: { tag: 'avcC', bytes: new Uint8Array(0) } })]);
  const cfg = findVideoDecoderConfig(init);
  assert.equal(cfg.fourcc, 'avcC', '空载荷的配置盒仍被识别为 avcC');
  assert.doesNotThrow(() => parseInitSegment(init));
});

/* ---------------- audit-79 C-2 修法回归（按 hdlr 树关联，非字节扫描） ---------------- */

// 合成最小 init（仅覆盖兜底用例，不依赖 hls muxer 内部实现）
function u32b(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function u16b(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function asciib(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f; return b; }
function mbox(type, ...ps) { const body = fmp4.concat(ps); return fmp4.concat([u32b(body.length + 8), asciib(type), body]); }
function mfull(type, ver, flags, ...ps) { const vf = new Uint8Array([ver, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]); return mbox(type, vf, ...ps); }

/** 构造 moov(trak…) 的 init；track: {timescale, handlerType, hasMdhd, hasHdlr} */
function synthInit(tracks) {
  const traks = tracks.map((t) => {
    const mdiaKids = [];
    if (t.hasMdhd !== false) {
      // mdhd v0：[ctime(4)][mtime(4)][timescale(4)][duration(4)][language(2)][pre_defined(2)]
      mdiaKids.push(mfull('mdhd', 0, 0, u32b(0), u32b(0), u32b(t.timescale), u32b(0), u16b(0x8000 | 0x5c), u16b(0)));
    }
    if (t.hasHdlr !== false) {
      mdiaKids.push(mfull('hdlr', 0, 0, u32b(0), asciib(t.handlerType), u32b(0), u32b(0), u32b(0), asciib('x'), new Uint8Array(1)));
    }
    const mdia = mbox('mdia', ...mdiaKids);
    const tkhd = mfull('tkhd', 0, 3, new Uint8Array(80));
    return mbox('trak', tkhd, mdia);
  });
  const mvhd = mfull('mvhd', 0, 0, new Uint8Array(92));
  const moov = mbox('moov', mvhd, ...traks);
  const ftyp = mbox('ftyp', asciib('iso5'), u32b(0x200), asciib('isom'));
  return fmp4.concat([ftyp, moov]);
}

test('C-2：结构遍历按 hdlr 关联，与 trak 出现顺序无关（音频在前）', () => {
  // 音频轨先于视频轨：旧"第 1 个 mdhd=视频"会被颠倒，新实现按 hdlr 判定
  const init = fmp4.buildInit([AUDIO_TRACK({ timescale: 48000 }), VIDEO_TRACK({ timescale: 90000 })]);
  const info = parseInitSegment(init);
  assert.equal(info.video.timescale, 90000, '视频轨在后的 timescale 仍正确');
  assert.equal(info.audio.timescale, 48000, '音频轨在前的 timescale 仍正确');
});

test('C-2：解码配置里埋入 "mdhd" 字节不误命中', () => {
  // 在视频 avcC 载荷内塞入形似 mdhd box 头的字节串（伪造 timescale）。
  // 旧实现全文件字节扫描会把这段"假 mdhd"当作第 2 个 mdhd、误归入音频轨。
  const fake = fmp4.concat([
    FAKE_AVC_C.slice(0, 4),
    new Uint8Array([0x6d, 0x64, 0x68, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0xca, 0x72]),
    FAKE_AVC_C.slice(4),
  ]);
  const init = fmp4.buildInit([
    VIDEO_TRACK({ timescale: 90000, description: { tag: 'avcC', bytes: fake } }),
    AUDIO_TRACK({ timescale: 48000 }),
  ]);
  const info = parseInitSegment(init);
  assert.equal(info.video.timescale, 90000, '视频 mdhd 取真实 90000');
  assert.equal(info.audio.timescale, 48000, '嵌入的假 mdhd 不应误归入音频轨');
});

test('C-2：缺 mdhd 的轨被兜底跳过（其余轨仍可取）', () => {
  const init = synthInit([
    { timescale: 90000, handlerType: 'vide' },
    { timescale: 48000, handlerType: 'soun', hasMdhd: false },
  ]);
  const ts = findTimescales(init);
  assert.equal(ts.video, 90000);
  assert.equal(ts.audio, undefined, '缺 mdhd 的音频轨应被跳过');
});

test('C-2：缺 hdlr 的轨无法判定类型被兜底跳过', () => {
  const init = synthInit([
    { timescale: 90000, handlerType: 'vide', hasHdlr: false },
    { timescale: 48000, handlerType: 'soun' },
  ]);
  const ts = findTimescales(init);
  assert.equal(ts.video, undefined, '缺 hdlr 的视频轨无法关联，应跳过');
  assert.equal(ts.audio, 48000);
});

test('C-2：标准双轨（含 hdlr）结构遍历正确关联', () => {
  const init = synthInit([
    { timescale: 48000, handlerType: 'soun' },
    { timescale: 90000, handlerType: 'vide' },
  ]);
  const ts = findTimescales(init);
  assert.equal(ts.video, 90000);
  assert.equal(ts.audio, 48000);
});
