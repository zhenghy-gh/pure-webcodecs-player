/**
 * samples/fixtures/audio.js —— makeWAV() 与 makeFLACHeader()。
 * 输出确定（正弦波用固定相位计算，无随机数），结构字段全部自洽。
 */

import { u8, concat, ascii, u16le, u32le, u32be, BitWriter, BitReader } from './bytes.js';

/* ---------------- WAV ---------------- */

/**
 * 生成最小 RIFF/WAVE 文件：RIFF(WAVE fmt data)，PCM 16bit，单声道正弦。
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=8000]
 * @param {number} [opts.channels=1]
 * @param {number} [opts.durationSec=0.05]   时长（样本数 = round(rate*durationSec)）
 * @param {number} [opts.frequency=440]      正弦频率
 * @returns {{bytes: Uint8Array, meta: object}}
 */
export function makeWAV(opts = {}) {
  const {
    sampleRate = 8000,
    channels = 1,
    durationSec = 0.05,
    frequency = 440,
  } = opts;

  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const numSamples = Math.round(sampleRate * durationSec);
  const dataBytes = numSamples * blockAlign;

  // 正弦采样（确定性；振幅 0.5 满量程）
  const samples = new Int16Array(numSamples * channels);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 16383);
    for (let c = 0; c < channels; c++) samples[i * channels + c] = v;
  }
  const sampleBytes = new Uint8Array(samples.buffer);

  const fmt = concat([
    ascii('fmt '),
    u32le(16), // PCM fmt 块长度
    u16le(1), // audioFormat: PCM
    u16le(channels),
    u32le(sampleRate),
    u32le(sampleRate * blockAlign), // byteRate
    u16le(blockAlign),
    u16le(bitsPerSample),
  ]);
  const data = concat([ascii('data'), u32le(dataBytes), sampleBytes]);
  const riffBodyLen = 4 + fmt.length + data.length; // 'WAVE' + fmt块 + data块

  return {
    bytes: concat([ascii('RIFF'), u32le(riffBodyLen), ascii('WAVE'), fmt, data]),
    meta: {
      sampleRate, channels, bitsPerSample,
      numSamples,
      blockAlign,
      dataChunkOffset: 12 + fmt.length + 8, // RIFF头12 + fmt块 + data头8
      dataBytes,
      riffBodyLen,
      frequency,
    },
  };
}

/* ---------------- FLAC ---------------- */

/**
 * 生成 FLAC 文件头："fLaC" 魔数 + STREAMINFO 元数据块（34 字节，last-block 置位）。
 * STREAMINFO 位打包顺序：min/maxBlockSize(u16×2) → min/maxFrameSize(u24×2) →
 * sampleRate(20) → channels-1(3) → bitsPerSample-1(5) → totalSamples(36) → MD5(128bit)
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {number} [opts.channels=2]
 * @param {number} [opts.bitsPerSample=16]
 * @param {number} [opts.totalSamples=0] 0 表示流式/未知总长
 * @returns {{bytes: Uint8Array, meta: object}}
 */
export function makeFLACHeader(opts = {}) {
  const {
    sampleRate = 44100,
    channels = 2,
    bitsPerSample = 16,
    totalSamples = 0,
  } = opts;

  const w = new BitWriter();
  w.put(4096, 16); // min block size
  w.put(4096, 16); // max block size
  w.put(0, 24); // min frame size（未知）
  w.put(0, 24); // max frame size（未知）
  w.put(sampleRate, 20);
  w.put(channels - 1, 3);
  w.put(bitsPerSample - 1, 5);
  w.put(BigInt(totalSamples), 36);
  for (let i = 0; i < 16; i++) w.put(0, 8); // MD5 全零（未校验）
  const streamInfoBody = w.finish();
  if (streamInfoBody.length !== 34) throw new Error('STREAMINFO 必须为 34 字节');

  // 块头：last-flag(1) + type(7)=0(STREAMINFO) + 长度 u24
  const blockHeader = concat([u8(0x80), u32be(34).subarray(1)]);

  return {
    bytes: concat([ascii('fLaC'), blockHeader, streamInfoBody]),
    meta: {
      sampleRate, channels, bitsPerSample, totalSamples,
      isLastMetadataBlock: true,
      blockType: 0,
    },
  };
}

/** 从 STREAMINFO 体回读参数（测试与解析器参考实现） */
export function parseStreamInfo(body34) {
  const r = new BitReader(body34);
  return {
    minBlockSize: Number(r.read(16)),
    maxBlockSize: Number(r.read(16)),
    minFrameSize: Number(r.read(24)),
    maxFrameSize: Number(r.read(24)),
    sampleRate: Number(r.read(20)),
    channels: Number(r.read(3)) + 1,
    bitsPerSample: Number(r.read(5)) + 1,
    totalSamples: Number(r.read(36)),
  };
}
