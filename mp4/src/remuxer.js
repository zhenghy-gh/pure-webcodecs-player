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
      if (!s.data) throw stateError(`sample #${s.index ?? '?'} has no data (lazy?)`);
    }
    const timescale = track.timescale ?? 1000;

    const seq = this._sequenceNumber++;
    const baseMediaDecodeTimeTicks = usToTicks(samples[0].dts ?? samples[0].timestamp, timescale);

    // µs → 轨原生 ticks（box 内部表示）；cts = PTS - DTS 回转
    const tickSamples = samples.map((s, i) => {
      const dtsTicks = usToTicks(s.dts ?? s.timestamp, timescale);
      return {
        index: i,
        duration: Math.max(0, usToTicks(s.duration ?? 0, timescale)),
        size: s.size ?? s.data.byteLength,
        keyframe: !!s.keyframe,
        cts: usToTicks(s.timestamp, timescale) - dtsTicks,
        dts: undefined, // buildMoofMdat 只用 duration/size/keyframe/cts/data
        data: s.data,
      };
    });

    const { data } = buildMoofMdat({
      sequenceNumber: seq,
      trackId: track.id,
      baseMediaDecodeTime: baseMediaDecodeTimeTicks,
      samples: tickSamples,
    });
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
 * @param {Sample[]} samples 解码序、dts 升序的契约样本（duration 为 µs）
 * @param {{targetDurationUs?: number}} [opts] 默认 2 秒
 * @returns {Sample[][]}
 */
export function batchSamplesByGop(samples, { targetDurationUs = 2_000_000 } = {}) {
  const batches = [];
  let current = [];
  let acc = 0;
  for (const s of samples) {
    current.push(s);
    acc += s.duration ?? 0;
    const isBoundary =
      current.length > 1 && s.keyframe && acc >= targetDurationUs;
    if (isBoundary || acc >= targetDurationUs * 3) {
      batches.push(current);
      current = [];
      acc = 0;
    }
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
