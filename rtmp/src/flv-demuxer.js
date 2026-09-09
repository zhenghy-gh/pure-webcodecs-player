/**
 * FLV 解复用器（增量式，半包/粘包安全）。
 *
 * 字节流布局：
 *   [9B header: 'FLV' ver flags hdrsize=9][4B PreviousTagSize0]
 *   Tag*: [1B type][3B dataSize][3B tsLow][1B tsExt][3B streamId][data][4B PreviousTagSize]
 *
 * 输出事件（时间在输出边界换算为整数微秒，契约 §0.5；FLV 原生毫秒仅内部表示）：
 *   'header'   { hasAudio, hasVideo }
 *   'metadata' onMetaData 对象（script tag）
 *   'track'    { kind:'video', codec:'h264', description:avcC } | { kind:'audio', codec:'aac', description:ASC, sampleRate, channels }
 *   'sample'   { kind:'video'|'audio', data:Uint8Array(AVCC/裸AAC), dtsUs, ptsUs, durationUs:0, keyframe }
 *   'error'    PlayerError('PARSE_ERROR')（非致命：跳过坏 Tag 继续尽力解析）
 */

import { MiniEmitter } from './mini-emitter.js';
import { AmfReader } from './amf.js';
import { errors } from './errors.js';

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_SCRIPT = 18;

/** FLV 头 9B + PreviousTagSize0 4B */
const HEADER_TOTAL = 13;
const TAG_HEADER_LEN = 11;
/** 防御上限：单 Tag 声明长度超过此值视为流损坏 */
const MAX_TAG_SIZE = 8 * 1024 * 1024;

export class FlvDemuxer extends MiniEmitter {
  constructor(options = {}) {
    super();
    this.opts = { parseScriptTags: options.parseScriptTags !== false };
    this.buffer = new Uint8Array(0);
    this.headerParsed = false;
    this.hasVideo = false;
    this.hasAudio = false;
    this.metadata = null;
    /** @type {Map<string, object>} kind → track 描述 */
    this.tracks = new Map();
    this.sampleCount = 0;
    this._destroyed = false;
  }

  /** 喂入任意大小的字节分块（半包/粘包安全） */
  push(bytes) {
    if (this._destroyed) throw errors.state('demuxer 已销毁');
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!u8.length) return;
    this.buffer = concat(this.buffer, u8);
    this.#drain();
  }

  /** 流结束：冲出残余（不完整的尾 Tag 直接丢弃并告警） */
  flush() {
    if (!this.headerParsed && this.buffer.length > 0) {
      this.#emitError(errors.parse('流结束但未识别到 FLV 头'));
    } else if (this.buffer.length > 0) {
      // 尾部不足一个完整 Tag：静默丢弃（直播断流常态）
    }
    this.buffer = new Uint8Array(0);
    this.emit('done', { samples: this.sampleCount });
  }

  destroy() {
    this._destroyed = true;
    this.removeAllListeners();
  }

  #drain() {
    if (!this.headerParsed) {
      if (this.buffer.length === 0) return;
      // 魔数嗅探：容忍流前混入垃圾字节（meta 缺席场景的消费端兜底）
      const idx = findFlvMagic(this.buffer);
      if (idx < 0) {
        // 可能魔数被半包切断：仅保留末尾 3 字节继续等待
        if (this.buffer.length > 3) {
          this.#emitError(errors.parse('FLV 魔数缺失'));
          this.buffer = this.buffer.subarray(this.buffer.length - 3);
        }
        return;
      }
      if (idx > 0) {
        this.emit('warn', `跳过 ${idx} 字节垃圾前缀`);
        this.buffer = this.buffer.subarray(idx);
      }
      if (this.buffer.length < HEADER_TOTAL) return;
      if (!(this.buffer[0] === 0x46 && this.buffer[1] === 0x4c && this.buffer[2] === 0x56)) {
        this.#emitError(errors.parse('FLV 魔数缺失'));
        this.buffer = new Uint8Array(0);
        return;
      }
      this.hasAudio = (this.buffer[4] & 0x04) !== 0;
      this.hasVideo = (this.buffer[4] & 0x01) !== 0;
      this.headerParsed = true;
      this.emit('header', { hasAudio: this.hasAudio, hasVideo: this.hasVideo, version: this.buffer[3] });
      this.buffer = this.buffer.subarray(HEADER_TOTAL);
    }

    for (;;) {
      const buf = this.buffer;
      if (buf.length < TAG_HEADER_LEN) return;
      const type = buf[0];
      const dataSize = (buf[1] << 16) | (buf[2] << 8) | buf[3];
      const tsLow = (buf[4] << 16) | (buf[5] << 8) | buf[6];
      const tsExt = buf[7];
      const dtsMs = tsExt * 0x1000000 + tsLow; // FLV 时间戳为毫秒（24 位 + 扩展高 8 位）
      const total = TAG_HEADER_LEN + dataSize + 4;
      if (dataSize > MAX_TAG_SIZE) {
        this.#emitError(errors.parse(`Tag 长度异常 ${dataSize}`));
        this.buffer = new Uint8Array(0);
        return;
      }
      if (buf.length < total) return; // 半包等待

      const data = buf.subarray(TAG_HEADER_LEN, TAG_HEADER_LEN + dataSize);
      try {
        this.#dispatchTag(type, dtsMs, data);
      } catch (err) {
        this.#emitError(errors.parse(`Tag 解析失败(type=${type}): ${err?.message ?? err}`));
      }
      // PreviousTagSize 校验（宽松：只消费，不匹配时告警一次）
      const prevSize = (buf[TAG_HEADER_LEN + dataSize] << 24) | (buf[TAG_HEADER_LEN + dataSize + 1] << 16)
        | (buf[TAG_HEADER_LEN + dataSize + 2] << 8) | buf[TAG_HEADER_LEN + dataSize + 3];
      if (prevSize !== dataSize + TAG_HEADER_LEN) {
        this.emit('warn', `PreviousTagSize 不匹配 (${prevSize} ≠ ${dataSize + TAG_HEADER_LEN})`);
      }
      this.buffer = buf.subarray(total);
    }
  }

  #dispatchTag(type, dtsMs, data) {
    switch (type) {
      case TAG_SCRIPT:
        if (this.opts.parseScriptTags) this.#parseScript(data);
        break;
      case TAG_VIDEO:
        this.#parseVideo(dtsMs, data);
        break;
      case TAG_AUDIO:
        this.#parseAudio(dtsMs, data);
        break;
      default:
        // 未知 Tag 类型：跳过（规范允许）
        break;
    }
  }

  #parseScript(data) {
    const reader = new AmfReader(data);
    const cmd = reader.readCommand();
    if (cmd.name === 'onMetaData' && cmd.args.length) {
      this.metadata = cmd.args[0];
      // 元数据中的宽高补进视频轨描述
      const vt = this.tracks.get('video');
      if (vt && typeof this.metadata.width === 'number') vt.width = this.metadata.width;
      if (vt && typeof this.metadata.height === 'number') vt.height = this.metadata.height;
      this.emit('metadata', this.metadata);
    } else {
      this.emit('metadata', { name: cmd.name });
    }
  }

  #parseVideo(dtsMs, data) {
    if (data.length < 1) return;
    const first = data[0];
    const frameType = first >> 4;
    const codecId = first & 0x0f;
    if (codecId === 7) {
      // AVC/AVCC 封装
      if (data.length < 5) return;
      const avcPacketType = data[1];
      const ctsBytes = (data[2] << 16) | (data[3] << 8) | data[4];
      // SI24 有符号（组合时间偏移可为负）
      const ctsMs = ctsBytes & 0x800000 ? ctsBytes - 0x1000000 : ctsBytes;

      if (avcPacketType === 0) {
        // AVC sequence header → avcC
        const avcC = data.subarray(5);
        this.tracks.set('video', {
          kind: 'video',
          codec: 'h264',
          codecString: avcCodecString(avcC),
          description: avcC.slice(),
          bitstreamFormat: 'avc',
          width: null,
          height: null,
        });
        this.emit('track', this.tracks.get('video'));
        return;
      }
      if (avcPacketType === 1) {
        const track = this.tracks.get('video');
        if (!track) return; // 未收到配置前丢弃样本
        const dtsUs = dtsMs * 1000;
        const sample = {
          kind: 'video',
          data: data.subarray(5), // AVCC 长度前缀 NAL 序列
          dtsUs,
          ptsUs: dtsUs + ctsMs * 1000, // ms→µs 在输出边界完成（§0.5）
          keyframe: frameType === 1,
          durationUs: 0,
        };
        this.sampleCount++;
        this.emit('sample', sample);
      }
      // avcPacketType===2: AVC end of sequence，忽略
      return;
    }
    // 非 AVC 视频编解码（H263/VP6 等）：声明 NOT_SUPPORTED（§11.3），不中断解析其余轨
    this.#emitError(errors.notSupported(`暂不支持的视频 CodecID=${codecId}`));
  }

  #parseAudio(dtsMs, data) {
    if (data.length < 1) return;
    const first = data[0];
    const format = first >> 4;
    if (format === 10) {
      // AAC
      if (data.length < 2) return;
      const aacPacketType = data[1];
      if (aacPacketType === 0) {
        const asc = data.subarray(2);
        const parsed = parseAudioSpecificConfig(asc);
        this.tracks.set('audio', {
          kind: 'audio',
          codec: 'aac',
          codecString: 'mp4a.40.2',
          description: asc.slice(),
          bitstreamFormat: 'aac-raw',
          sampleRate: parsed.sampleRate,
          numberOfChannels: parsed.channels,
        });
        this.emit('track', this.tracks.get('audio'));
        return;
      }
      const track = this.tracks.get('audio');
      if (!track) return;
      const sample = {
        kind: 'audio',
        data: data.subarray(2),
        dtsUs: dtsMs * 1000,
        ptsUs: dtsMs * 1000,
        keyframe: true,
        durationUs: 0, // AAC 每帧固定 1024 采样 / 采样率，由消费端计算
      };
      this.sampleCount++;
      this.emit('sample', sample);
      return;
    }
    // MP3(2)/线性 PCM 等本期不支持
    this.#emitError(errors.notSupported(`暂不支持音频 SoundFormat=${format}`));
  }

  #emitError(err) {
    this.emit('error', err);
  }
}

/**
 * 从 avcC 提取 RFC 6381 codec string：avc1.PPCCLL（profile/compat/level 十六进制）。
 */
export function avcCodecString(avcC) {
  if (!avcC || avcC.length < 4) return 'avc1.42e01e';
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/**
 * 解析 AudioSpecificConfig 的采样率与声道数（AAC-LC 常见形态，5bit objectType + 4bit freqIdx + 4bit chCfg）。
 */
export function parseAudioSpecificConfig(asc) {
  if (!asc || asc.length < 2) return { sampleRate: 44100, channels: 2 };
  const freqTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let pos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
  readBits(5); // audioObjectType
  const freqIdx = readBits(4);
  const channels = readBits(4);
  const sampleRate = freqIdx === 15 ? 0 : freqTable[freqIdx] ?? 44100;
  return { sampleRate: sampleRate || 44100, channels: channels || 2 };
}

function findFlvMagic(buf) {
  for (let i = 0; i + 3 <= Math.min(buf.length, HEADER_TOTAL * 4); i++) {
    if (buf[i] === 0x46 && buf[i + 1] === 0x4c && buf[i + 2] === 0x56) return i;
  }
  return -1;
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
