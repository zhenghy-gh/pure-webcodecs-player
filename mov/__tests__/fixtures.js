/**
 * 程序化 QuickTime fixture：QT 品牌 + wide 占位 + 三轨 moov（视频/音频v2/tmcd）
 * + udta 元数据 + mdat；另提供压缩 moov 的拒绝用例。
 */
import { ByteWriter } from '../../core/src/index.js';
import {
  buildFtyp,
  buildMdat,
  buildMvhd,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildVmhd,
  buildSmhd,
  buildDinf,
  buildStsd,
  buildStts,
  buildStsc,
  buildStsz,
  buildStco,
  buildCtts,
  buildStss,
  buildEdts,
  buildEsds,
  box,
} from '../../mp4/src/box-builder.js';
import { makeAvcCFixture } from '../../mp4/__tests__/fixtures.js';

export function makeSpsNalu() {
  return new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0xd4, 0x28]);
}

/** QuickTime SoundDescriptionV2 sample entry（Float64 采样率布局） */
function buildMp4aV2Entry({ channelCount = 2, sampleSize = 16, sampleRate = 44100 }, ascBytes) {
  return box('mp4a', (w) => {
    // SampleEntry 公共头：reserved[6] + data_reference_index
    for (let i = 0; i < 6; i++) w.writeU8(0);
    w.writeU16(1);
    // v2 扩展：从 version 开始
    w.writeU16(2); // version = 2
    w.writeU16(0); // revision
    w.writeFourCC('nemu'); // vendor
    w.writeU32(0).writeU32(0); // reserved[2]
    w.writeF64(sampleRate);
    w.writeU32(channelCount);
    w.writeU32(sampleSize);
    w.writeU32(0); // format flags
    w.writeU32(0); // reserved
    w.writeRaw(buildEsds(ascBytes));
  });
}

/**
 * 构造完整 QuickTime .mov：
 *   ftyp(qt  ) + wide + moov(mvhd | trak视频(elst空编辑) | trak音频(v2) | trak时间码 | udta(meta)) + mdat
 * 视频 6 样本，timescale 600，delta 40，关键帧 #0/#3。
 */
export function buildQuickTimeMovFixture() {
  const avcC = makeAvcCFixture();
  const MOVIE_TS = 600;

  /* ---------- 视频轨 ---------- */
  const videoTrackMeta = {
    id: 1,
    type: 'video',
    codecPrivate: avcC,
    sampleEntryType: 'avc1',
    timescale: MOVIE_TS,
    duration: 240,
    language: 'und',
    width: 320,
    height: 240,
  };
  const sizes = [96, 48, 48, 80, 48, 48];
  const videoPayloads = sizes.map((size, i) => {
    const data = new Uint8Array(size);
    for (let j = 0; j < size; j++) data[j] = (i * 13 + j * 7) & 0xff;
    return data;
  });

  function buildMoovWithOffsets(chunkOffsets) {
    return box('moov', (w) => {
      w.writeRaw(buildMvhd({ timescale: MOVIE_TS, duration: 240, nextTrackId: 4 }));
      // 视频轨：含 elst 空编辑
      w.writeRaw(
        box('trak', (tw) => {
          const edts = buildEdts({
            entries: [
              { segmentDuration: 120, mediaTime: -1 }, // 空编辑占位
              { segmentDuration: 120, mediaTime: 0 },
            ],
          });
          if (edts) tw.writeRaw(edts);
          tw.writeRaw(buildTkhd({ trackId: 1, duration: 240, isVideo: true, width: 320, height: 240 }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: MOVIE_TS, duration: 240 }));
              mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'qt video' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(buildVmhd());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(buildStsd(videoTrackMeta));
                      sw.writeRaw(buildStts([{ count: 6, delta: 40 }]));
                      sw.writeRaw(buildCtts(null));
                      sw.writeRaw(buildStss([0, 3]));
                      sw.writeRaw(buildStsc(sizes.map((_, k) => ({ firstChunk: k, samplesPerChunk: 1 }))));
                      sw.writeRaw(buildStsz(sizes));
                      sw.writeRaw(buildStco(chunkOffsets));
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );

      // 音频轨：SoundDescriptionV2，无样本（表为空）
      w.writeRaw(
        box('trak', (tw) => {
          tw.writeRaw(buildTkhd({ trackId: 2, duration: 240, isAudio: true }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: 44100, duration: 8820 }));
              mw.writeRaw(buildHdlr({ handlerType: 'soun', name: 'qt audio' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(buildSmhd());
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(box('stsd', (dw) => {
                        dw.writeU8(0).writeU24(0); // version/flags
                        dw.writeU32(1);
                        dw.writeRaw(buildMp4aV2Entry({}, new Uint8Array([0x12, 0x10])));
                      }));
                      sw.writeRaw(buildStts([]));
                      sw.writeRaw(buildStsc([]));
                      sw.writeRaw(buildStsz([], 0));
                      sw.writeRaw(buildStco([]));
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );

      // 时间码轨（tmcd）
      w.writeRaw(
        box('trak', (tw) => {
          tw.writeRaw(buildTkhd({ trackId: 3, duration: 240 }));
          tw.writeRaw(
            box('mdia', (mw) => {
              mw.writeRaw(buildMdhd({ timescale: 30, duration: 12 }));
              mw.writeRaw(buildHdlr({ handlerType: 'tmcd', name: 'timecode' }));
              mw.writeRaw(
                box('minf', (iw) => {
                  iw.writeRaw(new Uint8Array([0, 0, 0, 12, 0x6e, 0x6d, 0x68, 0x64, 0, 0, 0, 0])); // nmhd
                  iw.writeRaw(buildDinf());
                  iw.writeRaw(
                    box('stbl', (sw) => {
                      sw.writeRaw(box('stsd', (dw) => {
                        dw.writeU8(0).writeU24(0);
                        dw.writeU32(1);
                        dw.writeRaw(
                          box('tmcd', (ew) => {
                            for (let i = 0; i < 6; i++) ew.writeU8(0);
                            ew.writeU16(1); // data_reference_index
                            // TimeCodeDef 子 atom
                            ew.writeRaw(box('tmcd', (tcw) => {
                              tcw.writeU32(1); // flags: drop frame?
                              tcw.writeU32(30); // time scale
                              tcw.writeU32(2); // frame duration
                              tcw.writeU8(2); // number of frames
                              tcw.writeU8(0).writeU16(0); // padding
                            }));
                          }),
                        );
                      }));
                      sw.writeRaw(buildStts([]));
                      sw.writeRaw(buildStsc([]));
                      sw.writeRaw(buildStsz([], 0));
                      sw.writeRaw(buildStco([]));
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );

      // udta > meta(QT 风格) > hdlr(mdir) + 文本标签
      w.writeRaw(
        box('udta', (uw) => {
          uw.writeRaw(
            box('meta', (mw) => {
              mw.writeRaw(buildHdlr({ handlerType: 'mdir', name: 'appl' }));
              mw.writeRaw(textAtom('©nam', '测试标题'));
              mw.writeRaw(textAtom('©ART', '测试作者'));
            }),
          );
        }),
      );
    });
  }

  const ftyp = buildFtyp({ majorBrand: 'qt  ', minorVersion: 0, compatible: ['qt  '] });
  const wide = new Uint8Array([0, 0, 0, 8, 0x77, 0x69, 0x64, 0x65]); // 'wide'
  // 占位必须等长（6 个 stco 条目），保证两遍构造的 moov 字节数一致
  const probeMoov = buildMoovWithOffsets([0, 0, 0, 0, 0, 0]);
  let base = ftyp.byteLength + wide.byteLength + probeMoov.byteLength;
  // 每样本一个 chunk
  const chunkOffsets = [];
  let cursor = 0;
  for (let k = 0; k < sizes.length; k++) {
    chunkOffsets.push(base + 8 + cursor);
    cursor += sizes[k];
  }
  const probe2 = buildMoovWithOffsets(chunkOffsets);
  if (probe2.byteLength !== probeMoov.byteLength) {
    throw new Error(`fixture internal error: moov size drift ${probeMoov.byteLength} -> ${probe2.byteLength}`);
  }
  void probe2;
  const moov = buildMoovWithOffsets(chunkOffsets);
  const mdat = buildMdat(videoPayloads);

  const bytes = new Uint8Array(ftyp.byteLength + wide.byteLength + moov.byteLength + mdat.byteLength);
  let off = 0;
  for (const part of [ftyp, wide, moov, mdat]) {
    bytes.set(part, off);
    off += part.byteLength;
  }

  const expectedSamples = sizes.map((size, i) => ({
    index: i,
    dts: i * 40,
    pts: i * 40,
    duration: 40,
    size,
    keyframe: i === 0 || i === 3,
    offset: chunkOffsets[i],
  }));

  return {
    bytes,
    videoPayloads,
    expectedSamples,
    avcC,
    movieTimescale: MOVIE_TS,
    expectedTags: { '©nam': '测试标题', '©ART': '测试作者' },
  };
}

/** 文本标签 atom：u16 大端长度 + UTF-8 */
function textAtom(type, text) {
  const payload = Buffer.from(text, 'utf-8');
  const out = new Uint8Array(8 + 2 + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 10 + payload.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  dv.setUint16(8, payload.byteLength);
  out.set(payload, 10);
  return out;
}

/** 压缩 moov（cmov/dcom/cmv d）fixture：仅用于验证拒绝路径 */
export function buildCompressedMovFixture() {
  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  const moov = box('moov', (w) => {
    w.writeRaw(
      box('cmov', (cw) => {
        cw.writeRaw(box('dcom', (dw) => dw.writeFourCC('zlib')));
        cw.writeRaw(box('cmvd', (dw) => {
          dw.writeU32(16); // 解压后大小
          dw.writeRaw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        }));
      }),
    );
  });
  const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength);
  bytes.set(ftyp, 0);
  bytes.set(moov, ftyp.byteLength);
  return { bytes };
}
