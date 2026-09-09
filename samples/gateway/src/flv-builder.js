/**
 * FLV 字节流构建器（视频轨：H.264/AVC）。
 *
 * 产出符合 FLV 规范的字节序列：
 *   [9B 文件头][4B PreviousTagSize0]
 *   若干 Tag：[1B 类型][3B 数据长度][3B 时间戳低位][1B 时间戳扩展][3B 流ID]
 *             [TagData][4B PreviousTagSize]
 *
 * 关键内容：
 *   - onMetaData 元数据 Tag（AMF0 ECMA 数组）
 *   - AVC sequence header（含 avcC 解码配置记录）
 *   - 每帧一个 AVC NALU Tag（AVCC 长度前缀封装）
 */

import {
  makeParameterSets,
  makeIdrFrame,
  VIDEO_W,
  VIDEO_H,
  VIDEO_FPS,
  PROFILE_IDC,
  CONSTRAINT_FLAGS,
  LEVEL_IDC,
} from './media/h264-pcm.js';

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_SCRIPT = 18;

function u24(n) {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** AMF0 编码工具（仅网关元数据所需的子集） */
function amfString(s) {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x02]), u24be16(body.length), body]);
}
function u24be16(n) {
  const b = Buffer.alloc(2);
  b[0] = (n >> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}
function amfNumber(n) {
  const b = Buffer.alloc(9);
  b[0] = 0x00;
  b.writeDoubleBE(n, 1);
  return b;
}
/** ECMA 数组（按 onMetaData 惯例）；值若是 number 自动按 AMF0 Number 包装 */
function amfEcmaArray(entries) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(entries.length);
  const parts = [Buffer.from([0x08]), head];
  for (const [k, v] of entries) {
    const val = typeof v === 'number' ? amfNumber(v) : v;
    parts.push(u24be16(Buffer.byteLength(k)), Buffer.from(k, 'utf8'), val);
  }
  parts.push(Buffer.from([0x00, 0x00, 0x09])); // 数组结束标记
  return Buffer.concat(parts);
}

/** avcC（AVCDecoderConfigurationRecord）：MSE init segment 与 WebCodecs description 都用它。 */
export function makeAvcC() {
  const { sps, pps } = makeParameterSets();
  const spsBuf = Buffer.from(sps);
  const ppsBuf = Buffer.from(pps);
  return Buffer.concat([
    Buffer.from([
      0x01, // configurationVersion
      PROFILE_IDC,
      CONSTRAINT_FLAGS,
      LEVEL_IDC,
      0xff, // reserved 6bit + lengthSizeMinusOne=3（4 字节 NAL 长度前缀）
      0xe1, // reserved 3bit + numOfSequenceParameterSets-1 = 0
    ]),
    Buffer.from([(spsBuf.length >> 8) & 0xff, spsBuf.length & 0xff]), spsBuf,
    Buffer.from([0x01]),
    Buffer.from([(ppsBuf.length >> 8) & 0xff, ppsBuf.length & 0xff]), ppsBuf,
  ]);
}

/** 组装一帧 AVCC 封装（每 NAL 前 4 字节大端长度） */
export function avccFrame(frameIndex) {
  const nal = makeIdrFrame(frameIndex);
  const head = Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00]); // keyframe|AVC, AVCPacketType=NALU, CTS=0
  const len = Buffer.alloc(4);
  len.writeUInt32BE(nal.length);
  return Buffer.concat([head, len, nal]);
}

function scriptTag() {
  const meta = amfEcmaArray([
    ['duration', 0],
    ['width', VIDEO_W],
    ['height', VIDEO_H],
    ['framerate', VIDEO_FPS],
    ['videocodecid', 7],
    ['videodatarate', 0],
  ]);
  return Buffer.concat([amfString('onMetaData'), meta]);
}

function tagHeader(type, dataLen, tsMs) {
  const h = Buffer.alloc(11);
  h[0] = type;
  h[1] = (dataLen >> 16) & 0xff;
  h[2] = (dataLen >> 8) & 0xff;
  h[3] = dataLen & 0xff;
  // FLV 时间戳为毫秒：低 3 字节 + 第 8 字节存最高位
  const t = Math.round(tsMs);
  h[4] = (t >>> 16) & 0xff;
  h[5] = (t >>> 8) & 0xff;
  h[6] = t & 0xff;
  h[7] = (t >>> 24) & 0xff; // TimestampExtended
  // StreamID 恒为 0（h[8..10] 已是 0）
  return h;
}

/** 序列化单个 Tag 为完整字节块（TagHeader + Data + PreviousTagSize） */
export function serializeTag(type, tsMs, data) {
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length);
  return Buffer.concat([tagHeader(type, data.length, tsMs), Buffer.from(data), prev]);
}

/** 一个推送周期的全部 Tag 描述 */
export function buildFlvTags(frameCount = VIDEO_FPS * 6) {
  const tags = [];
  let ts = 0;
  const stepMs = 1000 / VIDEO_FPS;
  tags.push({ type: TAG_VIDEO, ts: 0, data: Buffer.concat([Buffer.from([0x17, 0x00, 0, 0, 0]), makeAvcC()]) });
  tags.push({ type: TAG_SCRIPT, ts: 0, data: scriptTag() });
  for (let i = 0; i < frameCount; i++) {
    tags.push({ type: TAG_VIDEO, ts, data: avccFrame(i) });
    ts += stepMs;
  }
  return { tags, cycleDurationMs: ts };
}

/** FLV 文件头 + PreviousTagSize0 */
export function flvFileHeader() {
  return Buffer.concat([
    Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x01, 0, 0, 0, 0x09]), // 'FLV' ver1 flags=video hdrsize=9
    Buffer.alloc(4),
  ]);
}

/**
 * 循环推流器：维护一个周期内的 Tag 序列，跨周期保持时间戳单调递增。
 */
export class FlvLoopSource {
  constructor({ frameCount = VIDEO_FPS * 6 } = {}) {
    const { tags, cycleDurationMs } = buildFlvTags(frameCount);
    this.tags = tags;
    this.cycleDurationMs = cycleDurationMs;
    this.epoch = 0; // 当前周期基准时间戳（毫秒）
    this.cursor = 0; // 周期内游标（跳过头部两个配置 Tag 后开始）
    this.started = false;
  }

  /** 连接建立后的首块：文件头 + 配置 Tag（sequence header / metadata） */
  initChunk() {
    const parts = [flvFileHeader()];
    parts.push(serializeTag(TAG_VIDEO, 0, this.tags[0].data));
    parts.push(serializeTag(TAG_SCRIPT, 0, this.tags[1].data));
    this.started = true;
    this.cursor = 2;
    return Buffer.concat(parts);
  }

  /** 取接下来 count 个媒体 Tag（自动跨周期续时间戳） */
  take(count) {
    const out = [];
    for (let i = 0; i < count && this.started; i++) {
      const t = this.tags[this.cursor];
      out.push(serializeTag(t.type, Math.round(this.epoch + t.ts), t.data));
      this.cursor++;
      if (this.cursor >= this.tags.length) {
        this.cursor = 2;
        this.epoch += this.cycleDurationMs;
      }
    }
    return out;
  }
}
