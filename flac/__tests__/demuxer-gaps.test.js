/**
 * flac demuxer 残余分支补测（wave 124）：
 *  - probe 防御性 catch（非法入参不抛异常）
 *  - 元数据截断：首读 64KB 块越界 → 按 cap 全量重读解析成功
 *  - 未 parseInit 时 getBufferedRanges 空区间 / destroy 后 seek STATE_ERROR
 *  - seek 中建索引读取抛错 → error 态
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlacDemuxer } from '../src/demuxer.js';

function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** STREAMINFO 34 字节（md5 全零） */
function streamInfoBody({ sampleRate = 48000, channels = 1, bps = 16, totalSamples = 0 } = {}) {
  const b = new Uint8Array(34);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 16);
  dv.setUint16(2, 16);
  dv.setUint32(10, (sampleRate << 12) | ((channels - 1) << 9) | ((bps - 1) << 4));
  const tsHi = Math.floor(totalSamples / 2 ** 32);
  const tsLo = totalSamples >>> 0;
  b[13] = (b[13] & 0xf0) | (tsHi & 0x0f);
  dv.setUint32(14, tsLo);
  return b;
}

function metaBlock(type, body, last) {
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | type;
  head[1] = (body.length >> 16) & 0xff;
  head[2] = (body.length >> 8) & 0xff;
  head[3] = body.length & 0xff;
  return concatBytes(head, body);
}

function buildFlac({ streamInfo = {}, extraBlocks = [] }) {
  const magic = new TextEncoder().encode('fLaC');
  const blocks = [metaBlock(0, streamInfoBody(streamInfo), extraBlocks.length === 0)];
  extraBlocks.forEach((blk, i) => {
    blocks.push(metaBlock(blk.type, blk.body, i === extraBlocks.length - 1));
  });
  return concatBytes(magic, ...blocks);
}

function memorySource(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) { return bytes.subarray(offset, offset + length); },
    async close() {},
  };
}

test('probe：null 入参走防御性 catch 返回 null，不抛异常', () => {
  assert.equal(FlacDemuxer.probe(null), null);
});

test('getBufferedRanges：parseInit 前返回空区间', () => {
  const dem = new FlacDemuxer(memorySource(buildFlac({})));
  assert.deepEqual(dem.getBufferedRanges(1), []);
});

test('元数据块截断：首读 64KB 触发块越界 → 按 cap 全量重读解析成功', async () => {
  // PADDING 块体 70000B > 首读 65536B，逼出「重读 cap」分支
  const bytes = buildFlac({
    streamInfo: { totalSamples: 0 },
    extraBlocks: [{ type: 1, body: new Uint8Array(70000) }],
  });
  const dem = new FlacDemuxer(memorySource(bytes));
  const info = await dem.parseInit();
  assert.equal(info.container, 'flac');
  assert.equal(dem.flacMetadata.audioOffset, 4 + (4 + 34) + (4 + 70000), 'audioOffset 落在音频起点');
});

test('getBufferedRanges：durationUs 有效时返回全区间', async () => {
  const bytes = buildFlac({ streamInfo: { totalSamples: 48000 } });
  const dem = new FlacDemuxer(memorySource(bytes));
  await dem.parseInit();
  assert.deepEqual(dem.getBufferedRanges(1), [{ startUs: 0, endUs: 1_000_000 }]);
  await dem.stop();
});

test('seek：destroy 后调用 → STATE_ERROR（当前态 destroyed）', async () => {
  const dem = new FlacDemuxer(memorySource(buildFlac({})));
  await dem.parseInit();
  await dem.destroy();
  await assert.rejects(
    () => dem.seek(1000),
    (e) => e.code === 'STATE_ERROR'
  );
});

test('seek 中建索引读取抛错 → error 态并透传原错误', async () => {
  const bytes = buildFlac({ streamInfo: { totalSamples: 48000 } });
  let calls = 0;
  const source = {
    size: bytes.length,
    async read(offset, length) {
      calls += 1;
      if (calls === 1) return bytes.subarray(offset, offset + length); // parseInit
      throw new Error('scan io exploded'); // seek → buildFrameIndex
    },
    async close() {},
  };
  const dem = new FlacDemuxer(source);
  await dem.parseInit();
  await assert.rejects(() => dem.seek(1000), /scan io exploded/);
  assert.equal(dem.state, 'error', 'seek 失败须进入 error 态');
});
