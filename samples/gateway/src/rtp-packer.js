/**
 * RTP 打包器（发送侧，供 rtsp-ws 中继使用）。
 *
 * H.264 按 RFC 6184 打包：
 *   - 单 NAL 包（nal type 1~23）
 *   - STAP-A（type 24）：一个 AU 内多个小 NAL 聚合，条目前置 2 字节长度
 *   - FU-A（type 28）：大 NAL 分片，S/E 位标记首尾
 * 时间戳单位 90kHz，同一 AU 的所有包共享时间戳，末包置 Marker。
 */

export const RTP_VERSION = 2;

/**
 * 序列化一个 RTP 包头 + 载荷。
 * @param {object} o
 * @param {boolean} [o.marker=false]
 * @param {number} o.payloadType
 * @param {number} o.sequence
 * @param {number} o.timestamp 90kHz ticks
 * @param {number} o.ssrc
 * @param {Uint8Array} o.payload
 */
export function serializeRtp({ marker = false, payloadType, sequence, timestamp, ssrc, payload }) {
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, (RTP_VERSION << 6) | 0x00); // V=2 P=0 X=0 CC=0
  dv.setUint8(1, (marker ? 0x80 : 0) | (payloadType & 0x7f));
  dv.setUint16(2, sequence & 0xffff);
  dv.setUint32(4, timestamp >>> 0);
  dv.setUint32(8, ssrc >>> 0);
  out.set(payload, 12);
  return out;
}

function nalRefIdc(nal0) {
  return (nal0 >> 5) & 3;
}
function nalType(nal0) {
  return nal0 & 0x1f;
}

/**
 * 将单个 NAL 打成若干 RTP 包（单包或 FU-A）。
 * @param {Uint8Array} nal 完整 NAL 单元（含首字节 header）
 */
export function packetizeNal(nal, { mtu = 1200 } = {}) {
  if (nal.length <= mtu) {
    return [{ fuIndicator: null, fuHeader: null, payload: nal.slice() }];
  }
  // FU-A：indicator 复用原 NAL 的 NRI，type=28；FU header 携带原始类型与 S/E 位
  const indicator = (nalRefIdc(nal[0]) << 5) | 28;
  const origType = nalType(nal[0]);
  const body = nal.subarray(1); // 去掉原 NAL header
  const chunkSize = mtu - 2; // indicator + fuHeader 占 2 字节
  const packets = [];
  let offset = 0;
  while (offset < body.length) {
    const end = Math.min(offset + chunkSize, body.length);
    packets.push({
      fuIndicator: indicator,
      fuHeader: ((offset === 0 ? 0x80 : 0) | (end === body.length ? 0x40 : 0)) | origType,
      payload: body.subarray(offset, end),
    });
    offset = end;
  }
  return packets;
}

/**
 * 把一帧（AU，多个 NAL）打包为完整 RTP 包序列。
 * 策略：总长不超 MTU 且 NAL 数 >1 时聚合为 STAP-A；否则逐 NAL 单包/FU-A。
 *
 * @param {Uint8Array[]} nals
 * @param {object} o
 * @returns {{bytes:Uint8Array, last:boolean}[]}
 */
export function packetizeAccessUnit(nals, { mtu = 1200, payloadType = 96, sequence, timestamp, ssrc }) {
  const results = [];
  let seq = sequence & 0xffff;

  const total = nals.reduce((n, x) => n + x.length, 0);
  if (nals.length > 1 && total + 2 * nals.length + 1 <= mtu) {
    // STAP-A 聚合
    const parts = [];
    for (const nal of nals) {
      parts.push(new Uint8Array([(nal.length >> 8) & 0xff, nal.length & 0xff]), nal);
    }
    let len = 1;
    for (const p of parts) len += p.length;
    const stapPayload = new Uint8Array(len);
    stapPayload[0] = (nalRefIdc(Math.max(...nals.map((n) => n[0]))) << 5) | 24;
    let off = 1;
    for (const p of parts) {
      stapPayload.set(p, off);
      off += p.length;
    }
    results.push({
      bytes: serializeRtp({ marker: true, payloadType, sequence: seq++, timestamp, ssrc, payload: stapPayload }),
      last: true,
    });
    return results;
  }

  nals.forEach((nal, idx) => {
    const chunks = packetizeNal(nal, { mtu });
    chunks.forEach((c, ci) => {
      const isLastOfAu = idx === nals.length - 1 && ci === chunks.length - 1;
      let payload;
      if (c.fuIndicator !== null) {
        payload = new Uint8Array(2 + c.payload.length);
        payload[0] = c.fuIndicator;
        payload[1] = c.fuHeader;
        payload.set(c.payload, 2);
      } else {
        payload = c.payload;
      }
      results.push({
        bytes: serializeRtp({ marker: isLastOfAu, payloadType, sequence: seq++, timestamp, ssrc, payload }),
        last: isLastOfAu,
      });
    });
  });
  return results;
}

/** 最小 RTCP Sender Report（PT=200，1 个报告块），用于 interleaved 奇数信道演示 */
export function makeSenderReport({ ssrc, rtpTimestamp, packetCount, octetCount, ntpSec, ntpFrac }) {
  const buf = new Uint8Array(28 + 24);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, (2 << 6) | 1); // V=2 P=0 RC=1
  dv.setUint8(1, 200); // PT=SR
  dv.setUint16(2, (28 + 24) / 4 - 1); // length in words - 1
  dv.setUint32(4, ssrc >>> 0);
  dv.setUint32(8, ntpSec >>> 0);
  dv.setUint32(12, ntpFrac >>> 0);
  dv.setUint32(16, rtpTimestamp >>> 0);
  dv.setUint32(20, packetCount >>> 0);
  dv.setUint32(24, octetCount >>> 0);
  // 报告块：SSRC、丢包率 0、累计丢包 0、最高序号、抖动 0、LSR/DLSR 0
  dv.setUint32(28, ssrc >>> 0);
  return buf;
}

/** interleaved 帧（RTSP over TCP 的 $ 块）：$ + channel + len + payload */
export function interleaveFrame(channel, payloadBytes) {
  const out = new Uint8Array(4 + payloadBytes.length);
  out[0] = 0x24;
  out[1] = channel & 0xff;
  out[2] = (payloadBytes.length >> 8) & 0xff;
  out[3] = payloadBytes.length & 0xff;
  out.set(payloadBytes, 4);
  return out;
}
