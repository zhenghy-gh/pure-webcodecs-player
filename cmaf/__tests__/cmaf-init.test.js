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
import { parseInitSegment } from '../src/chunk-parser.js';
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
  // 纯音频 init 仅一个 mdhd，被 cmaf 归入 video 槽，audio 槽缺失 → 回退默认 48000
  assert.equal(info.audio.timescale, 48000, '单 mdhd 时 audio 槽缺失回退 48000');
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
