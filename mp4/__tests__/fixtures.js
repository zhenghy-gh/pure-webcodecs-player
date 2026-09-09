/**
 * 程序化 MP4 fixture：用 box-builder 拼出字节级合法的小文件，
 * 并导出期望样本表供测试断言。不依赖任何真实媒体文件。
 */
import {
  buildFtyp,
  buildMdat,
  buildMoov,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildDinf,
  buildStsd,
  buildMvex,
  buildMoofMdat,
  box,
} from '../src/box-builder.js';

/**
 * 手工位流转字节（与 core 测试同款辅助）。
 * @param {string} str 支持内联 /* 注释 *\/ 与空白
 */
function bitsToBytes(str) {
  const clean = str.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const out = new Uint8Array(Math.ceil(clean.length / 8));
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '1' && clean[i] !== '0') throw new Error(`bad bit char: ${clean[i]}`);
    if (clean[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/** 32x16 baseline SPS（profile 66 / level 30），与位流严格一致 */
export function makeSpsNalu() {
  const body = bitsToBytes(`
    1    /* seq_parameter_set_id ue(0) */
    1    /* log2_max_frame_num_minus4 ue(0) */
    1    /* pic_order_cnt_type ue(0) */
    1    /* log2_max_pic_order_cnt_lsb_minus4 ue(0) */
    1    /* max_num_ref_frames ue(0) */
    0    /* gaps_in_frame_num_value_allowed */
    010  /* pic_width_in_mbs_minus1 ue(1) → 宽 32 */
    1    /* pic_height_in_map_units_minus1 ue(0) → 高 16（frame_mbs_only=1） */
    1    /* frame_mbs_only_flag */
    1    /* direct_8x8_inference */
    0    /* frame_cropping_flag */
    0    /* vui_parameters_present */
    1    /* rbsp stop bit */
  `);
  const nalu = new Uint8Array(4 + body.length);
  nalu[0] = 0x67;
  nalu[1] = 66;
  nalu[2] = 0x00;
  nalu[3] = 30;
  nalu.set(body, 4);
  return nalu;
}

export function makePpsNalu() {
  return new Uint8Array([0x68, 0xce, 0x38, 0x80]);
}

/** 最小可用 avcC：lengthSize=4，单 SPS 单 PPS。对应 codec string avc1.42001E */
export function makeAvcCFixture() {
  const sps = makeSpsNalu();
  const pps = makePpsNalu();
  const out = [
    1, sps[1], sps[2], sps[3],
    0xff, // reserved(6b)=111111 | lengthSizeMinusOne=3
    0xe1, // reserved(3b)=111 | numOfSPS=1
    (sps.length >> 8) & 0xff, sps.length & 0xff,
    ...sps,
    1, // numOfPPS
    (pps.length >> 8) & 0xff, pps.length & 0xff,
    ...pps,
  ];
  return new Uint8Array(out);
}

/** AAC-LC 44.1kHz 双声道的 AudioSpecificConfig */
export function makeAscFixture() {
  return new Uint8Array([0x12, 0x10]);
}

/**
 * 构造渐进式普通 MP4：ftyp(isom) + moov(视频轨) + mdat。
 * 视频轨 8 样本、25fps、关键帧 #0/#4、B 帧 ctts、每 chunk 2 样本。
 */
export function buildProgressiveVideoFixture() {
  const avcC = makeAvcCFixture();
  const track = {
    id: 1,
    type: 'video',
    codecPrivate: avcC,
    sampleEntryType: 'avc1',
    timescale: 1000,
    duration: 8 * 40,
    language: 'und',
    width: 320,
    height: 240,
  };

  const sizes = [120, 64, 64, 72, 104, 64, 64, 64];
  const videoPayloads = sizes.map((size, i) => {
    const data = new Uint8Array(size);
    for (let j = 0; j < size; j++) data[j] = (i * 31 + j) & 0xff;
    return data;
  });

  const cttsOffsets = [
    { count: 1, offset: 0 },
    { count: 3, offset: 80 },
    { count: 1, offset: -80 },
    { count: 3, offset: 80 },
  ];

  const spec = {
    timescale: 1000,
    duration: 8 * 40,
    tracks: [
      {
        track,
        sizes,
        keyframeIndices: [0, 4],
        // 占位必须与最终等长，保证两遍 moov 字节数一致（stco 条目数不变）
        chunkOffsets: [0, 0, 0, 0],
        samplesPerChunk: 2,
        sttsRuns: [{ count: 8, delta: 40 }],
        cttsOffsets,
      },
    ],
  };

  const ftyp = buildFtyp({ majorBrand: 'isom', compatible: ['isom', 'iso2', 'avc1', 'mp41'] });
  const probeMoov = buildMoov(spec); // 占位偏移量长度
  let base = ftyp.byteLength + probeMoov.byteLength;

  const chunkOffsets = [];
  let cursor = 0;
  for (let c = 0; c < 4; c++) {
    chunkOffsets.push(base + 8 + cursor);
    cursor += sizes[c * 2] + sizes[c * 2 + 1];
  }
  spec.tracks[0].chunkOffsets = chunkOffsets;

  const moov = buildMoov(spec);
  const mdat = buildMdat(videoPayloads);

  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  bytes.set(ftyp, 0);
  bytes.set(moov, ftyp.byteLength);
  bytes.set(mdat, ftyp.byteLength + moov.byteLength);

  // 期望样本表
  const ctsByIndex = [];
  for (const run of cttsOffsets) {
    for (let i = 0; i < run.count; i++) ctsByIndex.push(run.offset);
  }
  const expectedSamples = [];
  let dts = 0;
  for (let i = 0; i < 8; i++) {
    expectedSamples.push({
      index: i,
      dts,
      pts: dts + ctsByIndex[i],
      duration: 40,
      size: sizes[i],
      keyframe: i === 0 || i === 4,
      offset: chunkOffsets[Math.floor(i / 2)] + (i % 2 === 1 ? sizes[i - 1] : 0),
    });
    dts += 40;
  }

  return { bytes, videoPayloads, expectedSamples, avcC };
}

/* ------------------------------ fMP4 fixture ------------------------------ */

function makeVideoTrackMeta(trackId, avcC) {
  return {
    id: trackId,
    type: 'video',
    codecPrivate: avcC,
    sampleEntryType: 'avc1',
    timescale: 1000,
    duration: 0,
    language: 'und',
    width: 320,
    height: 240,
  };
}

/**
 * 分片 MP4：ftyp(msfh) + moov(stsd-only stbl + mvex/trex) + [moof+mdat]×2。
 * 视频 6 样本，delta=40，关键帧为每片首样本；返回全部字节与逐样本期望。
 */
export function buildFragmentedFixture() {
  const avcC = makeAvcCFixture();
  const trackId = 1;
  const timescale = 1000;
  const delta = 40;

  const ftyp = buildFtyp({ majorBrand: 'msfh', compatible: ['msfh', 'isom', 'iso2'] });
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale, duration: 0, nextTrackId: trackId + 1 }));
    w.writeRaw(
      box('trak', (tw) => {
        tw.writeRaw(buildTkhd({ trackId, duration: 0, isVideo: true, width: 320, height: 240 }));
        tw.writeRaw(
          box('mdia', (mw) => {
            mw.writeRaw(buildMdhd({ timescale, duration: 0 }));
            mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'fmp4 fixture' }));
            mw.writeRaw(
              box('minf', (iw) => {
                iw.writeRaw(buildVmhd());
                iw.writeRaw(buildDinf());
                iw.writeRaw(box('stbl', (sw) => sw.writeRaw(buildStsd(makeVideoTrackMeta(trackId, avcC)))));
              }),
            );
          }),
        );
      }),
    );
    w.writeRaw(buildMvex([trackId], { [trackId]: { defaultSampleDuration: delta } }));
  });

  const parts = [ftyp, moov];
  let totalLen = ftyp.byteLength + moov.byteLength;
  const fragSpecs = [
    { base: 0, sizes: [96, 48, 48] },
    { base: 120, sizes: [88, 48, 48] },
  ];

  const expectedSamples = [];
  let globalIndex = 0;
  const fragmentBytes = fragSpecs.map((spec, seq) => {
    let dts = spec.base;
    const samples = spec.sizes.map((size, k) => {
      const data = new Uint8Array(size);
      for (let j = 0; j < size; j++) data[j] = (globalIndex * 7 + j) & 0xff;
      const sample = {
        index: globalIndex++,
        dts,
        pts: dts,
        duration: delta,
        size,
        keyframe: k === 0,
        data,
      };
      expectedSamples.push(sample);
      dts += delta;
      return sample;
    });
    const { data } = buildMoofMdat({
      sequenceNumber: seq,
      trackId,
      baseMediaDecodeTime: spec.base,
      samples,
    });
    totalLen += data.byteLength;
    return data;
  });

  const bytes = new Uint8Array(totalLen);
  let off = 0;
  for (const p of [...parts, ...fragmentBytes]) {
    bytes.set(p, off);
    off += p.byteLength;
  }

  return { bytes, expectedSamples, trackId, timescale, delta, avcC };
}
