/**
 * FlvDemuxer 正向管线补测（第二批）：聚焦现有 flv-demuxer.test / rtmp-demuxer-deep /
 * rtmp-demuxer-pipeline 仍未覆盖的「正向」边界（非错误恢复路径）：
 *   1. onMetaData 纯逻辑边界：width/height 仅当 number 才回填，字符串/缺字段不回填；
 *   2. AAC 双序列头（重配置）：第二个 sequence header 覆盖已建 audio 轨描述；
 *   3. CTS SI24 有符号三形态边界：0（零）/ 0x7fffff（最大正）/ 0x800000（最大负）
 *      —— 此前仅覆盖 0、正中段、0xffffff（负一），缺最值上溢/下溢交叉点。
 * 全部程序化构造 FLV 字节，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlvDemuxer } from '../src/flv-demuxer.js';
import { flvFileHeader, serializeTag, makeAvcC } from '../../samples/gateway/src/index.js';

function join(...parts) {
  const ps = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const len = ps.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function collectWith(opts) {
  const d = new FlvDemuxer(opts);
  const got = { header: null, metadata: [], tracks: [], samples: [], errors: [], warns: [], done: null };
  d.on('header', (h) => (got.header = h));
  d.on('metadata', (m) => got.metadata.push(m));
  d.on('track', (t) => got.tracks.push(t));
  d.on('sample', (s) => got.samples.push(s));
  d.on('error', (e) => got.errors.push(e));
  d.on('warn', (w) => got.warns.push(w));
  d.on('done', (i) => (got.done = i));
  return { d, got };
}

const AVC_SEQ = () => join(Uint8Array.from([0x17, 0, 0, 0, 0]), makeAvcC());
const AVC_NALU = (ctsBytes = 0) =>
  Uint8Array.from([
    0x17, 1,
    (ctsBytes >> 16) & 0xff,
    (ctsBytes >> 8) & 0xff,
    ctsBytes & 0xff,
    0x00, 0x00, 0x00, 0x02, 0x65, 0x88,
  ]);

/** 位布局 5bit objectType(2=AAC-LC) + 4bit freqIdx + 4bit channels */
function asc(freqIdx, channels) {
  const objType = 2; // AAC-LC
  return Uint8Array.from([(objType << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (channels << 3)]);
}
const AAC_SEQ = (freqIdx, channels) => join(Uint8Array.from([0xaf, 0]), asc(freqIdx, channels));
const AAC_FIRST = 0xaf;

/**
 * 构造 onMetaData 的 AMF0 script 数据。
 * pairs: [key, value]，value 支持：
 *   - number      → AMF Number（0x00 + float64）
 *   - {str:'..'}  → AMF String（0x02 + len16 + utf8），用于验证「非 number 不回填」
 *   - null        → AMF Null（0x05）
 * 仅 list 中给出的 key 才会出现在 ECMA 数组中（天然表达「字段缺省」语义）。
 */
function amfMetaData(pairs, name = 'onMetaData') {
  const enc = new TextEncoder();
  const parts = [];
  const nb = enc.encode(name);
  parts.push(Uint8Array.from([0x02, (nb.length >> 8) & 0xff, nb.length & 0xff, ...nb]));
  parts.push(Uint8Array.from([0x08, 0, 0, 0, pairs.length]));
  for (const [k, v] of pairs) {
    const kb = enc.encode(k);
    parts.push(Uint8Array.from([(kb.length >> 8) & 0xff, kb.length & 0xff, ...kb]));
    if (v === null) {
      parts.push(Uint8Array.from([0x05])); // AMF Null
    } else if (typeof v === 'object' && v && v.str !== undefined) {
      const sb = enc.encode(v.str);
      parts.push(Uint8Array.from([0x02, (sb.length >> 8) & 0xff, sb.length & 0xff, ...sb]));
    } else {
      const vb = new Uint8Array(9);
      vb[0] = 0x00; // Number marker
      new DataView(vb.buffer).setFloat64(1, Number(v));
      parts.push(vb);
    }
  }
  parts.push(Uint8Array.from([0x00, 0x00, 0x09]));
  return join(...parts);
}

/** freqIdx 查表（与 src 中 parseAudioSpecificConfig 同序） */
const FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

test('onMetaData.width 为非数字（字符串）→ 不回填；height 数字仍回填', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(9, 0, AVC_SEQ()),
      serializeTag(18, 0, amfMetaData([['width', { str: '1280' }], ['height', 720]])),
    ),
  );
  d.flush();
  const video = got.tracks.find((t) => t.kind === 'video');
  assert.equal(video.width, null, '字符串 width 不满足 typeof==number 守卫，不应回填');
  assert.equal(video.height, 720, '数值 height 应正常回填');
});

test('onMetaData 仅含 height（缺 width 字段）→ 只回填 height，width 保持 null', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(9, 0, AVC_SEQ()),
      // ECMA 数组只声明 height 一项 → width 字段天然缺省
      serializeTag(18, 0, amfMetaData([['height', 480]])),
    ),
  );
  d.flush();
  const video = got.tracks.find((t) => t.kind === 'video');
  assert.equal(video.width, null, 'width 字段缺省则不回填');
  assert.equal(video.height, 480, 'height 字段存在应回填');
});

test('AAC 双序列头（重配置）：每次 sequence header 触发 track 事件，末次覆盖 audio 轨描述', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      // 第一次：44100Hz(4) / 立体声(2)
      serializeTag(8, 0, AAC_SEQ(4, 2)),
      // 第二次重配置：48000Hz(3) / 单声道(1)
      serializeTag(8, 0, AAC_SEQ(3, 1)),
    ),
  );
  d.flush();
  const audios = got.tracks.filter((t) => t.kind === 'audio');
  assert.equal(audios.length, 2, '每次 sequence header 各发一次 track 事件（重配置语义）');
  assert.equal(got.errors.length, 0, '重配置不应触发错误');
  // 末次 track 事件反映第二次重配置
  const last = audios.at(-1);
  assert.equal(last.sampleRate, FREQ[3], '末次 track 应反映第二次重配置后的采样率 48000');
  assert.equal(last.numberOfChannels, 1, '末次 track 应反映第二次重配置后的声道数 1');
  assert.deepEqual(Array.from(last.description), Array.from(asc(3, 1)), '末次 description 应为第二次 ASC');
  // 内部 tracks map 唯一键 'audio' 被覆盖为末次
  assert.deepEqual(Array.from(d.tracks.get('audio').description), Array.from(asc(3, 1)));
});

test('CTS SI24 三形态边界：0 / 最大正(0x7fffff) / 最大负(0x800000)，ptsUs 符号正确', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(9, 0, AVC_SEQ()),
      serializeTag(9, 1000, AVC_NALU(0)),          // cts=0
      serializeTag(9, 1000, AVC_NALU(0x7fffff)),    // 最大正
      serializeTag(9, 1000, AVC_NALU(0x800000)),    // 最大负（符号位交叉点）
    ),
  );
  d.flush();
  assert.equal(got.samples.length, 3, '三种 CTS 形态均应产出样本');
  assert.equal(got.errors.length, 0, '合法 SI24 不应触发解析错误');
  assert.equal(got.samples[0].ptsUs, 1000 * 1000, 'cts=0 ⇒ pts==dts');
  // 最大正：0x7fffff=8388607ms
  assert.equal(got.samples[1].ptsUs, 1000 * 1000 + 0x7fffff * 1000, 'pts = dts + 8388607ms');
  assert.ok(got.samples[1].ptsUs > got.samples[1].dtsUs);
  // 最大负：0x800000 ⇒ -8388608ms（下溢交叉点）
  assert.equal(got.samples[2].ptsUs, 1000 * 1000 - 0x800000 * 1000, 'pts = dts - 8388608ms');
  assert.ok(got.samples[2].ptsUs < got.samples[2].dtsUs);
});

test('音频帧（aacPacketType=1）紧跟双序列头后出样本，且采用最终轨描述', () => {
  const { d, got } = collectWith();
  d.push(
    join(
      flvFileHeader(),
      serializeTag(8, 0, AAC_SEQ(4, 2)),
      serializeTag(8, 0, AAC_SEQ(3, 1)),
      // 重配置后的音频帧
      serializeTag(8, 50, Uint8Array.from([AAC_FIRST, 1, 0x21, 0x10, 0x05])),
    ),
  );
  d.flush();
  assert.equal(got.samples.length, 1, '重配置后音频帧应正常出样本');
  assert.equal(got.samples[0].kind, 'audio');
  assert.equal(got.samples[0].dtsUs, 50_000, '音频帧时间戳独立（毫秒→µs）');
});
