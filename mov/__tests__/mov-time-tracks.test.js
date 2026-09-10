/**
 * 时间与轨道专项：mvhd/mdhd/tkhd/elst 的 64 位（version=1）变体、
 * 时间基换算、tkhd enabled 位、轨类型分派（text/metadata）、mvex 分片标记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MovDemuxer } from '../src/demuxer.js';
import { interpretEdits } from '../src/atom-compat.js';
import { MemoryDataSource } from '../../core/src/index.js';
import {
  box,
  fullBox,
  buildFtyp,
  buildMdat,
  buildTkhd,
  buildMdhd,
  buildHdlr,
  buildDinf,
  buildStts,
  buildStsc,
  buildStsz,
  buildStco,
} from '../../mp4/src/box-builder.js';

/** 手拼 mvhd version=1（u64 时间戳 + u64 duration） */
function buildMvhdV1(timescale, duration) {
  const out = new Uint8Array(8 + 108);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.byteLength);
  out.set([0x6d, 0x76, 0x68, 0x64], 4); // 'mvhd'
  out[8] = 1; // version=1；flags 3 字节（9..12）保持 0
  dv.setBigUint64(12, 0n); // creation（12..20）
  dv.setBigUint64(20, 0n); // modification（20..28）
  dv.setUint32(28, timescale); // 28..32
  dv.setBigUint64(32, BigInt(duration)); // 32..40
  dv.setUint32(40, 0x00010000); // rate 1.0
  dv.setUint16(44, 0x0100); // volume 1.0
  // rest zero（reserved + matrix + pre_defined）
  return out;
}

/** 手拼 mdhd version=1（u64 时间戳 + u64 duration）+ language */
function buildMdhdV1(timescale, duration, lang = 'und') {
  const out = new Uint8Array(8 + 38); // 4+4+8+8+4+8+2 内容 38 字节
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.byteLength);
  out.set([0x6d, 0x64, 0x68, 0x64], 4);
  out[8] = 1; // version=1；flags 3 字节（9..12）保持 0
  dv.setBigUint64(12, 0n); // creation（12..20）
  dv.setBigUint64(20, 0n); // modification（20..28）
  dv.setUint32(28, timescale); // 28..32
  dv.setBigUint64(32, BigInt(duration)); // 32..40
  const lc = (c) => c.charCodeAt(0) - 96;
  dv.setUint16(40, (lc(lang[0]) << 10) | (lc(lang[1]) << 5) | lc(lang[2]));
  return out;
}

/** 手拼 elst version=1：entries = [{segmentDuration, mediaTime}]，mediaTime 有符号 u64 */
function buildEdtsV1(entries) {
  return box('edts', (w) => {
    const inner = fullBox('elst', 1, 0, (ew) => {
      ew.writeU32(entries.length);
      for (const e of entries) {
        ew.writeU64(BigInt(e.segmentDuration));
        ew.writeI64(BigInt(e.mediaTime));
        ew.writeU16(1).writeU16(0); // media rate
      }
    });
    if (inner) w.writeRaw(inner);
  });
}

/** 单轨（无样本表数据）最小 mov */
function buildSingleTrackMov({ mvhd, trakBody, withMdat = false } = {}) {
  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  const moov = box('moov', (w) => {
    w.writeRaw(mvhd);
    w.writeRaw(box('trak', (tw) => tw.writeRaw(trakBody)));
  });
  const parts = [ftyp, new Uint8Array(moov)];
  if (withMdat) parts.push(buildMdat([new Uint8Array([1, 2, 3, 4])]));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return bytes;
}

test('mvhd/mdhd version=1（64 位 duration）正确换算 durationUs', async () => {
  const trakBody = box('mdia', (mw) => {
    mw.writeRaw(buildMdhdV1(600, 240000));
    mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'v' }));
    mw.writeRaw(
      box('minf', (iw) => {
        iw.writeRaw(buildDinf());
        iw.writeRaw(
          box('stbl', (sw) => {
            sw.writeRaw(buildStts([]));
            sw.writeRaw(buildStsc([]));
            sw.writeRaw(buildStsz([], 0));
            sw.writeRaw(buildStco([]));
          }),
        );
      }),
    );
  });
  const bytes = buildSingleTrackMov({
    mvhd: buildMvhdV1(600, 240000),
    trakBody: (() => {
      // trak 内容：tkhd + mdia
      const tkhd = buildTkhd({ trackId: 1, duration: 240000, isVideo: true, width: 16, height: 16 });
      const out = new Uint8Array(tkhd.byteLength + trakBody.byteLength);
      out.set(tkhd, 0);
      out.set(trakBody, tkhd.byteLength);
      return out;
    })(),
    withMdat: true,
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.durationUs, 400000000, '240000/600 = 400s');
  assert.equal(info.tracks[0].durationUs, 400000000);
  assert.equal(info.tracks[0].type, 'video');
});

test('tkhd enabled/disabled 位与 v0 duration 保留', async () => {
  const { parseTrak } = await import('../src/index.js');
  const enabled = box('trak', (tw) => {
    tw.writeRaw(buildTkhd({ trackId: 5, duration: 100, isVideo: true }));
    tw.writeRaw(
      box('mdia', (mw) => {
        mw.writeRaw(buildMdhd({ timescale: 600, duration: 100 }));
        mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'a' }));
      }),
    );
  });
  const t1 = parseTrak(enabled);
  assert.equal(t1.tkhd.enabled, true, 'buildTkhd 默认 flags=1 enabled');

  // flags=0：disabled tkhd
  const disabledTkhd = fullBox('tkhd', 0, 0, (w) => {
    w.writeU32(0).writeU32(0); // creation/modification
    w.writeU32(9); // trackId
    w.writeU32(0); // reserved
    w.writeU32(100); // duration
    w.writeU32(0).writeU32(0); // reserved[2]
    w.writeU16(0).writeU16(0); // layer / alternate_group
    w.writeU16(0); // volume
    w.writeU16(0); // reserved
    for (let i = 0; i < 9; i++) w.writeU32(i === 0 || i === 4 || i === 8 ? 0x00010000 : 0); // unity matrix
    w.writeU32(320 << 16); // width 16.16
    w.writeU32(240 << 16); // height 16.16
  });
  const trak2 = box('trak', (tw) => {
    tw.writeRaw(disabledTkhd);
    tw.writeRaw(
      box('mdia', (mw) => {
        mw.writeRaw(buildMdhd({ timescale: 600, duration: 100 }));
        mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'b' }));
      }),
    );
  });
  const t2 = parseTrak(trak2);
  assert.equal(t2.tkhd.enabled, false);
  assert.equal(t2.tkhd.trackId, 9);
  assert.equal(t2.tkhd.width, 320);
  assert.equal(t2.tkhd.height, 240);
});

test('轨类型分派：hdlr=text → TEXT 轨；未知 handler → METADATA', async () => {
  const { buildMvhd } = await import('../../mp4/src/box-builder.js');
  // 返回 trak 内容：tkhd + mdia
  const mkTrakBody = (handler) => {
    const tkhd = buildTkhd({ trackId: 1, duration: 0 });
    const mdia = box('mdia', (mw) => {
      mw.writeRaw(buildMdhd({ timescale: 600, duration: 0 }));
      mw.writeRaw(buildHdlr({ handlerType: handler, name: 'h' }));
      mw.writeRaw(
        box('minf', (iw) => {
          iw.writeRaw(buildDinf());
          iw.writeRaw(
            box('stbl', (sw) => {
              sw.writeRaw(buildStts([]));
              sw.writeRaw(buildStsc([]));
              sw.writeRaw(buildStsz([], 0));
              sw.writeRaw(buildStco([]));
            }),
          );
        }),
      );
    });
    const out = new Uint8Array(tkhd.byteLength + mdia.byteLength);
    out.set(tkhd, 0);
    out.set(mdia, tkhd.byteLength);
    return out;
  };

  const textBytes = buildSingleTrackMov({
    mvhd: buildMvhd({ timescale: 600, duration: 0, nextTrackId: 2 }),
    trakBody: mkTrakBody('text'),
  });
  const d1 = new MovDemuxer(new MemoryDataSource(textBytes));
  const info1 = await d1.open();
  assert.equal(info1.tracks[0].type, 'text');

  const metaBytes = buildSingleTrackMov({
    mvhd: buildMvhd({ timescale: 600, duration: 0, nextTrackId: 2 }),
    trakBody: mkTrakBody('hint'),
  });
  const d2 = new MovDemuxer(new MemoryDataSource(metaBytes));
  const info2 = await d2.open();
  assert.equal(info2.tracks[0].type, 'metadata');
});

test('elst version=1：负 mediaTime 空编辑 + 秒换算', async () => {
  // 纯单元：interpretEdits 接收 parseElst 形状
  const r = interpretEdits(
    { entries: [{ segmentDuration: 240, mediaTime: -7200 }, { segmentDuration: 240, mediaTime: 300 }] },
    600,
  );
  assert.equal(r.hasEmptyEdit, true);
  assert.ok(Math.abs(r.firstMediaTimeSec - 0.5) < 1e-9);
  assert.equal(interpretEdits({ entries: [] }, 600).firstMediaTimeSec, null);
  assert.deepEqual(interpretEdits(undefined, 600), { hasEmptyEdit: false, firstMediaTimeSec: null });
  // timescale=0 时不除零，返回 null
  assert.equal(
    interpretEdits({ entries: [{ segmentDuration: 1, mediaTime: 10 }] }, 0).firstMediaTimeSec,
    null,
  );
});

test('elst version=1 端到端：mediaTimeSec 应用到 track', async () => {
  const { buildMvhd } = await import('../../mp4/src/box-builder.js');
  const trakBody = (() => {
    const edts = buildEdtsV1([{ segmentDuration: 120, mediaTime: 600 }]); // 1 秒处起播
    const tkhd = buildTkhd({ trackId: 1, duration: 240, isVideo: true, width: 8, height: 8 });
    const mdia = box('mdia', (mw) => {
      mw.writeRaw(buildMdhd({ timescale: 600, duration: 240 }));
      mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'v' }));
      mw.writeRaw(
        box('minf', (iw) => {
          iw.writeRaw(buildDinf());
          iw.writeRaw(
            box('stbl', (sw) => {
              sw.writeRaw(buildStts([]));
              sw.writeRaw(buildStsc([]));
              sw.writeRaw(buildStsz([], 0));
              sw.writeRaw(buildStco([]));
            }),
          );
        }),
      );
    });
    const out = new Uint8Array(edts.byteLength + tkhd.byteLength + mdia.byteLength);
    out.set(edts, 0);
    out.set(tkhd, edts.byteLength);
    out.set(mdia, edts.byteLength + tkhd.byteLength);
    return out;
  })();
  const bytes = buildSingleTrackMov({
    mvhd: buildMvhd({ timescale: 600, duration: 240, nextTrackId: 2 }),
    trakBody,
    withMdat: true,
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.tracks[0].emptyEdit, false);
  assert.ok(Math.abs(info.tracks[0].mediaTimeSec - 1) < 1e-9);
});

test('mvhd duration=0 → durationUs 为 null（未知时长）', async () => {
  const { buildMvhd } = await import('../../mp4/src/box-builder.js');
  const bytes = buildSingleTrackMov({
    mvhd: buildMvhd({ timescale: 600, duration: 0, nextTrackId: 2 }),
    trakBody: (() => {
      const tkhd = buildTkhd({ trackId: 1, duration: 0 });
      const mdia = box('mdia', (mw) => {
        mw.writeRaw(buildMdhd({ timescale: 600, duration: 0 }));
        mw.writeRaw(buildHdlr({ handlerType: 'soun', name: 'a' }));
        mw.writeRaw(
          box('minf', (iw) => {
            iw.writeRaw(buildDinf());
            iw.writeRaw(
              box('stbl', (sw) => {
                sw.writeRaw(buildStts([]));
                sw.writeRaw(buildStsc([]));
                sw.writeRaw(buildStsz([], 0));
                sw.writeRaw(buildStco([]));
              }),
            );
          }),
        );
      });
      const out = new Uint8Array(tkhd.byteLength + mdia.byteLength);
      out.set(tkhd, 0);
      out.set(mdia, tkhd.byteLength);
      return out;
    })(),
  });
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  assert.equal(info.durationUs, null);
});
