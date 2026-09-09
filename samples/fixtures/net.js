/**
 * samples/fixtures/net.js —— RTSP/RTP 相关 fixture：makeSDP() 与 makeRTPH264Packet(s)。
 * 供 rtmp/rtsp/webrtc 等网络模块的 __tests__ 使用。
 */

import { concat, ascii, u8 } from './bytes.js';
import { FAKE_SPS, FAKE_PPS } from './codecs.js';

/** 字节 → base64（Node≥16 与浏览器都有 btoa 全局，属稳定 API） */
function base64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 字节 → 连续小写十六进制（RFC 6184 的 profile-level-id 形如 '42001e'） */
function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成一段 H.264 直播流的会话描述（行尾 CRLF，符合 SDP 规范）。
 * @param {object} [opts]
 * @param {string} [opts.ip='127.0.0.1']
 * @param {number} [opts.port=5004]
 * @param {number} [opts.payloadType=96] 动态 PT
 * @param {number} [opts.clockRate=90000]
 */
export function makeSDP(opts = {}) {
  const {
    ip = '127.0.0.1',
    port = 5004,
    payloadType = 96,
    clockRate = 90000,
  } = opts;

  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 ' + ip,
    's=H.264 Test Stream (fixtures)',
    'c=IN IP4 ' + ip,
    't=0 0',
    `m=video ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} H264/${clockRate}`,
    // sprop-parameter-sets 用伪造 SPS/PPS 的 base64（与 codecs.js 保持同源）
    `a=fmtp:${payloadType} packetization-mode=1;profile-level-id=${hex(FAKE_SPS.subarray(1, 4))};sprop-parameter-sets=${base64(FAKE_SPS)},${base64(FAKE_PPS)}`,
    'a=control:trackID=0',
  ];
  const text = lines.join('\r\n') + '\r\n';
  return { text: lines.join('\r\n'), bytes: ascii(text), meta: { ip, port, payloadType, clockRate, spsB64: base64(FAKE_SPS), ppsB64: base64(FAKE_PPS) } };
}

/* ---------------- RTP ---------------- */

/**
 * 组装单个 RTP 包头（12 字节，无扩展/CSRC）+ 载荷。
 * RTP 固定头：V(2)=10 P X CC(4)=0000 → 首字节 0x80；M + PT 次字节；seq/timestamp/ssrc 大端。
 * @param {object} o
 * @param {Uint8Array} o.payload     载荷（单 NAL 或 FU-A 分片之一）
 * @param {number} [o.seq=0]         序号（u16 回绕）
 * @param {number} [o.timestamp=0]   时间戳（90kHz）
 * @param {number} [o.ssrc=0x12345678]
 * @param {boolean} [o.marker=false] 标志位（帧末置位）
 * @param {number} [o.pt=96]
 */
export function makeRTPH264Packet({ payload, seq = 0, timestamp = 0, ssrc = 0x12345678, marker = false, pt = 96 }) {
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  head[0] = 0x80; // V=2, P=X=CC=0
  head[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  dv.setUint16(2, seq & 0xffff);
  dv.setUint32(4, timestamp >>> 0);
  dv.setUint32(8, ssrc >>> 0);
  return concat(head, payload);
}

/**
 * 把一个 Annex-B NAL 打包成 RTP/H264 序列：
 *   - 不超过 mtu 时用 Single NAL Unit Packet；
 *   - 超过时自动 FU-A 分片（首片 S=1、末片 E=1 且带 marker）。
 * 返回完整 RTP 包数组；meta.reassembled 可还原原始 NAL 字节（测试直接复用该逻辑）。
 * @param {object} [o]
 * @param {Uint8Array} [o.nal]        原始 NAL（含 1 字节 NAL 头）
 * @param {number}   [o.mtu=64]       单包载荷上限
 * @param {number}   [o.seq=0]        起始序号
 * @param {number}   [o.timestamp=0]
 * @param {number}   [o.ssrc=0x12345678]
 */
export function makeRTPH264Packets(o = {}) {
  const {
    nal = defaultNal(),
    mtu = 64,
    seq = 0,
    timestamp = 0,
    ssrc = 0x12345678,
  } = o;
  if (!nal || nal.length < 1) throw new Error('nal 不能为空');
  const nalHeader = nal[0];
  const nalType = nalHeader & 0x1f;
  const nri = nalHeader & 0x60;

  const packets = [];
  if (nal.length <= mtu) {
    packets.push(makeRTPH264Packet({ payload: nal, seq, timestamp, ssrc, marker: true }));
    return { packets, meta: { mode: 'single-nal', reassembled: Uint8Array.from(nal), nalType, count: packets.length } };
  }

  /* FU-A：FU indicator 保留 F/NRI 并置 type=28；FU header 承载真实 type 与 S/E 位 */
  const body = nal.subarray(1);
  const chunkSize = Math.min(mtu - 2, Math.ceil(body.length / Math.ceil(body.length / (mtu - 2))));
  for (let pos = 0; pos < body.length; pos += chunkSize) {
    const chunk = body.subarray(pos, pos + chunkSize);
    const isFirst = pos === 0;
    const isLast = pos + chunk.length >= body.length;
    const indicator = (nalHeader & 0x80) | nri | 28;
    const fuHeader = ((isFirst ? 1 : 0) << 7) | ((isLast ? 1 : 0) << 6) | nalType;
    packets.push(makeRTPH264Packet({
      payload: concat(u8(indicator), u8(fuHeader), chunk),
      seq: seq + packets.length,
      timestamp,
      ssrc,
      marker: isLast,
    }));
  }
  return {
    packets,
    meta: {
      mode: 'fu-a',
      nalType,
      count: packets.length,
      get reassembled() {
        // 从分片还原 NAL：取首个 indicator 的 F/NRI + 任一 FU header 的真实 type 作为新头
        const ind = packets[0][12];
        const fuType = packets[0][13] & 0x1f;
        const chunks = packets.map((p) => p.subarray(14));
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total + 1);
        out[0] = (ind & 0xe0) | fuType;
        let off = 1;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      },
    },
  };
}

/** 默认演示 NAL：type=5 IDR，载荷 100 字节确定性伪数据（> 默认 mtu=64，触发 FU-A） */
function defaultNal() {
  const out = new Uint8Array(101);
  out[0] = 0x65;
  for (let i = 1; i < out.length; i++) out[i] = i & 0xff;
  return out;
}
