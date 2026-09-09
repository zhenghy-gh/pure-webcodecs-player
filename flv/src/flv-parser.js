/**
 * flv-parser.js —— FLV 语义解析层（内部内核）
 *
 * 分帧由 ./tag-stream.js（FlvTagStream）承载——该低层面同时供 rtmp/WebSocket-FLV
 * 模块直接复用（契约：导出接口保持干净）。本文件在其上叠加媒体语义：
 *   ScriptTag(AMF0 onMetaData)、VideoTag(AVC 序列头/AVCPacketType/CompositionTime、
 *   非官方 CodecID=12 HEVC、Enhanced-FLV FourCC)、AudioTag(AACPacketType/ASC、MP3 直通)。
 *
 * 发出的事件（低层语义，供 FlvDemuxer 契约壳消费）：
 *   'header' {hasAudio,hasVideo}
 *   'metadata' {obj}
 *   'audio'  {soundFormat,packetType,asc?,data?,timestamp,hint?}
 *   'video'  {codecFamily,keyframe,packetType:'config'|'coded'|'end',configBytes?,data?,ctsMs,timestamp,enhanced}
 *   'error' / 'complete'(stats)
 */

import { Emitter } from './emitter.js';
import { decodeAmf0All } from './amf0.js';
import { FlvTagStream, FLV_TAG_AUDIO, FLV_TAG_VIDEO, FLV_TAG_SCRIPT } from './tag-stream.js';

/** Enhanced-FLV 视频四字符码 → 编码族 */
const FOURCC_MAP = {
  0x61766331: 'avc',      // 'avc1'
  0x61766333: 'avc',      // 'avc3'
  0x68766331: 'hevc',     // 'hvc1'
  0x68657631: 'hevc',     // 'hev1'
  0x61763031: 'av1',      // 'av01'
  0x76703039: 'vp9',      // 'vp09'
};

const SOUND_FORMATS = {
  2: 'mp3',
  10: 'aac',
  11: 'speex',
};

export class FlvParser extends Emitter {
  constructor() {
    super();
    /** 低层分帧器（可复用面，见 ./tag-stream.js） */
    this.stream = new FlvTagStream();
    this.hasAudio = false;
    this.hasVideo = false;
    /** 统计信息（demo 展示用） */
    this.stats = { tags: 0, audioTags: 0, videoTags: 0, scriptTags: 0, bytesParsed: 0 };

    /* ---- 字节偏移与关键帧索引（DataSource 模式 seek 使用，契约薄壳驱动） ---- */
    /** 批次原点平移（demuxer 外壳在每次喂入前设置；透传给流遍历器） */
    this.baseOffset = 0;
    /** 视频关键帧索引：[{timestampMs, offset}]，offset 指向该 Tag 头起始绝对位置 */
    this.keyframeIndex = [];
    this._headerEmitted = false;
  }

  static probe(bytes) {
    return bytes && bytes.length >= 3 &&
      bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56; // 'FLV'
  }

  /**
   * @param {Uint8Array|ArrayBuffer} chunk
   */
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    if (chunk.length === 0 || this.stream.finished) return;
    this.stream.baseOffset = this.baseOffset;
    let tags;
    try {
      tags = this.stream.push(chunk);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    if (!this._headerEmitted && this.stream.headerDone) {
      this._headerEmitted = true;
      this.hasAudio = this.stream.header.hasAudio;
      this.hasVideo = this.stream.header.hasVideo;
      this.emit('header', { hasAudio: this.hasAudio, hasVideo: this.hasVideo });
    }
    for (const tag of tags) this._onTag(tag);
  }

  /** 单个完整 Tag 的语义分发 */
  _onTag(tag) {
    this.stats.tags++;
    this.stats.bytesParsed += TAG_WIRE_SIZE(tag.data.length);

    if (tag.type === FLV_TAG_AUDIO) {
      this.stats.audioTags++;
      this._parseAudio(tag.data, tag.timestamp);
    } else if (tag.type === FLV_TAG_VIDEO) {
      this.stats.videoTags++;
      this._recordKeyframe(tag, tag.data);
      this._parseVideo(tag.data, tag.timestamp);
    } else if (tag.type === FLV_TAG_SCRIPT) {
      this.stats.scriptTags++;
      this._parseScript(tag.data);
    }
  }

  /** 视频关键帧 coded 帧记入索引（含 Enhanced-FourCC 与非官方 CodecID=12） */
  _recordKeyframe(tag, data) {
    if (data.length < 5) return;
    const frameType = (data[0] >> 4) & 0x0f;
    const fourcc = ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;
    const enhanced = FOURCC_MAP[fourcc] !== undefined;
    let keyCoded = false;
    if (enhanced) {
      keyCoded = frameType === 1 && data[5] === 1;
    } else {
      const codecId = data[0] & 0x0f;
      keyCoded = frameType === 1
        && (codecId === 7 || codecId === 12)
        && data.length >= 2 && data[1] === 1;
    }
    if (keyCoded) this.keyframeIndex.push({ timestampMs: tag.timestamp, offset: tag.offset });
  }

  flush() {
    // FLV 尾部不足一个完整 tag 时属于流被截断：尽力丢弃并结束
    this.stream.end();
    this.emit('complete', { ...this.stats });
  }

  /**
   * seek 后恢复解析的中间态准备：
   * 跳过文件头校验（配置已由 demuxer 外壳持有），从指定偏移继续吃 Tag；
   * 关键帧索引保留 seek 点之前的条目。
   * @param {{hasAudio:boolean, hasVideo:boolean}} flags
   * @param {{keepIndexBeforeOffset?: number}} [opts]
   */
  prepareSeekResume(flags, opts = {}) {
    const keep = opts.keepIndexBeforeOffset ?? Infinity;
    this.keyframeIndex = this.keyframeIndex.filter((e) => e.offset <= keep);
    this.stream.resumeMidStream(flags);
    this._headerEmitted = true;
    this.hasAudio = !!flags.hasAudio;
    this.hasVideo = !!flags.hasVideo;
  }

  reset() {
    this.stream.reset();
    this.hasAudio = false;
    this.hasVideo = false;
    this._headerEmitted = false;
    this.keyframeIndex.length = 0;
    this.stats = { tags: 0, audioTags: 0, videoTags: 0, scriptTags: 0, bytesParsed: 0 };
  }

  // ---------- 音频 ----------

  _parseAudio(data, ts) {
    if (data.length < 1) return;
    const b0 = data[0];
    const formatId = (b0 >> 4) & 0x0f;
    const format = SOUND_FORMATS[formatId];
    const soundRateTable = [5512, 11025, 22050, 44100];
    const legacyRate = soundRateTable[(b0 >> 2) & 0x03];
    const sampleSizeBits = (b0 >> 1) & 0x01 ? 16 : 8;
    const channels = (b0 & 0x01) ? 2 : 1;

    if (format === 'aac') {
      if (data.length < 2) return;
      const packetType = data[1];
      if (packetType === 0) {
        this.emit('audio', {
          soundFormat: 'aac', packetType: 'config',
          asc: data.slice(2), timestamp: ts,
        });
      } else if (packetType === 1) {
        this.emit('audio', {
          soundFormat: 'aac', packetType: 'raw',
          data: data.slice(2), timestamp: ts,
        });
      }
      return;
    }
    // 非 AAC（如 MP3）：整段作为裸样本直通
    this.emit('audio', {
      soundFormat: format ?? `unknown(${formatId})`, packetType: 'raw',
      data: data.slice(1), timestamp: ts,
      hint: { legacyRate, sampleSizeBits, channels },
    });
  }

  // ---------- 视频 ----------

  _parseVideo(data, ts) {
    if (data.length < 1) return;
    const frameType = (data[0] >> 4) & 0x0f;
    const keyframe = frameType === 1;
    if (frameType === 5) {
      // Video Info/Command Frame（Enhanced-RTMP 定义），本项目忽略
      return;
    }

    // ---- Enhanced-FLV：FrameType 后跟 32bit FourCC ----
    if (data.length >= 6) {
      const fourcc = ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;
      const family = FOURCC_MAP[fourcc];
      if (family) {
        const packetType = data[5];
        let body = data.slice(6);
        let ctsMs = 0;
        if (packetType === 1 && (family === 'avc' || family === 'hevc') && body.length >= 3) {
          ctsMs = readS24(body);
          body = body.slice(3);
        }
        this.emit('video', {
          codecFamily: family,
          keyframe,
          packetType: packetType === 0 ? 'config' : packetType === 1 ? 'coded' : 'end',
          configBytes: packetType === 0 ? body : undefined,
          data: packetType === 1 ? body : undefined,
          ctsMs,
          timestamp: ts,
          enhanced: true,
        });
        return;
      }
    }

    // ---- 传统路径：低 4 位为 CodecID ----
    const codecId = data[0] & 0x0f;
    if (codecId === 7 || codecId === 12) {
      // AVCVIDEOPACKET / 非官方 HEVC（布局与 AVC 相同）
      if (data.length < 5) return;
      const avcPacketType = data[1];
      const ctsMs = readS24(data.subarray(2, 5));
      const body = data.slice(5);
      const event = {
        codecFamily: codecId === 7 ? 'avc' : 'hevc',
        keyframe,
        ctsMs,
        timestamp: ts,
        enhanced: false,
      };
      if (avcPacketType === 0) {
        this.emit('video', { ...event, packetType: 'config', configBytes: body });
      } else if (avcPacketType === 1) {
        this.emit('video', { ...event, packetType: 'coded', data: body });
      }
      // type 2 = AVC end of sequence：忽略
      return;
    }
    this.emit('error', new Error(`FLV: 暂不支持的视频 CodecID=${codecId}`));
  }

  // ---------- 脚本 ----------

  _parseScript(data) {
    const values = decodeAmf0All(data);
    if (values.length >= 2 && typeof values[0] === 'string' && values[0].toLowerCase() === 'onmetadata') {
      const obj = values[1];
      if (obj && typeof obj === 'object') {
        this.emit('metadata', obj);
        return;
      }
    }
    // 其他脚本事件（@setDataFrame 等）忽略
  }
}

/** Tag 在字节流中的线缆长度（头+数据+PreviousTagSize） */
function TAG_WIRE_SIZE(dataSize) {
  return 11 + dataSize + 4;
}

/** 有符号 24 位整数（CompositionTime） */
function readS24(bytes) {
  let v = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  if (v & 0x800000) v -= 0x1000000;   // 符号扩展
  return v;
}
