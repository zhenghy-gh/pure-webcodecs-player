/**
 * wav demuxer 残余分支补测（wave 124）：
 *  - probe 防御性 catch（非法入参不抛异常）
 *  - 未 parseInit 时 getBufferedRanges / seek 的 STATE_ERROR 面
 *  - 迭代中源读取抛错 → error 态 + 'error' 事件（非 abort 控制流）
 *  - 迭代中 abort → ABORTED 上抛但不置 error 态、不进 'error' 事件面
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WavDemuxer } from '../src/demuxer.js';

/** 极简 PCM 16-bit 单声道 WAV */
function buildWav(frames = 8, sampleRate = 8000) {
  const dataBytes = frames * 2;
  const total = 12 + (8 + 16) + (8 + dataBytes);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const tag = (s) => { for (const ch of s) dv.setUint8(p++, ch.charCodeAt(0)); };
  tag('RIFF'); dv.setUint32(p, total - 8, true); p += 4; tag('WAVE');
  tag('fmt '); dv.setUint32(p, 16, true); p += 4;
  dv.setUint16(p, 1, true); p += 2;            // PCM
  dv.setUint16(p, 1, true); p += 2;            // 单声道
  dv.setUint32(p, sampleRate, true); p += 4;
  dv.setUint32(p, sampleRate * 2, true); p += 4; // byteRate
  dv.setUint16(p, 2, true); p += 2;            // blockAlign
  dv.setUint16(p, 16, true); p += 2;           // bits
  tag('data'); dv.setUint32(p, dataBytes, true); p += 4;
  for (let i = 0; i < dataBytes; i++) u8[p + i] = (i * 7) & 0xff;
  return u8;
}

/** 可编排故障的源：offset=0 正常返回；offset>0 按 failMode 抛错/挂起 */
function flakySource(bytes, failMode) {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (offset === 0) return bytes.subarray(0, length);
      if (failMode === 'throw') throw new Error('io exploded');
      if (failMode === 'hang') return new Promise(() => {});
      return bytes.subarray(offset, offset + length);
    },
    async close() {},
  };
}

function buildBoundaryWav(dataHeaderOffset, includeData = true) {
  const base = buildWav(1);
  const end = dataHeaderOffset + (includeData ? 10 : 0);
  const bytes = new Uint8Array(end);
  bytes.set(base.subarray(0, 36));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(4, end - 8, true);
  bytes.set([0x4a, 0x55, 0x4e, 0x4b], 36);
  dv.setUint32(40, dataHeaderOffset - 44, true);
  if (includeData) bytes.set(base.subarray(36), dataHeaderOffset);
  return bytes;
}

test('WavDemuxer 在头窗口边界读取完整 data 块头', async () => {
  for (const inWindow of [0, 2, 4, 6]) {
    const bytes = buildBoundaryWav(65536 - inWindow);
    for (const knownSize of [true, false]) {
      for (const maxRead of [Infinity, 4093]) {
        const reads = [];
        const source = {
          size: knownSize ? bytes.length : null,
          async read(offset, length) {
            reads.push(offset);
            return bytes.subarray(offset, offset + Math.min(length, maxRead));
          },
        };
        const dem = new WavDemuxer(source);
        const info = await dem.open();
        assert.equal(info.tracks[0].audio.sampleRate, 8000);
        assert.ok(reads.includes(65536), `inWindow=${inWindow}, knownSize=${knownSize}`);
        const sample = await dem.readSample(1);
        assert.deepEqual(sample.data, new Uint8Array([0, 7]));
        await dem.destroy();
      }
    }
  }
});

test('WavDemuxer 在头窗口边界继续查找 fmt', async () => {
  const base = buildWav(1);
  const bytes = new Uint8Array(65536 + base.length - 12);
  bytes.set(base.subarray(0, 12));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(4, bytes.length - 8, true);
  bytes.set([0x4a, 0x55, 0x4e, 0x4b], 12);
  dv.setUint32(16, 65536 - 20, true);
  bytes.set(base.subarray(12), 65536);
  for (const knownSize of [true, false]) {
    const source = { size: knownSize ? bytes.length : null, async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    } };
    const dem = new WavDemuxer(source);
    assert.equal((await dem.open()).tracks[0].audio.sampleRate, 8000);
    assert.deepEqual((await dem.readSample(1)).data, new Uint8Array([0, 7]));
    await dem.destroy();
  }
});

test('WavDemuxer 头窗口达到64 MiB上限后停止扩容', async () => {
  const max = 64 * 1024 * 1024;
  const prefix = buildBoundaryWav(65536, false).subarray(0, 44);
  new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).setUint32(40, max - 44, true);
  const reads = [];
  const source = { size: max + 8, async read(offset, length) {
    reads.push([offset, length]);
    const part = new Uint8Array(length);
    if (offset === 0) part.set(prefix);
    return part;
  } };
  const dem = new WavDemuxer(source);
  await assert.rejects(() => dem.open(), (e) => e.code === 'PARSE_ERROR' && /缺少 data/.test(e.message));
  assert.ok(reads.every(([offset, length]) => offset + length <= max));
  assert.equal(reads.at(-1)[0] + reads.at(-1)[1], max);
  await dem.destroy();
});

test('WavDemuxer 窗口恰为真实 EOF 且无 data 时终止并报错', async () => {
  const bytes = buildBoundaryWav(65536, false);
  for (const knownSize of [true, false]) {
    const reads = [];
    const source = {
      size: knownSize ? bytes.length : null,
      async read(offset, length) {
        reads.push(offset);
        return bytes.subarray(offset, offset + length);
      },
    };
    const dem = new WavDemuxer(source);
    await assert.rejects(() => dem.open(), (e) => e.code === 'PARSE_ERROR' && /缺少 data/.test(e.message));
    assert.ok(reads.length <= 2);
    assert.equal(reads.includes(65536), !knownSize);
    await dem.destroy();
  }
});

test('WavDemuxer 非窗口不足的解析错误不触发扩容', async () => {
  const bytes = new Uint8Array(65536);
  let reads = 0;
  const source = { size: null, async read(offset, length) {
    reads += 1;
    return bytes.subarray(offset, offset + length);
  } };
  const dem = new WavDemuxer(source);
  await assert.rejects(() => dem.open(), (e) => e.code === 'PARSE_ERROR' && /RIFF/.test(e.message));
  assert.equal(reads, 1);
  await dem.destroy();
});

test('probe：null 入参走防御性 catch 返回 null，不抛异常', () => {
  assert.equal(WavDemuxer.probe(null), null);
});

test('getBufferedRanges：parseInit 前返回空区间', () => {
  const dem = new WavDemuxer(flakySource(buildWav(), 'ok'));
  assert.deepEqual(dem.getBufferedRanges(1), []);
});

test('seek：parseInit 前调用 → STATE_ERROR（缺头部）', async () => {
  const dem = new WavDemuxer(flakySource(buildWav(), 'ok'));
  await assert.rejects(
    () => dem.seek(1000),
    (e) => e.code === 'STATE_ERROR'
  );
});

test('seek：destroy 后调用 → STATE_ERROR（头部已有但状态 destroyed）', async () => {
  const dem = new WavDemuxer(flakySource(buildWav(), 'ok'));
  await dem.parseInit();
  await dem.destroy();
  await assert.rejects(
    () => dem.seek(1000),
    (e) => e.code === 'STATE_ERROR' && /destroyed/.test(e.message)
  );
});

test('samples 迭代中源读取抛错 → error 态 + error 事件（非 abort）', async () => {
  const dem = new WavDemuxer(flakySource(buildWav(8), 'throw'));
  await dem.parseInit();
  const errors = [];
  dem.on('error', (e) => errors.push(e));
  const it = dem.samples(1)[Symbol.asyncIterator]();
  await assert.rejects(() => it.next(), /io exploded/);
  assert.equal(dem.state, 'error');
  assert.equal(errors.length, 1, 'error 事件恰好一次');
});

test('samples 迭代中 abort → ABORTED 上抛，但不置 error 态、不进 error 事件面', async () => {
  const dem = new WavDemuxer(flakySource(buildWav(8), 'hang'));
  await dem.parseInit();
  const errors = [];
  dem.on('error', (e) => errors.push(e));
  const ctrl = new AbortController();
  const it = dem.samples(1, { signal: ctrl.signal })[Symbol.asyncIterator]();
  const pending = it.next();
  ctrl.abort();
  await assert.rejects(() => pending, (e) => e.code === 'ABORTED');
  assert.equal(dem.state, 'ready', 'abort 是调用方控制流，不得污染 error 态');
  assert.equal(errors.length, 0, 'abort 不进 error 事件面');
});

/* 登记不硬造（第二百零五波）：demuxer.js 202-204 _doSeek 的 catch 为防御性兜底——
 * try 体内（192-200）全部为普通数值运算与私有字段读取，#header 由 parseInit 产出
 * 纯数据对象，无公开注入点可令其抛错；stateValue 为普通属性赋值不触发基类迁移校验。
 * 该 catch 仅保障未来内部改动时状态一致性，单测不可达（先例同上）。 */
