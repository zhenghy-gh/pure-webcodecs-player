/**
 * fmp4-remuxer.js —— FLV Sample 流 → fMP4（MSE 可直接消费）
 *
 * 定位：薄播放壳的 MSE 路径（【裁决-hls-flv重定位】保留能力）。
 * 输入为契约 Sample（整数微秒，§1.1）；内部按轨换算：
 *   视频 timescale=1000（毫秒域）、音频 timescale=采样率。
 *
 * 输出：
 *   onInitSegment({tracks,data})      —— ftyp+moov（一次）
 *   onMediaSegment({trackId,seqNo,baseDts,data}) —— moof+mdat
 *
 * 分片策略：视频在关键帧到达且距上一分片 ≥ fragmentMs 时切分；
 * 音频独立按时间窗切分；flush() 冲出残余（末段可能非关键帧起始，与 flv.js 一致）。
 */

import { Emitter } from './emitter.js';
import {
  concatBytes, ftypBox, mvhdBox,
  trakBox, tkhdBox, mdiaBox, mdhdBox, hdlrBox,
  minfBox, vmhdBox, smhdBox, dinfBox, stblBox, emptyStblBoxes,
  videoSampleEntry, audioSampleEntry,
  mvexBox, moofBox, mdatBox, box,
} from './iso-bmff.js';
import { parseAvcConfig, parseHevcConfig } from './codec-info.js';

export const VIDEO_TRACK_ID = 1;
export const AUDIO_TRACK_ID = 2;

export class FlvRemuxer extends Emitter {
  /** @param {{fragmentUs?: number, fragmentMs?: number}} [opts] */
  constructor(opts = {}) {
    super();
    this.fragmentUs = opts.fragmentUs ?? (opts.fragmentMs ?? 1000) * 1000;
    this.seqNo = 1;
    this.initEmitted = false;
    this._done = false;
    this._tracks = [];
    /** @type {Map<number,{samples:Array,firstDts:number|null,lastDts:number|null}>} 内部缓冲（轨内 timescale） */
    this.buffers = new Map();
  }

  /**
   * 消费一个已 open 的契约 demuxer：逐轨拉取样本并 remux。
   * 返回 Promise，全部轨 EOS 时 resolve。
   * @param {import('./flv-demuxer.js').FlvDemuxer} demuxer
   */
  async drain(demuxer) {
    this.setTracks(demuxer.mediaInfo?.tracks ?? []);
    for (const track of demuxer.tracks) {
      for await (const sample of demuxer.samples(track.id)) {
        if (this._done) return;
        this.pushSample(sample);
      }
    }
    await this.flush();
  }

  /** 注入契约轨道列表；轨道齐备后立即产出 init segment */
  setTracks(tracks) {
    this._tracks = tracks;
    for (const t of tracks) {
      if (!this.buffers.has(t.id)) {
        this.buffers.set(t.id, { samples: [], firstDts: null, lastDts: null });
      }
    }
    if (!this.initEmitted && tracks.length > 0) this._emitInit();
  }

  /**
   * 推入一个契约样本（µs），内部换算到轨内 timescale。
   */
  pushSample(s) {
    const buf = this.buffers.get(s.trackId);
    if (!buf || !this._tracks.length) return;
    const track = this._tracks.find((t) => t.id === s.trackId);
    const isVideo = s.trackId === VIDEO_TRACK_ID;

    let entry;
    if (isVideo) {
      const dtsMs = Math.round((s.dts ?? s.timestamp) / 1000);
      const ptsMs = Math.round(s.timestamp / 1000);
      entry = {
        dtsTicks: dtsMs,
        ctsTicks: Math.max(0, ptsMs - dtsMs),
        keyframe: !!s.keyframe,
        size: s.data.byteLength,
        durationTicks: null,          // 由下一帧 DTS 差回填
        data: s.data,
      };
      // 回填上一帧时长（µs 差 → 毫秒 tick）
      if (buf.samples.length > 0) {
        const prev = buf.samples[buf.samples.length - 1];
        if (prev.durationTicks == null) {
          prev.durationTicks = Math.max(1, dtsMs - prev.dtsTicks);
        }
      }
    } else {
      const sr = track?.timescale ?? 44100;
      const dtsTicks = Math.round(((s.dts ?? s.timestamp) * sr) / 1_000_000);
      const durationTicks = s.duration
        ? Math.round((s.duration * sr) / 1_000_000)
        : Math.round((1024 * sr) / 1_000_000);     // AAC 兜底
      entry = {
        dtsTicks,
        ctsTicks: 0,
        keyframe: true,
        size: s.data.byteLength,
        durationTicks,
        data: s.data,
      };
    }

    buf.samples.push(entry);
    if (buf.firstDts == null) buf.firstDts = entry.dtsTicks;
    buf.lastDts = entry.dtsTicks;

    // 切片判定：跨度（µs）达到阈值；视频必须等关键帧
    const timescale = isVideo ? 1000 : (track?.timescale ?? 44100);
    const spanUs = ((buf.lastDts - buf.firstDts) * 1_000_000) / timescale;
    if (spanUs >= this.fragmentUs && (!isVideo || entry.keyframe)) {
      this.cut(s.trackId);
    }
  }

  /** 冲出指定轨道当前缓冲为 moof+mdat */
  cut(trackId) {
    const buf = this.buffers.get(trackId);
    if (!buf || buf.samples.length === 0) return;

    // 非 flush（中间）切片：末帧 duration 尚未被下一帧 DTS 回填，
    // 用上一已回填帧的时长估算，避免末帧 duration=0（审计 C-4）。
    const samples = buf.samples;
    const n = samples.length;
    if (n > 0 && samples[n - 1].durationTicks == null) {
      samples[n - 1].durationTicks = n >= 2
        ? (samples[n - 2].durationTicks ?? 33)
        : 33;
    }

    // 组装 mdat 负载
    const payload = concatBytes(samples.map((s) => s.data));

    const samplesMeta = samples.map((s) => ({
      duration: s.durationTicks ?? 0,
      size: s.size,
      cts: s.ctsTicks,
      keyframe: s.keyframe,
    }));
    const moof = moofBox({
      seqNo: this.seqNo,
      trackId,
      baseDts: buf.samples[0].dtsTicks,
      samples: samplesMeta,
    });
    // 回填 trun.data_offset：moof 长度 + 8（mdat 头）
    patchDataOffset(moof, moof.length + 8);

    const segment = concatBytes([moof, mdatBox(payload)]);
    this.emit('mediaSegment', {
      trackId,
      seqNo: this.seqNo,
      baseDts: buf.samples[0].dtsTicks,
      data: segment,
    });
    this.seqNo++;

    buf.samples = [];
    buf.firstDts = null;
    buf.lastDts = null;
  }

  /** 全轨冲出残余（补最后一帧时长） */
  async flush() {
    if (this._done) return;
    this._done = true;
    for (const [, buf] of this.buffers) {
      const n = buf.samples.length;
      if (n > 0 && buf.samples[n - 1].durationTicks == null) {
        buf.samples[n - 1].durationTicks =
          n >= 2 ? (buf.samples[n - 2].durationTicks ?? 33) : 33;
      }
    }
    for (const trackId of [...this.buffers.keys()]) {
      this.cut(trackId);
    }
  }

  reset() {
    this.buffers.clear();
    this._tracks = [];
    this.initEmitted = false;
    this.seqNo = 1;
    this._done = false;
  }

  /* ------------------------------ init segment ------------------------------ */

  _emitInit() {
    if (this.initEmitted || this._tracks.length === 0) return;
    const trakBoxes = [];
    const trexDefs = [];

    for (const t of this._tracks) {
      if (t.type === 'video') {
        const entryType = t.codec.startsWith('hvc') ? 'hvc1' : 'avc1';
        let width = t.width ?? 0;
        let height = t.height ?? 0;
        try {
          if (t.codec.startsWith('avc')) {
            const info = parseAvcConfig(t.description);
            width = info.width ?? width;
            height = info.height ?? height;
          } else if (t.codec.startsWith('hvc')) {
            const info = parseHevcConfig(t.description);
            width = info.width ?? width;
            height = info.height ?? height;
          }
        } catch { /* 配置异常时退回轨道声明值 */ }
        const entry = videoSampleEntry(entryType, { width, height }, configBoxFor(t));
        trakBoxes.push(trakBox(
          tkhdBox({ trackId: t.id, width, height }),
          mdiaBox(
            mdhdBox(1000),
            hdlrBox('video'),
            minfBox(vmhdBox(), dinfBox(), stblBox(...emptyStblBoxes(entry))),
          ),
        ));
        trexDefs.push({ trackId: t.id, defaultFlags: 0x01010000 });
      } else if (t.type === 'audio' && t.codec.startsWith('mp4a')) {
        const entry = audioSampleEntry(t.sampleRate ?? 44100, t.numberOfChannels ?? 2, t.description);
        trakBoxes.push(trakBox(
          tkhdBox({ trackId: t.id }),
          mdiaBox(
            mdhdBox(t.timescale ?? 44100),
            hdlrBox('audio'),
            minfBox(smhdBox(), dinfBox(), stblBox(...emptyStblBoxes(entry))),
          ),
        ));
        trexDefs.push({ trackId: t.id, defaultFlags: 0x02000000 });
      } else if (t.type === 'audio') {
        continue;   // 非 AAC 音频无法容器化进 MSE 支持的 fMP4，跳过
      }
    }
    if (trakBoxes.length === 0) return;

    const timescale = this._tracks.find((t) => t.type === 'video')?.timescale
      ?? this._tracks.find((t) => t.type === 'audio')?.timescale
      ?? 1000;

    const init = concatBytes([
      ftypBox(),
      box('moov', mvhdBox(timescale), ...trakBoxes, mvexBox(trexDefs)),
    ]);
    this.initEmitted = true;
    this.emit('initSegment', { tracks: this._tracks, data: init });
  }
}

/** 按编码类型选择配置盒（avcC/hvcC 原样嵌入） */
function configBoxFor(track) {
  if (track.codec.startsWith('hvc')) return box('hvcC', track.description);
  return box('avcC', track.description);
}

/**
 * 回填 trun 的 data_offset 字段。
 * 布局：moof(mfhd/traf(tfhd/tfdt/trun)) —— trun 内容为
 *   version+flags(4) + sample_count(4) + data_offset(4)，即盒起始 + 16。
 */
function patchDataOffset(moof, value) {
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  function walk(start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      const size = view.getUint32(pos);
      const type = String.fromCharCode(moof[pos + 4], moof[pos + 5], moof[pos + 6], moof[pos + 7]);
      if (size < 8 || pos + size > end) return false;
      if (type === 'trun') {
        view.setUint32(pos + 16, value);
        return true;
      }
      if (type === 'moof' || type === 'traf') {
        if (walk(pos + 8, pos + size)) return true;
      }
      pos += size;
    }
    return false;
  }
  walk(0, moof.length);
}
