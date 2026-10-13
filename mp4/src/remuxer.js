/**
 * Fmp4Remuxer：把契约 Sample（整数微秒）重新封装为 fragmented MP4，
 * 直接喂给 MSE（MediaSource.addSourceBuffer('video/mp4; codecs=...')）。
 *
 * 输出结构：
 * - initSegment(track) = ftyp(msfh/isom) + moov(mvhd + trak(空 stbl) + mvex(trex))
 * - mediaSegment(track, samples) = moof(mfhd+traf(tfhd+tfdt+trun v1)) + mdat
 *   tfdt 基准取段首样本 dts（µs → 轨 ticks 回转，usToTicks 就近取整）。
 *
 * 说明：
 * - 入口一律契约 Sample：{timestamp,duration,dts...} 均为微秒；
 * - trun 固定 version1（带符号 cts，B 帧/负偏移安全），per-sample 全量写出；
 * - 样本数据必须已加载（data 字段非空），lazy 样本请先 readSampleData()。
 */
import {
  usToTicks,
} from '../../core/src/index.js';
import { stateError } from '../../core/src/errors.js';
import {
  buildFtyp,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildSmhd,
  buildDinf,
  buildStsd,
  buildMvex,
  buildMfhd,
  buildMoofMdat,
  box as wrapBox,
} from './box-builder.js';

export class Fmp4Remuxer {
  /**
   * @param {{majorBrand?: string, compatible?: string[]}} [options]
   */
  constructor(options = {}) {
    this.majorBrand = options.majorBrand ?? 'msfh';
    this.compatible = options.compatible ?? ['msfh', 'isom', 'iso2', 'avc1', 'mp41'];
    this._sequenceNumber = 0;
  }

  get sequenceNumber() {
    return this._sequenceNumber;
  }

  /**
   * 生成单轨 init segment（ftyp+moov）。
   * @param {Track} track 契约 Track（durationUs；timescale 为诊断保留的原生时间基）
   * @returns {Uint8Array}
   */
  createInitSegment(track) {
    if (!track.description && !track.codecPrivate) {
      throw stateError(`track ${track.id}: missing description for init segment`);
    }
    const isVideo = track.type === 'video';
    const isAudio = track.type === 'audio';
    const timescale = track.timescale ?? (isAudio ? track.sampleRate ?? 48000 : 1000);

    // stsd 构造器吃 codecPrivate 形状——此处做 description→过渡别名桥接
    const stsdTrack = { ...track, codecPrivate: track.description ?? track.codecPrivate };

    const ftyp = buildFtyp({ majorBrand: this.majorBrand, compatible: this.compatible });
    const moov = wrapBox('moov', (w) => {
      w.writeRaw(
        buildMvhd({
          timescale: 1000,
          duration: 0,
          nextTrackId: track.id + 1,
        }),
      );
      w.writeRaw(
        wrapBox('trak', (tw) => {
          tw.writeRaw(
            buildTkhd({
              trackId: track.id,
              duration: 0,
              isVideo,
              isAudio,
              width: track.width,
              height: track.height,
            }),
          );
          tw.writeRaw(
            wrapBox('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale, duration: 0, language: track.language }));
              mw.writeRaw(
                buildHdlr({
                  handlerType: isVideo ? 'vide' : isAudio ? 'soun' : 'meta',
                  name: `remux:${track.sampleEntryType ?? ''}`,
                }),
              );
              mw.writeRaw(
                wrapBox('minf', (iw) => {
                  iw.writeRaw(isVideo ? buildVmhd() : isAudio ? buildSmhd() : nmhdBox());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(wrapBox('stbl', (sw) => sw.writeRaw(buildStsd(stsdTrack))));
                }),
              );
            }),
          );
        }),
      );
      w.writeRaw(buildMvex([track.id], { [track.id]: { defaultSampleDuration: 1024 } }));
    });

    const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
    out.set(ftyp, 0);
    out.set(moov, ftyp.byteLength);
    return out;
  }

  /**
   * 生成一个 media segment（moof+mdat），内部推进序号。
   * @param {Track} track 契约 Track
   * @param {Sample[]} samples 本段样本（µs 时间基；同一轨、解码序、须含 data）
   * @returns {{data:Uint8Array, sequenceNumber:number, baseMediaDecodeTimeUs:number, sampleCount:number, durationUs:number}}
   */
  createMediaSegment(track, samples) {
    if (!samples.length) throw stateError('createMediaSegment: empty samples');
    for (const s of samples) {
      if (!s.data || (!(s.data instanceof ArrayBuffer) && !ArrayBuffer.isView(s.data))) {
        throw stateError(`sample #${s.index ?? '?'} has no byte payload (lazy?)`);
      }
      const size = s.size ?? s.data.byteLength;
      if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff || size !== s.data.byteLength) {
        throw stateError(`sample #${s.index ?? '?'} size does not match payload byte length`);
      }
    }
    const timescale = track.timescale ?? 1000;
    if (!Number.isInteger(timescale) || timescale < 1 || timescale > 0xffffffff) {
      throw stateError('track timescale must be a positive 32-bit integer');
    }

    // Validate continuity in contract microseconds first, then quantize adjacent DTS
    // points and derive run durations from their difference. Independently rounding each
    // duration can lose a tick at non-integral microsecond/timebase boundaries.
    const timingSamples = [];
    let baseMediaDecodeTimeTicks = null;
    let expectedDtsTicks = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const dtsUs = s.dts ?? s.timestamp;
      const ptsUs = s.timestamp;
      const durationUs = s.duration ?? 0;
      if (!Number.isSafeInteger(dtsUs) || !Number.isSafeInteger(ptsUs) ||
          !Number.isSafeInteger(durationUs) || durationUs < 0) {
        throw stateError(`sample #${s.index ?? i} has invalid integer timestamp or duration`);
      }
      const dtsTicks = usToTicks(dtsUs, timescale);
      const ptsTicks = usToTicks(ptsUs, timescale);
      if (!Number.isSafeInteger(dtsTicks) || dtsTicks < 0 || !Number.isSafeInteger(ptsTicks)) {
        throw stateError(`sample #${s.index ?? i} timestamp is outside the supported range`);
      }
      if (expectedDtsTicks !== null && dtsTicks !== expectedDtsTicks) {
        throw stateError(`sample #${s.index ?? i} has discontinuous decode times`);
      }
      const cts = ptsTicks - dtsTicks;
      if (!Number.isSafeInteger(cts) || cts < -0x80000000 || cts > 0x7fffffff) {
        throw stateError(`sample #${s.index ?? i} composition offset is outside the signed 32-bit range`);
      }
      const endDtsUs = dtsUs + durationUs;
      if (!Number.isSafeInteger(endDtsUs)) {
        throw stateError(`sample #${s.index ?? i} decode time exceeds the supported range`);
      }
      const endDtsTicks = usToTicks(endDtsUs, timescale);
      if (!Number.isSafeInteger(endDtsTicks) || endDtsTicks < dtsTicks) {
        throw stateError(`sample #${s.index ?? i} end decode time is outside the supported range`);
      }
      expectedDtsTicks = endDtsTicks;
      if (baseMediaDecodeTimeTicks === null) baseMediaDecodeTimeTicks = dtsTicks;
      timingSamples.push({ s, dtsTicks, endDtsTicks, cts });
    }

    const tickSamples = timingSamples.map((timing, i) => {
      const durationTicks = timing.endDtsTicks - timing.dtsTicks;
      if (!Number.isSafeInteger(durationTicks) || durationTicks < 0 || durationTicks > 0xffffffff) {
        throw stateError(`sample #${timing.s.index ?? i} duration is outside the supported range`);
      }
      const s = timing.s;
      return {
        index: i,
        duration: durationTicks,
        size: s.size ?? s.data.byteLength,
        keyframe: !!s.keyframe,
        cts: timing.cts,
        dts: undefined, // buildMoofMdat 只用 duration/size/keyframe/cts/data
        data: s.data instanceof Uint8Array
          ? s.data
          : s.data instanceof ArrayBuffer
            ? new Uint8Array(s.data)
            : new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength),
      };
    });

    const seq = this._sequenceNumber;
    const { data } = buildMoofMdat({
      sequenceNumber: seq,
      trackId: track.id,
      baseMediaDecodeTime: baseMediaDecodeTimeTicks,
      samples: tickSamples,
    });
    this._sequenceNumber = seq + 1;
    let durationUs = 0;
    for (const s of samples) durationUs += s.duration ?? 0;
    return {
      data,
      sequenceNumber: seq,
      baseMediaDecodeTimeUs: samples[0].dts ?? samples[0].timestamp,
      sampleCount: samples.length,
      durationUs,
    };
  }

  /** 重置序号（新流/seek 后重建会话用） */
  resetSequence(next = 0) {
    this._sequenceNumber = next;
  }
}

/** 非 video/audio 的空 fullbox 占位（nmhd） */
function nmhdBox() {
  return new Uint8Array([0, 0, 0, 12, 0x6e, 0x6d, 0x68, 0x64, 0, 0, 0, 0]);
}

/**
 * 把样本按 GOP 边界 + 目标时长切成批（remux 调度策略）。
 * 有关键帧标记时，初始随机访问点前的 delta 样本会被跳过，后续批次仅从关键帧开始。
 * GOP 超长时延长该批，直到下一个关键帧，不在 GOP 中间切段；无关键帧时返回单一原样批次。
 * @param {Sample[]} samples 解码序、dts 升序的契约样本（duration 为 µs）
 * @param {{targetDurationUs?: number}} [opts] 默认 2 秒
 * @returns {Sample[][]}
 */
export function batchSamplesByGop(samples, { targetDurationUs = 2_000_000 } = {}) {
  if (samples.length > 0 && !samples.some((sample) => sample.keyframe)) return [samples];
  const batches = [];
  let current = [];
  let acc = 0;
  for (const s of samples) {
    if (current.length === 0 && !s.keyframe) continue;
    const isBoundary = current.length > 0 && s.keyframe && acc >= targetDurationUs;
    if (isBoundary) {
      batches.push(current);
      current = [];
      acc = 0;
    }
    current.push(s);
    acc += s.duration ?? 0;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 高层便捷函数：把一个已 open 的 demuxer 的全部输出 remux 成 MSE 序列。
 * demo 与测试用；直播/渐进场景请直接用 Fmp4Remuxer 类 API 手动喂样本。
 *
 * @param {import('../../core/src/demuxer.js').Demuxer} demuxer 已 open()
 * @param {{videoTrackId?: number, audioTrackId?: number, targetDurationUs?: number}} [opts]
 */
export async function remuxDemuxer(demuxer, opts = {}) {
  const mediaInfo = demuxer.mediaInfo ?? demuxer.getMediaInfo();
  const remuxer = new Fmp4Remuxer();
  const outputs = [];
  const wanted = mediaInfo.tracks.filter((t) => {
    if (t.type === 'text' || t.type === 'metadata') return false;
    if (opts.videoTrackId !== undefined || opts.audioTrackId !== undefined) {
      return t.id === opts.videoTrackId || t.id === opts.audioTrackId;
    }
    return true;
  });
  for (const track of wanted) {
    const init = remuxer.createInitSegment(track);
    const all = [];
    for await (const s of demuxer.samples(track.id)) {
      if (!s.data) await demuxer.readSampleData(s);
      all.push(s);
    }
    const segments = batchSamplesByGop(all, {
      targetDurationUs: opts.targetDurationUs ?? 2_000_000,
    }).map((batch) => remuxer.createMediaSegment(track, batch));
    outputs.push({ track, init, segments });
  }
  return outputs;
}
