/**
 * wav/__tests__/wav.test.js — WAV 解析层单测（node --test）
 * fixture 全部程序化生成：不依赖外网与大文件（交付标准 4）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WavDemuxer,
  parseWavHeader,
  waveCodecString,
  WAVE_FORMAT,
  convertToFloat32Planar,
  computePeaks,
  drawWaveform,
  ErrorCode,
} from '../src/index.js';

/* ============================================================
 * fixture 构造器：手工拼装 RIFF 字节，覆盖常规与边界情形
 * ============================================================ */

/** 写 FourCC + u32le */
function putChunkHeader(view, offset, id, size) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i));
  view.setUint32(offset + 4, size, true);
}

/**
 * 构造一个最小合法 WAV。
 * @param {{formatTag?:number, extensible?:boolean, channels?:number,
 *          sampleRate?:number, bitsPerSample?:number, frames?:number,
 *          extraChunkBeforeData?:{id:string, body:Uint8Array},
 *          listInfo?:Record<string,string>}} opt
 */
function buildWav(opt = {}) {
  const formatTag = opt.formatTag ?? WAVE_FORMAT.PCM;
  const extensible = opt.extensible ?? false;
  const channels = opt.channels ?? 1;
  const sampleRate = opt.sampleRate ?? 8000;
  const bits = opt.bitsPerSample ?? (formatTag === WAVE_FORMAT.IEEE_FLOAT ? 32 : 16);
  const bytesPerSample = bits >> 3;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const frames = opt.frames ?? 8;

  const fmtSize = extensible ? 40 : 16;
  const listBody = buildListInfo(opt.listInfo);
  const extra = opt.extraChunkBeforeData;

  const dataBytes = frames * blockAlign;
  let total =
    12 + // RIFF 头
    (8 + fmtSize) +
    (listBody ? 8 + listBody.length : 0) +
    (extra ? 8 + extra.body.length + (extra.body.length % 2) : 0) +
    (8 + dataBytes);

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let p = 0;
  putChunkHeader(dv, p, 'RIFF', total - 8); p += 4;
  dv.setUint32(p, total - 8, true); p += 4;
  for (const ch of 'WAVE') { dv.setUint8(p++, ch.charCodeAt(0)); }

  // fmt
  putChunkHeader(dv, p, 'fmt ', fmtSize); p += 8;
  dv.setUint16(p, extensible ? WAVE_FORMAT.EXTENSIBLE : formatTag, true); p += 2;
  dv.setUint16(p, channels, true); p += 2;
  dv.setUint32(p, sampleRate, true); p += 4;
  dv.setUint32(p, byteRate, true); p += 4;
  dv.setUint16(p, blockAlign, true); p += 2;
  dv.setUint16(p, bits, true); p += 2;
  if (extensible) {
    dv.setUint16(p, 22, true); p += 2;           // cbSize
    dv.setUint16(p, bits, true); p += 2;         // validBits
    dv.setUint32(p, 0x3, true); p += 4;          // channelMask
    dv.setUint16(p, formatTag, true); p += 2;    // SubFormat GUID 前 2 字节
    // GUID 余下 14 字节固定模板（0000-0010-8000-00aa00389b71）
    const tail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (const b of tail) dv.setUint8(p++, b);
  }

  if (listBody) { putChunkHeader(dv, p, 'LIST', listBody.length); p += 8; u8.set(listBody, p); p += listBody.length; }

  if (extra) {
    putChunkHeader(dv, p, extra.id, extra.body.length); p += 8;
    u8.set(extra.body, p);
    p += extra.body.length + (extra.body.length % 2); // 奇数补齐
  }

  putChunkHeader(dv, p, 'data', dataBytes); p += 8;
  // 数据体填可识别模式：帧 i → 采样值 i*100 + c
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      switch (`${formatTag}:${bits}`) {
        case '1:8': dv.setUint8(p, ((i * 37 + c * 13) % 255)); p += 1; break;
        case '1:16': dv.setInt16(p, (i * 100 + c), true); p += 2; break;
        case '1:24': writeS24(dv, p, (i * 100 + c)); p += 3; break;
        case '1:32': dv.setInt32(p, (i * 100 + c), true); p += 4; break;
        case '3:32': dv.setFloat32(p, (i * 0.25 + c * 0.5) - 1, true); p += 4; break;
        case '6:8': case '7:8': dv.setUint8(p, (i * 53 + c * 29) % 255); p += 1; break; // alaw/ulaw 占位字节
        default: throw new Error('fixture 不支持该组合');
      }
    }
  }
  return new Uint8Array(buf);
}

/** s24 小端写入 */
function writeS24(dv, offset, v) {
  dv.setUint8(offset, v & 0xff);
  dv.setUint8(offset + 1, (v >> 8) & 0xff);
  dv.setUint8(offset + 2, (v >> 16) & 0xff);
}

/** LIST/INFO 块体（'INFO' + 子项） */
function buildListInfo(info) {
  if (!info) return null;
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [enc.encode('INFO')];
  for (const [k, v] of Object.entries(info)) {
    const vb = enc.encode(v);
    const chunkLen = 8 + vb.length + (vb.length % 2);
    const arr = new Uint8Array(chunkLen);
    const dv = new DataView(arr.buffer);
    for (let i = 0; i < 4; i++) arr[i] = k.charCodeAt(i);
    dv.setUint32(4, vb.length, true);
    arr.set(vb, 8);
    parts.push(arr);
  }
  return concat(parts);
}
function concat(list) {
  const len = list.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const part of list) { out.set(part, o); o += part.length; }
  return out;
}

/** 内存 ByteSource（契约 §2.1 最小实现） */
function memorySource(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (offset < 0 || offset + length > bytes.length) {
        throw Object.assign(new Error('越界'), { code: 'SOURCE_ERROR' });
      }
      return bytes.subarray(offset, offset + length);
    },
    async close() {},
  };
}

/* ============================================================
 * probe / 头部解析
 * ============================================================ */

describe('WavDemuxer.probe', () => {
  test('RIFF/WAVE 命中且高置信度', () => {
    const r = WavDemuxer.probe(buildWav());
    assert.ok(r);
    assert.equal(r.container, 'wav');
    assert.ok(r.confidence >= 0.8);
  });
  test('非 WAV 输入返回 null 且不抛异常', () => {
    assert.equal(WavDemuxer.probe(new Uint8Array([1, 2, 3])), null);
    assert.equal(WavDemuxer.probe(new TextEncoder().encode('<html></html>')), null);
    assert.equal(WavDemuxer.probe(new Uint8Array(0)), null);
  });
});

describe('parseWavHeader', () => {
  test('基础 PCM s16 单声道字段齐全', () => {
    const h = parseWavHeader(buildWav({ channels: 2, sampleRate: 44100, frames: 10 }));
    assert.equal(h.format.formatTag, WAVE_FORMAT.PCM);
    assert.equal(h.format.channels, 2);
    assert.equal(h.format.sampleRate, 44100);
    assert.equal(h.format.bitsPerSample, 16);
    assert.equal(h.codec, 'pcm-s16');
    assert.equal(h.durationUs, Math.round((10 / 44100) * 1e6));
    assert.equal(h.dataChunk.size, 40);
  });

  const codecCases = [
    [WAVE_FORMAT.PCM, 8, 'pcm-u8'],
    [WAVE_FORMAT.PCM, 16, 'pcm-s16'],
    [WAVE_FORMAT.PCM, 24, 'pcm-s24'],
    [WAVE_FORMAT.PCM, 32, 'pcm-s32'],
    [WAVE_FORMAT.IEEE_FLOAT, 32, 'pcm-f32'],
  ];
  for (const [tag, bits, expect] of codecCases) {
    test(`codec 映射 tag=0x${tag.toString(16)} bits=${bits} → ${expect}`, () => {
      assert.equal(waveCodecString(tag, bits), expect);
      const h = parseWavHeader(buildWav({ formatTag: tag, bitsPerSample: bits }));
      assert.equal(h.codec, expect);
    });
  }

  test('EXTENSIBLE SubFormat 还原真实格式码', () => {
    const h = parseWavHeader(buildWav({ extensible: true, formatTag: WAVE_FORMAT.PCM, bitsPerSample: 24 }));
    assert.equal(h.format.extensible, true);
    assert.equal(h.format.formatTag, WAVE_FORMAT.PCM);
    assert.equal(h.codec, 'pcm-s24');
  });

  test('data 前存在奇数长度子块时按规范补齐并继续解析', () => {
    const h = parseWavHeader(buildWav({
      extraChunkBeforeData: { id: 'JUNK', body: new Uint8Array(5) }, // 5 字节 → 补 1
    }));
    assert.equal(h.dataChunk.offset > 12 + 8 + 16 + 8 + 5 + 1, true);
    assert.equal(h.chunks.some((c) => c.id === 'JUNK'), true);
  });

  test('LIST/INFO 元数据被提取', () => {
    const h = parseWavHeader(buildWav({ listInfo: { INAM: '测试音频', IART: 'ui-kit-dev' } }));
    assert.equal(h.info.INAM, '测试音频');
    assert.equal(h.info.IART, 'ui-kit-dev');
  });

  test('错误路径：缺 fmt / 缺 data / 非法魔数', () => {
    // 只有 RIFF 头
    const headOnly = new Uint8Array(new ArrayBuffer(12));
    const dv0 = new DataView(headOnly.buffer);
    putChunkHeader(dv0, 0, 'RIFF', 4);
    for (const ch of 'WAVE') dv0.setUint8(8 + 'WAVE'.indexOf(ch), ch.charCodeAt(0));
    assert.throws(() => parseWavHeader(headOnly), (e) => e.code === ErrorCode.PARSE_ERROR);

    // 非 RIFF 魔数
    assert.throws(() => parseWavHeader(new TextEncoder().encode('OggSxxxxWAVEjunkjunk')),
      (e) => e.code === ErrorCode.PARSE_ERROR);

    // alaw 不支持
    assert.throws(() => parseWavHeader(buildWav({ formatTag: WAVE_FORMAT.ALAW, bitsPerSample: 8 })),
      (e) => e.code === ErrorCode.NOT_SUPPORTED);
  });
});

/* ============================================================
 * PCM 转换
 * ============================================================ */

describe('convertToFloat32Planar', () => {
  test('s16 数值精确归一化', () => {
    const wav = buildWav({ channels: 1, frames: 4 });
    const h = parseWavHeader(wav);
    const data = wav.subarray(h.dataChunk.offset, h.dataChunk.offset + h.dataChunk.size);
    const { planar, frames } = convertToFloat32Planar(data, h.format);
    assert.equal(frames, 4);
    // fixture 模式：帧 i 值 = i*100
    assert.deepEqual([...planar[0]], [0, 100 / 32768, 200 / 32768, 300 / 32768]);
  });

  test('立体声解交织通道顺序正确', () => {
    const wav = buildWav({ channels: 2, frames: 3 });
    const h = parseWavHeader(wav);
    const data = wav.subarray(h.dataChunk.offset, h.dataChunk.offset + h.dataChunk.size);
    const { planar } = convertToFloat32Planar(data, h.format);
    assert.deepEqual([...planar[0]], [0, 100 / 32768, 200 / 32768]);
    assert.deepEqual([...planar[1]], [1 / 32768, 101 / 32768, 201 / 32768]);
  });

  const depthCases = [
    { formatTag: WAVE_FORMAT.PCM, bitsPerSample: 24 },
    { formatTag: WAVE_FORMAT.PCM, bitsPerSample: 32 },
    { formatTag: WAVE_FORMAT.IEEE_FLOAT, bitsPerSample: 32 },
    { formatTag: WAVE_FORMAT.PCM, bitsPerSample: 8 },
  ];
  for (const { formatTag, bitsPerSample } of depthCases) {
    test(`u8/s24/s32/f32 位深归一化（tag=0x${formatTag.toString(16)} bits=${bitsPerSample}）`, () => {
      const wav = buildWav({ formatTag, bitsPerSample, frames: 5 });
      const h = parseWavHeader(wav);
      const data = wav.subarray(h.dataChunk.offset, h.dataChunk.offset + h.dataChunk.size);
      const { planar, frames } = convertToFloat32Planar(data, h.format);
      assert.equal(frames, 5);
      assert.ok(planar.every((ch) => [...ch].every((v) => v >= -1 && v <= 1)));
      // 整数位深 fixture 单调递增
      if (formatTag !== WAVE_FORMAT.IEEE_FLOAT && bitsPerSample !== 8) {
        const mono = planar[0];
        for (let i = 1; i < mono.length; i++) assert.ok(mono[i] > mono[i - 1]);
      }
    });
  }
});

/* ============================================================
 * Demuxer 迭代器与 seek
 * ============================================================ */

describe('WavDemuxer.parseInit/samples/seek', () => {
  test('parseInit 产出契约 MediaInfo 并发事件', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ channels: 2, sampleRate: 48000, frames: 100 })));
    let fired = false;
    dem.on('media-info', () => { fired = true; });
    const mi = await dem.parseInit();
    assert.equal(fired, true);
    assert.equal(mi.container, 'wav');
    assert.equal(mi.tracks[0].codec, 'pcm-s16');
    assert.equal(mi.tracks[0].audio.sampleRate, 48000);
    assert.equal(mi.seekable, true);
    await dem.stop();
  });

  test('samples 迭代产出 µs 时间戳的 pcm-* Sample', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ sampleRate: 8000, frames: 9000 })));
    await dem.parseInit();
    /** @type {any[]} */
    const samples = [];
    for await (const s of dem.samples(1)) samples.push(s);
    // 9000 帧 / 4096 每块 = 3 块
    assert.equal(samples.length, 3);
    assert.equal(samples[0].codec, 'pcm-s16');
    assert.equal(samples[0].timestamp, 0);
    assert.equal(samples[0].keyframe, true);
    assert.equal(samples[1].timestamp, Math.round(4096 / 8000 * 1e6));
    assert.equal(samples[2].duration, Math.round(808 / 8000 * 1e6));
    await dem.stop();
  });

  test('seek 后迭代从落点开始', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ sampleRate: 8000, frames: 16000 })));
    await dem.parseInit();
    const r = await dem.seek(Math.round(1.5 * 1e6)); // 1.5s → 12000 帧
    assert.equal(r.actualTimestampUs, 1500000);
    const it = dem.samples(1)[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value.timestamp, 1500000);
    await dem.stop();
  });

  test('非法状态迁移抛 STATE_ERROR', async () => {
    const dem = new WavDemuxer(memorySource(buildWav()));
    assert.throws(() => dem.samples(1), (e) => e.code === ErrorCode.STATE_ERROR);
    await assert.rejects(() => dem.seek(0), (e) => e.code === ErrorCode.STATE_ERROR);
  });
});

/* ============================================================
 * 波形层（mock 2D context）
 * ============================================================ */

// ── §2.4：直播推送控制（pause/resume）与 initTimeoutMs 超时保护 ──
describe('WavDemuxer §2.4 推送控制与解析超时', () => {
  test('pause/resume 维护 pausedFlag 并 emit 事件', async () => {
    const dem = new WavDemuxer(memorySource(buildWav({ frames: 10 })));
    await dem.open();
    const fired = [];
    dem.on('pause', () => fired.push('pause'));
    dem.on('resume', () => fired.push('resume'));
    assert.equal(dem.pausedFlag, false);
    dem.pause();
    assert.equal(dem.pausedFlag, true);
    dem.resume();
    assert.equal(dem.pausedFlag, false);
    assert.deepEqual(fired, ['pause', 'resume']);
  });

  test('parseInit 超时 reject TIMEOUT（initTimeoutMs 生效）', async () => {
    const never = {
      size: 65536,
      read: () => new Promise(() => {}), // 永不 resolve，模拟卡死源
      close: () => {},
    };
    // 同 mkv：超时定时器 unref，测试须自行保活事件循环
    const keepAlive = setInterval(() => {}, 5);
    try {
      const dem = new WavDemuxer(never, { initTimeoutMs: 30 });
      await assert.rejects(() => dem.parseInit(), (err) => err?.code === 'TIMEOUT');
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe('computePeaks/drawWaveform', () => {
  function mockCtx() {
    const calls = [];
    return {
      calls,
      fillStyle: '',
      fillRect(x, y, w, h) { calls.push(['rect', x, y, w, h]); },
    };
  }

  test('峰值桶数量正确且包络对称合理', () => {
    const planar = [new Float32Array([0.1, -0.9, 0.5, -0.2, 0.7, -0.1])];
    const peaks = computePeaks(planar, 3);
    assert.equal(peaks.mins.length, 3);
    assert.equal(peaks.maxs.length, 3);
    // f32 存储存在精度误差，用容差断言
    assert.ok(Math.abs(peaks.mins[0] - (-0.9)) < 1e-6);
    assert.ok(Math.abs(peaks.maxs[2] - 0.7) < 1e-6);
  });

  test('drawWaveform 使用 accent 覆盖进度之前区域', () => {
    // 记录每次 fillRect 时快照到的填充色
    const calls = [];
    const ctx = {
      fillStyle: '',
      fillRect(x, y, w, h) { calls.push({ style: this.fillStyle, x, y, w, h }); },
    };
    Object.defineProperty(ctx, 'fillStyle', {
      set(v) { this._style = v; },
      get() { return this._style; },
    });
    const planar = [new Float32Array([0.5, -0.5, 0.5, -0.5])];
    drawWaveform(ctx, { width: 100, height: 50 }, computePeaks(planar, 4), 0.5,
      { bg: '#111111', dim: '#222222', accent: '#6c8cff' });
    // 第一笔是背景填充
    assert.deepEqual([calls[0].x, calls[0].y, calls[0].w, calls[0].h], [0, 0, 100, 50]);
    const barStyles = calls.slice(1).map((c) => c.style);
    // 进度 0.5 → 前 2 桶 accent，后 2 桶 dim
    assert.equal(barStyles.filter((s) => s === '#6c8cff').length, 2);
    assert.equal(barStyles.filter((s) => s === '#222222').length, 2);
  });

  test('空数据绘制只画背景不抛异常', () => {
    const ctx = mockCtx();
    drawWaveform(ctx, { width: 10, height: 10 }, { mins: new Float32Array(0), maxs: new Float32Array(0) }, 0);
    assert.equal(ctx.calls.length, 1);
  });
});
