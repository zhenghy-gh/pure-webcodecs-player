/**
 * ts-stream-engine.js —— MPEG-TS 流式解析引擎（模块内部实现）
 *
 * 本文件是纯粹的解析内核：push/flush 事件式驱动，不对外承诺契约接口。
 * 契约外壳见 ./ts-demuxer.js（extends core Demuxer）。
 *
 * 相对初版的修正（reviewer round-1 + CONTRACTS v0.2）：
 *  - 样本时间戳在引擎输出边界换算为整数微秒（ticks 只存在于内部，§0.5）；
 *  - 音频多帧 PTS 采用「基准 µs + round(采样偏移×1e6/采样率)」闭式计算，
 *    消除把 1024 采样当 90kHz tick 的混域步进漂移；
 *  - PES 重组缓冲加上限（超限丢弃并告警，防内存失控）；
 *  - CC 连续计数检测：断续计数告警（AFDISCONTINUITY 处重置期望值）；
 *  - PAT/PMT 版本对账：PMT 变更时以最新版本重建流表，防止新旧状态分裂。
 */

import { Emitter } from './emitter.js';
import { PsiAssembler, parsePAT, parsePMT } from './psi.js';
import { parsePESHeader, isVideoStreamId } from './pes.js';
import { unwrapTimestamp } from './bits.js';
import {
  splitAnnexB, classify,
  buildAvcc, buildHvcc,
  parseH264SpsDimensions, parseHevcSpsDimensions,
} from './nalu.js';
import {
  splitAdtsFrames, buildAudioSpecificConfig, parseLatmSyncStream,
  splitLatmUnits, parseAudioSpecificConfig, AAC_SAMPLE_RATES,
} from './aac.js';
import { ticksToUs } from '../../core/src/types.js';

const SYNC_BYTE = 0x47;
const NULL_PID = 0x1fff;
/** TS 视频 PES 时间戳恒为 90kHz */
const VIDEO_TIMESCALE = 90000;
/** 单 PID PES 重组缓冲上限默认值（字节）：超过即丢弃并告警；可经构造参数覆盖（测试用） */
const DEFAULT_MAX_PES_BUFFER = 8 * 1024 * 1024;

/** 可识别并支持的 ES 编码（其余类型记录到 ignoredStreams 后跳过） */
const SUPPORTED = new Set(['h264', 'hevc', 'aac']);

export class TsStreamEngine extends Emitter {
  /**
   * @param {{maxPesBufferBytes?: number}} [options]
   */
  constructor(options = {}) {
    super();
    /** PES 重组缓冲上限 */
    this.maxPesBufferBytes = options.maxPesBufferBytes ?? DEFAULT_MAX_PES_BUFFER;
    /** @type {number|null} 188 或 192 */
    this.packetSize = null;
    /** 单元内同步字节偏移：M2TS(192) 为 4（TP_extra_header），普通 TS 为 0 */
    this.syncOffsetInCell = 0;
    this.buffer = new Uint8Array(0);
    this.psi = new PsiAssembler((pid, section) => this._onPsiSection(pid, section));
    /** @type {Set<number>} 当前 PMT 声明的 PMT PID 集合 */
    this.pmtPids = new Set();
    /** @type {Map<number,{codec:string}>} 最新 PMT 权威流表：pid → ES 信息 */
    this.streams = new Map();
    /** @type {Map<number,number>} pmtPid → version（对账用） */
    this.pmtVersions = new Map();
    /** @type {Map<number,Set<number>>} pmtPid → 该 PMT 拥有的 ES PID 集（多节目分账） */
    this.pmtOwned = new Map();
    /** @type {Array<{pid:number, streamType:number}>} 不支持的 ES 记录 */
    this.ignoredStreams = [];
    this.programNumber = null;
    /** @type {Map<number,Uint8Array[]>} pid → PES 聚合块 */
    this.pesChunks = new Map();
    /** @type {Map<number,number>} pid → 已聚合字节数 */
    this.pesLengths = new Map();
    /** @type {Map<string,any>} 内部轨道状态，key 为 `t:${pid}` */
    this.trackState = new Map();
    /** @type {Array<object>} 最近一次构建的轨道列表（内部形状） */
    this.tracks = [];
    /** 连续计数错误总数（诊断/演示用） */
    this.ccErrors = 0;
    /** 同步网格失效后重置包长探测的次数（误锁自愈，诊断用） */
    this.resyncs = 0;
    /** @type {Map<number,number>} pid → 期望的下一个 CC */
    this._ccExpect = new Map();
    this._warned = new Set();
    /** 节目时钟基准（PCR）：自适应域 PCR_flag 提取，90kHz tick；形如存在则作为时长/时钟对齐权威源 */
    this._pcrFirst = null;
    this._pcrLast = null;
    this._pcrSeen = 0;
    this._complete = false;

    // PSI 组装期间需要知道当前 section 属于哪个 PMT 版本——在回调里按 pid 判断即可
    void this.pmtVersions;
  }

  /* ------------------------------ 公共驱动 ------------------------------ */

  /**
   * 喂入任意大小的数据块。内部自动同步、缓存不完整尾部。
   * @param {Uint8Array|ArrayBuffer} chunk
   */
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    if (chunk.length === 0 || this._complete) return;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this._consume();
  }

  /** 流结束：冲刷未完成的 PES 并发出 complete/metadata */
  flush() {
    for (const [pid] of [...this.pesChunks]) this._finishPes(pid);
    this._emitMetadata(true);
    this.emit('complete');
    this._complete = true;
  }

  get complete() {
    return this._complete;
  }

  reset() {
    this.packetSize = null;
    this.buffer = new Uint8Array(0);
    this.psi.reset();
    this.pmtPids.clear();
    this.streams.clear();
    this.pmtVersions.clear();
    this.ignoredStreams.length = 0;
    this.programNumber = null;
    this.pesChunks.clear();
    this.pesLengths.clear();
    this.trackState.clear();
    this.tracks = [];
    this.ccErrors = 0;
    this._ccExpect.clear();
    this._warned.clear();
    this._complete = false;
  }

  /**
   * PSI 快照（demo 展示 program/PMT 树与诊断信息用）。
   */
  psiSnapshot() {
    const programs = [];
    for (const [pmtPid, version] of this.pmtVersions) {
      const streams = [];
      for (const [pid, info] of this.streams) {
        streams.push({
          pid,
          codec: info.codec,
          supported: SUPPORTED.has(info.codec),
        });
      }
      programs.push({ pmtPid, version, streams });
    }
    return {
      programNumber: this.programNumber,
      packetSize: this.packetSize,
      programs,
      ccErrors: this.ccErrors,
      ignoredStreams: [...this.ignoredStreams],
    };
  }

  // ------------------------------ 同步与包处理 ------------------------------

  _consume() {
    // 外层循环：锁定后若连续失步超阈值（误锁/源切换）则重置包长探测自愈
    while (this.buffer.length > 0) {
      // 1) 尚未锁定包长：寻找连续同步（不丢弃任何字节——载荷中也可能是 0x47）
      if (this.packetSize == null && !this._detectPacketSize()) {
        break; // 数据不足，等待更多
      }

      // 2) 主循环：逐包解析
      const size = this.packetSize;
      let pos = 0;
      let slid = 0;                  // 自上次命中以来连续失步滑动字节数
      const resyncLimit = size * 4;  // 连续 ≥4 个单元仍无法对齐 → 同步网格失效
      while (true) {
        if (this.buffer.length - pos < size) break;
        const so = this.syncOffsetInCell;
        if (this.buffer[pos + so] !== SYNC_BYTE) {
          pos++;                     // 失步：滑动重找
          if (++slid >= resyncLimit) break;
          continue;
        }
        // 双重校验：下一单元同位置也应为同步字节（数据足够时）
        if (pos + 2 * size <= this.buffer.length && this.buffer[pos + size + so] !== SYNC_BYTE) {
          pos++;
          if (++slid >= resyncLimit) break;
          continue;
        }
        slid = 0;                    // 命中：恢复正常步进
        try {
          this._parsePacket(this.buffer.subarray(pos, pos + size));
        } catch (err) {
          this.emit('error', err);
        }
        pos += size;
      }

      if (slid >= resyncLimit) {
        // 连续失步超阈值：锁定的包长可能来自「首窗垃圾 192 步长三同步巧合」误锁，
        // 或数据源中途切换格式 → 丢弃失步窗口起点前的已确认垃圾，重置后重新探测
        this.buffer = this.buffer.slice(pos);
        this.packetSize = null;
        this.syncOffsetInCell = 0;
        this.resyncs++;
        this._warn('同步网格失效（连续失步超阈值），重置包长探测');
        continue;
      }

      // 3) 正常消费：保留不足一个单元的尾部
      this.buffer = this.buffer.slice(pos);
      break;
    }

    // 长期无法锁定包长时避免无限堆积
    if (this.packetSize == null && this.buffer.length > 512 * 1024) {
      this.buffer = this.buffer.slice(-1024);
    }
  }

  _detectPacketSize() {
    const buf = this.buffer;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== SYNC_BYTE) continue;
      // 先试 192+4 前缀（M2TS）：同步点须在单元内偏移 4 处
      const stride192 = 192;
      if (
        i >= 4 &&
        i + stride192 < buf.length && buf[i + stride192] === SYNC_BYTE &&
        i + 2 * stride192 < buf.length && buf[i + 2 * stride192] === SYNC_BYTE
      ) {
        this.packetSize = stride192;
        this.syncOffsetInCell = 4;
        this.buffer = buf.slice(i - 4);   // 保留单元前缀，保持单元边界对齐
        return true;
      }
      for (const stride of [188, 192]) {
        if (
          i + stride < buf.length && buf[i + stride] === SYNC_BYTE &&
          i + 2 * stride < buf.length && buf[i + 2 * stride] === SYNC_BYTE
        ) {
          this.packetSize = stride;
          this.syncOffsetInCell = 0;
          this.buffer = buf.slice(i);
          return true;
        }
      }
    }
    return false;
  }

  /** @param {Uint8Array} cell 恰好一个传输单元（含可能的 M2TS 前缀） */
  _parsePacket(cell) {
    const o = this.syncOffsetInCell;
    const pkt = cell.subarray(o);     // 标准 188 字节包视图
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const tei = (pkt[1] & 0x80) !== 0;
    const pusi = (pkt[1] & 0x40) !== 0;
    const scrambling = (pkt[3] >> 6) & 0x03;
    const afControl = (pkt[3] >> 4) & 0x03;
    const cc = pkt[3] & 0x0f;

    // transport_error_indicator 置位：上层已判此包不可纠正错误，整体丢弃
    if (tei) {
      this.ccErrors++;
      this._warn(`PID ${pid} transport_error_indicator 置位，丢包`);
      return;
    }
    if (pid === NULL_PID || scrambling !== 0) return;

    // ---- AF 解析需先于 CC 校验：discontinuity_indicator 置位时 CC 豁免 ----
    // （此前 CC 校验先跑，拼接点 CC 跳变会被误计一次 ccError）
    let offset = 4;
    let afDiscontinuity = false;
    if (afControl & 0x02) {
      const afLen = pkt[4];
      if (afLen >= 1) afDiscontinuity = (pkt[5] & 0x80) !== 0;
      offset += 1 + afLen;         // 跳过自适应域（含填充）
    }

    // ---- CC 连续性检测 ----
    // 规则：带 AF 或带载荷的包都占用一个 CC；discontinuity_indicator 置位时豁免。
    if (afControl !== 0x00 && !afDiscontinuity) {
      const expect = this._ccExpect.get(pid);
      if (expect != null && cc !== expect) {
        this.ccErrors++;
        this._warn(`PID ${pid} 连续计数不连续（期望 ${expect} 实得 ${cc}），可能丢包`);
      }
      this._ccExpect.set(pid, (cc + 1) & 0x0f);
    }
    if (afDiscontinuity) this._ccExpect.delete(pid);
    // PCR 提取：自适应域 PCR_flag 置位时，pkt[6..11] 为 PCR（base 33 位 + ext 9 位，均 90kHz）。
    // 这是节目时钟基准，作为时长/时钟对齐的权威来源——此前完全未提取（时长估算退化）。
    if ((pkt[5] & 0x10) && pkt[4] >= 7) {
      this._recordPcr(pid, pkt[5], pkt[6], pkt[7], pkt[8], pkt[9], pkt[10], pkt[11], afDiscontinuity);
    }
    if (!(afControl & 0x01)) return; // 本包无有效载荷
    if (offset > pkt.length) {
      this.emit('error', new Error(`AF 长度越界 pid=${pid}`));
      return;
    }
    const payload = pkt.subarray(offset);

    if (pid === 0x0000 || this.pmtPids.has(pid)) {
      this.psi.feed(pid, payload, pusi);
      return;
    }
    const stream = this.streams.get(pid);
    if (!stream) return;             // 尚未由最新 PMT 声明的 ES
    this._accumulatePes(pid, payload, pusi, stream.codec);
  }

  /** 解析并登记一个 PCR（自适应域 PCR_flag 位）。PCR 为节目时钟基准，90kHz tick。 */
  _recordPcr(pid, _flags, b0, b1, b2, b3, b4, b5, discontinuity) {
    // PCR_base：33 位（整数 90kHz）；PCR_extension：9 位（27MHz，/300 折算 90kHz）。
    // base 可达 2^33-1，仍在 Number 安全整数范围内，切勿用 >>>0 截断（会回绕）。
    const base = b0 * 2 ** 25 + b1 * 2 ** 17 + b2 * 2 ** 9 + b3 * 2 + (b4 >> 7);
    const ext = ((b4 & 0x01) << 8) | b5;          // 9 位
    const pcr90k = base + Math.floor(ext / 300);  // 亚 tick 舍去，时长精度足够
    this._pcrSeen++;
    if (discontinuity) {
      // PCR 不连续（拼接/广告插入）：重置跨度基准，避免时长被错误累加
      this._pcrFirst = pcr90k;
      this._pcrLast = pcr90k;
    } else {
      // 此前用 min/max 追踪：流跨 33 位回绕（≈26.5h 周期）后新 PCR 拉低
      // _pcrFirst 而 _pcrLast 保留旧大值，时长变成 ≈26.5h 垃圾值，且
      // metadata 处 span<0 的补偿分支永远不可达。改为：无 discontinuity
      // 标志但 PCR 回退 = 回绕，把当前值抬升到单调域后再取 max。
      let cur = pcr90k;
      if (this._pcrLast != null && cur < this._pcrLast) cur += 2 ** 33;
      if (this._pcrFirst == null || this._pcrLast == null) this._pcrFirst = pcr90k;
      if (this._pcrLast == null || cur > this._pcrLast) this._pcrLast = cur;
    }
    this.emit('pcr', { pid, pcr90k, discontinuity: !!discontinuity });
  }

  // ------------------------------ PSI ------------------------------

  _onPsiSection(pid, section) {
    try {
      if (pid === 0x0000 && section[0] === 0x00) {
        const pat = parsePAT(section);
        if (!pat.crcOk) this._warn('PAT CRC 校验失败，仍尝试解析');
        for (const prog of pat.programs) {
          this.programNumber = prog.number;
          if (prog.pid !== 0) this.pmtPids.add(prog.pid);
        }
        return;
      }
      if (this.pmtPids.has(pid) && section[0] === 0x02) {
        const pmt = parsePMT(section);
        if (!pmt.crcOk) this._warn('PMT CRC 校验失败，仍尝试解析');

        // ---- 版本对账（按 PMT 分账）：同 PID 同版本跳过；换版仅重建该 PMT 名下的流，
        //      多节目（多个 PMT）互不影响——修复「只增不减/双状态分裂」。----
        const prevVersion = this.pmtVersions.get(pid);
        const versionChanged = prevVersion != null && prevVersion !== pmt.versionNumber;
        const firstSeen = prevVersion == null;
        if (!firstSeen && !versionChanged) return;

        this.pmtVersions.set(pid, pmt.versionNumber);
        const owned = this.pmtOwned.get(pid) ?? new Set();

        // 该 PMT 新声明的受支持 ES
        const declared = new Map();       // esPid -> normalized codec
        for (const s of pmt.streams) {
          const normalized = s.codec?.startsWith('aac') ? 'aac'
            : (s.codec && SUPPORTED.has(s.codec.split('-')[0]) ? s.codec : null);
          if (normalized) declared.set(s.pid, normalized);
          else {
            this.ignoredStreams.push({ pid: s.pid, streamType: s.streamType });
            this._warn(`忽略暂不支持的 stream_type=0x${(s.streamType ?? 0).toString(16)} pid=${s.pid}`);
          }
        }

        // 1) 移除：旧版拥有而新版不再声明（且不属于其他 PMT）
        for (const oldPid of owned) {
          if (!declared.has(oldPid)) {
            this.streams.delete(oldPid);
            this.trackState.delete(`t:${oldPid}`);
          }
        }
        // 2) 增改
        // firstSeen || versionChanged：换版「仅移除 ES」时流表已清理，但
        // 此前 changed 不置位 → 不重发 tracks 事件，this.tracks 残留旧列表
        let changed = firstSeen || versionChanged;
        for (const [esPid, codec] of declared) {
          const existing = this.streams.get(esPid);
          if (!existing || existing.codec !== codec) changed = true;
          this.streams.set(esPid, { codec });
          this._ensureTrackState(esPid, pmt.streams.find((x) => x.pid === esPid)?.streamType ?? 0, codec);
        }
        this.pmtOwned.set(pid, new Set(declared.keys()));
        if (changed || this.tracks.length === 0) this._emitTracks();
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  _warn(msg) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    this.emit('warn', new Error(msg));
  }

  // ------------------------------ PES 重组 ------------------------------

  _accumulatePes(pid, payload, pusi, codec) {
    if (pusi) {
      this._finishPes(pid);
      this.pesChunks.set(pid, []);
      this.pesLengths.set(pid, 0);
    }
    let chunks = this.pesChunks.get(pid);
    if (!chunks) return false;       // 中途加入，等下一个 PUSI
    chunks.push(payload);
    const got = (this.pesLengths.get(pid) || 0) + payload.length;
    this.pesLengths.set(pid, got);

    // 缓冲上限保护：异常流（无 PUSI 且 declaredLength=0）不会撑爆内存
    if (got > this.maxPesBufferBytes) {
      this._warn(`PID ${pid} PES 重组缓冲超过 ${this.maxPesBufferBytes} 字节，已丢弃重来`);
      this.pesChunks.set(pid, []);
      this.pesLengths.set(pid, 0);
      return true;
    }

    // 利用 PES_packet_length 提前判断完整性（视频常为 0 表示不限长）
    const all = concat(chunks);
    if (all.length >= 6) {
      const declared = (all[4] << 8) | all[5];
      if (declared > 0 && all.length >= declared + 6) {
        this._dispatchPes(pid, all.subarray(0, declared + 6), codec);
        this.pesChunks.set(pid, []);
        this.pesLengths.set(pid, 0);
      }
    }
    return true;
  }

  _finishPes(pid) {
    const chunks = this.pesChunks.get(pid);
    if (!chunks || chunks.length === 0) return;
    const codec = this.streams.get(pid)?.codec;
    this._dispatchPes(pid, concat(chunks), codec);
    this.pesChunks.delete(pid);
    this.pesLengths.delete(pid);
  }

  _dispatchPes(pid, data, codec) {
    const header = parsePESHeader(data);
    if (!header) return;
    const payload = data.subarray(header.payloadOffset);
    if (payload.length === 0) return;
    if (!codec) {
      // 兜底：无 PMT 信息时按 stream_id 分类
      if (isVideoStreamId(header.streamId)) codec = 'h264';
      else return;
    }
    const state = this.trackState.get(`t:${pid}`);
    if (!state) return;

    const dtsRaw = header.dts ?? header.pts ?? null;
    const ptsRaw = header.pts ?? header.dts ?? dtsRaw;
    const dtsTicks = dtsRaw != null ? unwrapTimestamp(dtsRaw, state.lastDtsRaw) : null;
    const ptsTicks = ptsRaw != null ? unwrapTimestamp(ptsRaw, state.lastPtsRaw) : dtsTicks;
    state.lastPtsRaw = ptsTicks;
    state.lastDtsRaw = dtsTicks ?? ptsTicks;

    if (state.firstDts == null && dtsTicks != null) state.firstDts = dtsTicks;

    // ---- 契约边界：ticks → 整数微秒（§0.5 就近取整） ----
    const ptsUs = ptsTicks != null ? ticksToUs(ptsTicks, VIDEO_TIMESCALE) : 0;
    const dtsUs = dtsTicks != null ? ticksToUs(dtsTicks, VIDEO_TIMESCALE) : ptsUs;

    if (codec === 'aac') this._handleAacPes(state, payload, ptsUs, dtsUs);
    else this._handleVideoPes(state, payload, ptsUs, dtsUs);
  }

  // ------------------------------ 视频（H.264/H.265 AnnexB） ------------------------------

  _handleVideoPes(state, es, ptsUs, dtsUs) {
    const isHevc = state.codec === 'hevc';
    const units = splitAnnexB(es);
    if (units.length === 0) return;
    const classified = classify(units, isHevc ? 'hevc' : 'h264');

    // 参数集更新检测
    let configDirty = false;
    for (const u of classified) {
      if (!isHevc) {
        if (u.type === 7 && !sameBytes(u.data, state.lastSps)) {
          state.lastSps = u.data; configDirty = true;
        } else if (u.type === 8 && !sameBytes(u.data, state.lastPps)) {
          state.lastPps = u.data; configDirty = true;
        }
      } else {
        if (u.type === 32 && !sameBytes(u.data, state.lastVps)) {
          state.lastVps = u.data; configDirty = true;
        } else if (u.type === 33 && !sameBytes(u.data, state.lastSps)) {
          state.lastSps = u.data; configDirty = true;
        } else if (u.type === 34 && !sameBytes(u.data, state.lastPps)) {
          state.lastPps = u.data; configDirty = true;
        }
      }
    }
    if (configDirty) this._rebuildVideoConfig(state, isHevc);

    const types = classified.map((u) => u.type);
    const keyframe = isHevc ? types.some((t) => t >= 16 && t <= 23) : types.includes(5);
    if (keyframe) state.keyframes++;

    // 规范化：确保样本以起始码开始（个别复用器在 PUSI 边界省略首码）
    let data = es;
    if (!(es[0] === 0 && es[1] === 0 && (es[2] === 1 || (es[2] === 0 && es[3] === 1)))) {
      data = concat([new Uint8Array([0, 0, 0, 1]), es]);
    }

    state.samples++;
    this.emit('sample', {
      trackId: state.track.id,
      type: 'video',
      codec: state.codec,
      pts: ptsUs,                // 引擎输出边界已是微秒
      dts: dtsUs,
      duration: null,            // 视频由消费端按相邻 DTS 差计算
      keyframe,
      data,
      format: 'annexb',
    });
  }

  _rebuildVideoConfig(state, isHevc) {
    try {
      if (!isHevc) {
        if (!state.lastSps) return;
        state.config = buildAvcc([state.lastSps], state.lastPps ? [state.lastPps] : []);
        const dims = parseH264SpsDimensions(state.lastSps);
        if (dims) { state.width = dims.width; state.height = dims.height; }
      } else {
        if (!state.lastSps || !state.lastPps) return; // hvcC 需要 VPS/SPS/PPS
        state.config = buildHvcc(
          state.lastVps ? [state.lastVps] : [],
          [state.lastSps],
          [state.lastPps],
        );
        const dims = parseHevcSpsDimensions(state.lastSps);
        if (dims) { state.width = dims.width; state.height = dims.height; }
      }
    } catch (err) {
      this.emit('error', err);
    }
    this._emitTracks();
  }

  // ------------------------------ 音频（AAC ADTS/LATM） ------------------------------

  _handleAacPes(state, payload, ptsUs, dtsUs) {
    if (state.latm) {
      this._handleLatm(state, payload, ptsUs, dtsUs);
      return;
    }
    const frames = splitAdtsFrames(payload);
    if (frames.length === 0) return;

    // 首帧：从 ADTS 头建立 ASC 与音轨参数
    if (!state.config) {
      const h = frames[0].header;
      state.sampleRate = h.samplingRate;
      state.channels = h.channels;
      state.config = buildAudioSpecificConfig(h.aot, h.sampleRateIndex, h.channels);
      this._emitTracks();
    }

    // 闭式计算消除累计漂移：us_i = baseUs + round(i × 1024 × 1e6 / 采样率)
    const base = dtsUs ?? ptsUs ?? 0;
    const sr = state.sampleRate ?? 44100;
    for (let i = 0; i < frames.length; i++) {
      const framePts = base + Math.round((i * 1024 * 1_000_000) / sr);
      state.samples++;
      this.emit('sample', {
        trackId: state.track.id,
        type: 'audio',
        codec: 'aac',
        pts: framePts,
        dts: framePts,
        duration: Math.round((1024 * 1_000_000) / sr),
        keyframe: true,          // 音频每帧独立可解码
        data: frames[i].raw,
        format: 'aac-raw',
      });
    }
  }

  _handleLatm(state, payload, ptsUs, dtsUs) {
    const units = splitLatmUnits(payload);
    if (units.length === 0) return;
    const base = dtsUs ?? ptsUs ?? 0;
    const sr = state.sampleRate ?? 44100;
    for (let i = 0; i < units.length; i++) {
      const { asc, payload: raw } = units[i];
      if (asc && !state.config) {
        try {
          const info = parseAudioSpecificConfig(asc);
          state.sampleRate = info.sampleRate;
          state.channels = info.channels;
          state.config = asc;
          this._emitTracks();
        } catch { /* 忽略非法 ASC */ }
      }
      if (!raw) continue;
      state.samples++;
      this.emit('sample', {
        trackId: state.track.id,
        type: 'audio',
        codec: 'aac',
        pts: base + Math.round((i * 1024 * 1_000_000) / sr),
        dts: base + Math.round((i * 1024 * 1_000_000) / sr),
        duration: Math.round((1024 * 1_000_000) / sr),
        keyframe: true,
        data: raw,
        format: 'aac-raw',
      });
    }
  }

  // ------------------------------ 轨道与元数据 ------------------------------

  _ensureTrackState(pid, streamType, codec) {
    const key = `t:${pid}`;
    if (this.trackState.has(key)) {
      const st = this.trackState.get(key);
      if (codec === 'aac' && streamType === 0x11 && !st.latm) st.latm = true;
      return st;
    }
    const state = {
      track: { id: pid },
      codec,
      latm: codec === 'aac' && streamType === 0x11,
      samples: 0,
      keyframes: 0,
      config: null,
      width: null,
      height: null,
      sampleRate: null,
      channels: null,
      firstDts: null,
      lastDtsRaw: null,
      lastPtsRaw: null,
      lastSps: null,
      lastPps: null,
      lastVps: null,
    };
    this.trackState.set(key, state);
    return state;
  }

  /** 构建内部轨道列表（shell 会再映射为契约 Track） */
  _buildPublicTracks() {
    const tracks = [];
    for (const state of this.trackState.values()) {
      const t = {
        ...state.track,
        type: state.codec === 'aac' ? 'audio' : 'video',
        codec: state.codec,
        timescale: state.codec === 'aac'
          ? (state.sampleRate ?? AAC_SAMPLE_RATES[4])
          : VIDEO_TIMESCALE,
        config: state.config ?? undefined,
        sampleFormat: state.codec === 'aac' ? 'aac-raw' : 'annexb',
      };
      if (state.codec !== 'aac') {
        t.width = state.width ?? undefined;
        t.height = state.height ?? undefined;
      } else {
        t.sampleRate = state.sampleRate ?? undefined;
        t.channelCount = state.channels ?? undefined;
      }
      tracks.push(t);
    }
    return tracks;
  }

  _emitTracks() {
    this.tracks = this._buildPublicTracks();
    this.emit('tracks', this.tracks);
  }

  /** 结束时估算总时长（毫秒），并发 metadata */
  _emitMetadata(final = false) {
    let first = Infinity;
    let last = -Infinity;
    for (const state of this.trackState.values()) {
      if (state.firstDts != null) first = Math.min(first, state.firstDts);
      if (state.lastDtsRaw != null) last = Math.max(last, state.lastDtsRaw);
    }
    const dtsMs = Number.isFinite(first) && Number.isFinite(last) && last > first
      ? Math.round(((last - first) / VIDEO_TIMESCALE) * 1000)
      : null;
    // PCR 跨度兜底：DTS 不可用时（仅 PCR 流、或流无 DTS）提供节目时钟级时长，
    // 直接修复「PCR 未提取导致时长估算退化」。DTS 跨度优先（媒体时间线更准）。
    let pcrMs = null;
    if (this._pcrFirst != null && this._pcrLast != null) {
      let span = this._pcrLast - this._pcrFirst;
      if (span < 0) span += 2 ** 33;   // 33 位回绕
      pcrMs = Math.round((span / 90000) * 1000);
    }
    const durationMs = dtsMs != null ? dtsMs : pcrMs;
    this.emit('metadata', {
      container: 'mpeg-ts',
      programNumber: this.programNumber,
      durationMs,
      pcrDurationMs: pcrMs,
      pcrSeen: this._pcrSeen,
      final,
      ignoredStreams: [...this.ignoredStreams],
    });
  }
}

function concat(list) {
  if (list.length === 1) return list[0];
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
