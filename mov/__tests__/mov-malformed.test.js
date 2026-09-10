/**
 * 畸形输入与错误分支：顶层扫描截断/非法 size、缺 moov、moov 上界、
 * 样本越界、probe/createDemuxer 拒绝路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MovDemuxer, probe as movProbe } from '../src/index.js';
import { createDemuxer } from '../src/index.js';
import { MemoryDataSource } from '../../core/src/index.js';
import { buildQuickTimeMovFixture, buildCompressedMovFixture } from './fixtures.js';

function u32be(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function rawBox(type, body) {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

test('顶层扫描：尾部截断的 box 头（<8 字节且非全零）→ PARSE_ERROR', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  // 砍掉 mdat 的最后 4 字节：顶层剩 4 字节残头（mdat 载荷非零）
  const truncated = bytes.subarray(0, bytes.byteLength - 4);
  // 但 moov 声称的 mdat size 越界 → 扫描期即报 invalid size
  const d = new MovDemuxer(new MemoryDataSource(new Uint8Array(truncated)));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /invalid top-level box|truncated box header/.test(e.message),
  );
});

test('顶层扫描：size<8 的顶层盒 → PARSE_ERROR', async () => {
  const ftyp = rawBox('ftyp', [...u32be(0x71_74_20_20)]); // 'qt  '
  const bad = new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // size=4 'free'
  const bytes = new Uint8Array([...ftyp, ...bad]);
  const d = new MovDemuxer(new MemoryDataSource(bytes));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /size=4/.test(e.message),
  );
});

test('无 moov（仅 ftyp+mdat）→ "moov atom not found"', async () => {
  const ftyp = rawBox('ftyp', [...u32be(0x71_74_20_20)]);
  const mdat = rawBox('mdat', [1, 2, 3, 4]);
  const d = new MovDemuxer(new MemoryDataSource(new Uint8Array([...ftyp, ...mdat])));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /moov atom not found/.test(e.message),
  );
});

test('moov 缺 mvhd → "moov missing mvhd"', async () => {
  // 只有 tkhd 的空 moov：独立于 fixture 走 mp4 解析路径
  const { box, buildTkhd, buildMvhd } = await import('../../mp4/src/box-builder.js');
  const moov = box('moov', (w) => {
    w.writeRaw(buildTkhd({ trackId: 1, duration: 0 }));
  });
  const ftyp = rawBox('ftyp', [...u32be(0x71_74_20_20)]);
  const d = new MovDemuxer(new MemoryDataSource(new Uint8Array([...ftyp, ...new Uint8Array(moov)])));
  void buildMvhd;
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /mvhd/.test(e.message),
  );
});

test('moov 超过 maxMoovBytes 上界 → PARSE_ERROR（I5 防护）', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  const d = new MovDemuxer(new MemoryDataSource(bytes), { maxMoovBytes: 32 });
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /上限/.test(e.message),
  );
});

test('样本 offset 指向文件外 → 迭代时 SOURCE_ERROR', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  // 定位 moov 中 stco 并把首个 chunk offset 改成文件末尾之外
  const bad = new Uint8Array(bytes);
  let stcoAt = bad.indexOf(0x73, 0);
  while (stcoAt !== -1 && !(bad[stcoAt + 1] === 0x74 && bad[stcoAt + 2] === 0x63 && bad[stcoAt + 3] === 0x6f)) {
    stcoAt = bad.indexOf(0x73, stcoAt + 1);
  }
  assert.ok(stcoAt > 0, '找到 stco');
  // stco 头 8 + version/flags 4 + entryCount 4 → 第一个 offset
  const dv = new DataView(bad.buffer);
  dv.setUint32(stcoAt + 16, bytes.byteLength + 9999);
  const d = new MovDemuxer(new MemoryDataSource(bad));
  await d.open();
  await assert.rejects(
    async () => {
      for await (const s of d.samples(1)) void s;
    },
    (e) => e.code === 'SOURCE_ERROR' && /out of range/.test(e.message),
  );
});

test('probe：空/短字节、垃圾字节返回 null 不抛异常', () => {
  assert.equal(movProbe(new Uint8Array(0)), null);
  assert.equal(movProbe(new Uint8Array([0, 0, 0])), null);
  assert.equal(movProbe(null), null);
  const junk = new Uint8Array(64);
  for (let i = 0; i < 64; i++) junk[i] = (i * 53 + 3) & 0xff;
  assert.equal(movProbe(junk), null);
});

test('createDemuxer：无法识别的数据源 reject PROBE_FAILED', async () => {
  const junk = new Uint8Array(64);
  for (let i = 0; i < 64; i++) junk[i] = (i * 91 + 5) & 0xff;
  await assert.rejects(
    () => createDemuxer(junk),
    (e) => e.code === 'PROBE_FAILED' && /mov/.test(e.message),
  );
});

test('createDemuxer：Uint8Array 直入并完成 open', async () => {
  const { bytes } = buildQuickTimeMovFixture();
  const d = await createDemuxer(bytes);
  assert.equal(d.mediaInfo.container, 'mov');
  await d.destroy();
});

test('moov 后直接截断（moov 声称长度超出文件）→ 顶层扫描拒绝', async () => {
  const { bytes } = buildCompressedMovFixture();
  const cut = bytes.subarray(0, bytes.byteLength - 6); // moov 残缺
  const d = new MovDemuxer(new MemoryDataSource(new Uint8Array(cut)));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'PARSE_ERROR' && /invalid top-level box|truncated/.test(e.message),
  );
});
