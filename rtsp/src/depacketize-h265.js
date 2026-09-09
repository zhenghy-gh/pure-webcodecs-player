/**
 * H.265/HEVC RTP depacketizer（RFC 7798）。
 *
 * 与 H.264 的关键差异：
 *   - NAL header 为 2 字节（forbidden(1) + type(6) + layerId(6) + tid+1(3)）
 *   - 聚合包为 AP（type 48），分片包为 FU（type 49）
 *   - 可选 DONL：当 SDP 声明 sprop-max-don-diff>0 时，AP 首条目/FU 分片
 *     前置 2 字节 DONL（本实现解析后丢弃）
 *
 * 还原规则（FU）：out[0] = (payloadHdr[0] & 0x81) | (fuType << 1)；out[1] = payloadHdr[1]。
 */

import { seqNewer } from './rtp.js';

const H265_AP = 48;
const H265_FU = 49;

function appendAll(arr, bytes) {
  for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]);
}

export class H265Depacketizer {
  /** @param {{donl?:boolean}} [opts] donl=true 表示按 RFC 7798 解析并跳过 DONL 字段 */
  constructor(opts = {}) {
    this.donl = !!opts.donl;
    this.fuPayload = null;
    this.fuHdr0 = 0; // 待还原的 payloadHdr 第 1 字节
    this.fuHdr1 = 0; // 第 2 字节
    this.expectedFuSeq = 0;
    this.auNals = [];
    this.stats = { packets: 0, lost: 0, frames: 0, fuStarted: 0, fuDropped: 0, ap: 0 };
    this.maxSeqSeen = null;
  }

  reset() {
    this.fuPayload = null;
    this.auNals = [];
    this.maxSeqSeen = null;
  }

  push(payload, marker, sequence, timestamp) {
    void timestamp;
    this.stats.packets++;
    if (this.maxSeqSeen !== null && !seqNewer(sequence, this.maxSeqSeen) && sequence !== this.maxSeqSeen) {
      return {};
    }
    if (
      this.maxSeqSeen !== null &&
      ((sequence - this.maxSeqSeen) & 0xffff) > 1 &&
      ((sequence - this.maxSeqSeen) & 0xffff) < 0x8000
    ) {
      this.stats.lost += ((sequence - this.maxSeqSeen) & 0xffff) - 1;
    }
    this.maxSeqSeen = sequence;

    if (payload.length < 2) return {};
    const nalType = ((payload[0] & 0x7e) >> 1);

    if (nalType === H265_AP) {
      this.#abortFu();
      let off = 2; // AP 自身的 PayloadHdr
      // RFC 7798：配置 DONL 时，首个条目前置 2 字节 DONL（仅一次）
      if (this.donl && payload.length >= off + 2) off += 2;
      while (off + 2 <= payload.length) {
        const len = (payload[off] << 8) | payload[off + 1];
        off += 2;
        if (len === 0 || off + len > payload.length) break;
        this.auNals.push(payload.subarray(off, off + len));
        off += len;
      }
      this.stats.ap++;
    } else if (nalType === H265_FU) {
      if (payload.length < 3) {
        this.#abortFu();
        return {};
      }
      const fuHeader = payload[2];
      const sBit = (fuHeader & 0x80) !== 0;
      const eBit = (fuHeader & 0x40) !== 0;
      const fuType = fuHeader & 0x1f;

      if (sBit) {
        this.#abortFu();
        // FU 的首个载荷可能前置 DONL（仅 S=1 且配置了 DONL 时）
        const dataOff = this.donl ? 5 : 3;
        this.fuHdr0 = (payload[0] & 0x81) | (fuType << 1);
        this.fuHdr1 = payload[1];
        this.fuPayload = [this.fuHdr0, this.fuHdr1];
        appendAll(this.fuPayload, payload.subarray(dataOff));
        this.expectedFuSeq = (sequence + 1) & 0xffff;
        this.stats.fuStarted++;
      } else if (this.fuPayload && sequence === this.expectedFuSeq) {
        appendAll(this.fuPayload, payload.subarray(3));
        this.expectedFuSeq = (sequence + 1) & 0xffff;
        if (eBit) {
          this.auNals.push(Uint8Array.from(this.fuPayload));
          this.fuPayload = null;
        }
      } else {
        this.#abortFu();
      }
    } else {
      // 单 NAL 包（含 VPS/SPS/PPS/SEI 等）
      this.#abortFu();
      this.auNals.push(payload);
    }

    if (marker) {
      const nals = this.auNals.slice();
      this.auNals = [];
      this.stats.frames++;
      return { nals, keyframe: nals.some((n) => { const t = (n[0] >> 1) & 0x3f; return t === 19 || t === 20 || t === 21; }) };
    }
    return {};
  }

  #abortFu() {
    if (this.fuPayload) {
      this.stats.fuDropped++;
      this.fuPayload = null;
    }
  }
}
