/**
 * H.264 RTP depacketizer（RFC 6184）。
 *
 * 支持的封装：
 *   - 单 NAL 单元包（type 1~23）
 *   - STAP-A（type 24）：聚合多 NAL，条目 = 2 字节长度 + NAL
 *   - STAP-B（type 25）：STAP-A 前置 2 字节 DON（本实现解析后丢弃 DON）
 *   - FU-A（type 28）：分片，S/E 位标记首尾
 *
 * 容错策略：
 *   - 乱序/丢包：FU 序列中断即丢弃半成品，等待下一个 S=1 的分片重新开始；
 *   - 序列号回绕安全；跨 AU 以 Marker 位为帧边界。
 */

import { seqNewer } from './rtp.js';

const NAL_FU_A = 28;
const NAL_STAP_A = 24;
const NAL_STAP_B = 25;

function appendAll(arr, bytes) {
  for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]);
}

export class H264Depacketizer {
  constructor() {
    /** @type {Uint8Array|null} 正在重组的 FU 载荷 */
    this.fuPayload = null;
    this.fuType = 0;
    this.fuNri = 0;
    this.fuLastSeq = 0;
    this.expectedFuSeq = 0;
    /** 当前 AU 已收集的 NAL */
    this.auNals = [];
    this.auTimestamp = 0;
    // 统计
    this.stats = { packets: 0, lost: 0, frames: 0, fuStarted: 0, fuDropped: 0, stap: 0 };
    this.maxSeqSeen = null;
  }

  reset() {
    this.fuPayload = null;
    this.auNals = [];
    this.stats = { packets: 0, lost: 0, frames: 0, fuStarted: 0, fuDropped: 0, stap: 0 };
    this.maxSeqSeen = null;
  }

  /**
   * 推入一个 RTP 包的 payload。
   * @param {Uint8Array} payload RTP 载荷
   * @param {boolean} marker 该包是否置 Marker（AU 边界）
   * @param {number} sequence 序列号
   * @param {number} timestamp RTP 时间戳
   * @returns {{nals?: Uint8Array[], keyframe?: boolean}} 当 AU 结束时返回完整 NAL 列表
   */
  push(payload, marker, sequence, timestamp) {
    this.stats.packets++;
    if (this.maxSeqSeen !== null && !seqNewer(sequence, this.maxSeqSeen) && sequence !== this.maxSeqSeen) {
      // 迟到/重复包：忽略
      return {};
    }
    if (this.maxSeqSeen !== null && ((sequence - this.maxSeqSeen) & 0xffff) > 1 && ((sequence - this.maxSeqSeen) & 0xffff) < 0x8000) {
      this.stats.lost += ((sequence - this.maxSeqSeen) & 0xffff) - 1;
    }
    this.maxSeqSeen = sequence;

    if (payload.length === 0) return {};

    const firstByte = payload[0];
    const type = firstByte & 0x1f;

    if (type >= 1 && type <= 23) {
      this.#abortFu(); // 新 NAL 开始，未完成的 FU 作废
      this.auNals.push(payload);
    } else if (type === NAL_STAP_A || type === NAL_STAP_B) {
      this.#abortFu();
      const skip = type === NAL_STAP_B ? 3 : 1; // STAP-B 有 2 字节 DON
      let off = skip;
      while (off + 2 <= payload.length) {
        const len = (payload[off] << 8) | payload[off + 1];
        if (len === 0 || off + 2 + len > payload.length) break; // 损坏条目容错
        this.auNals.push(payload.subarray(off + 2, off + 2 + len));
        off += 2 + len;
      }
      this.stats.stap++;
    } else if (type === NAL_FU_A) {
      // RFC 6184：首字节为 FU indicator（F|NRI|28），第二字节才是 FU header（S|E|R|Type）
      if (payload.length < 2) return {};
      const fuHeaderByte = payload[1];
      const sBit = (fuHeaderByte & 0x80) !== 0;
      const eBit = (fuHeaderByte & 0x40) !== 0;
      const fuType = fuHeaderByte & 0x1f;

      if (sBit) {
        this.#abortFu();
        // 还原原始 NAL header：NRI 来自 indicator 高位，类型来自 FU header
        this.fuType = fuType;
        const head = ((payload[0] & 0x60) | fuType);
        this.fuPayload = [head];
        appendAll(this.fuPayload, payload.subarray(2));
        this.expectedFuSeq = (sequence + 1) & 0xffff;
        this.stats.fuStarted++;
      } else if (this.fuPayload && sequence === this.expectedFuSeq) {
        appendAll(this.fuPayload, payload.subarray(2));
        this.expectedFuSeq = (sequence + 1) & 0xffff;
        if (eBit) {
          this.auNals.push(Uint8Array.from(this.fuPayload));
          this.fuPayload = null;
        }
      } else {
        // 断流或乱序：丢弃当前 FU
        if (this.fuPayload) this.stats.fuDropped++;
        this.fuPayload = null;
      }
    } else {
      // type 0 / 29-31 未定义：忽略
      this.#abortFu();
    }

    if (marker) {
      const nals = this.auNals.slice();
      const ts = this.auTimestamp;
      this.auNals = [];
      this.stats.frames++;
      void ts;
      return { nals, keyframe: nals.some((n) => (n[0] & 0x1f) === 5) };
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
