/**
 * mov 盒解析边界：largesize / 零 size / 非法 size / 容器递归 / fourcc 可读性。
 * 走 mov 模块转出口（iterateBoxes/parseMoov/parseTrak），不直接 import mp4 内部。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { iterateBoxes, parseMoov, parseTrak } from '../src/index.js';
import { box, buildMvhd, buildTkhd, buildMdhd, buildHdlr } from '../../mp4/src/box-builder.js';

function rawBox(type, body) {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function u32be(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function u64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

test('iterateBoxes：largesize（size=1 + u64）正确展开', () => {
  const body = u32be(0xdeadbeef);
  // 头 16 字节：size=1, 'free', u64 largesize=24
  const b = new Uint8Array(16 + body.length);
  new DataView(b.buffer).setUint32(0, 1);
  b.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
  b.set(u64be(16 + body.length), 8);
  b.set(body, 16);
  const seen = [];
  iterateBoxes(b, 0, b.byteLength, (h) => {
    seen.push({ type: h.type, size: h.size, headerSize: h.contentStart - h.start });
    return true;
  });
  assert.deepEqual(seen, [{ type: 'free', size: 20, headerSize: 16 }]);
});

test('iterateBoxes：size=0 表示延伸到扫描区间末尾', () => {
  const a = rawBox('free', [1, 2, 3]);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, 0);
  b.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
  const bytes = new Uint8Array([...a, ...b]);
  const seen = [];
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    seen.push({ type: h.type, size: h.size });
    return true;
  });
  assert.deepEqual(seen, [
    { type: 'free', size: 11 },
    { type: 'mdat', size: 8 }, // 零 size 吃掉剩余
  ]);
});

test('iterateBoxes：size<8 拒绝并抛 PARSE_ERROR', () => {
  const bad = new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // size=4
  assert.throws(
    () => iterateBoxes(bad, 0, bad.byteLength, () => true),
    (e) => e.code === 'PARSE_ERROR' && /invalid box size/.test(e.message),
  );
});

test('iterateBoxes：size 越出扫描区间拒绝', () => {
  const bad = new Uint8Array([0, 0, 1, 0, 0x66, 0x72, 0x65, 0x65]); // size=256 > 8
  assert.throws(
    () => iterateBoxes(bad, 0, bad.byteLength, () => true),
    (e) => e.code === 'PARSE_ERROR' && /invalid box size/.test(e.message),
  );
});

test('iterateBoxes：尾部全零 padding 容忍，非零截断拒绝', () => {
  const ok = new Uint8Array([...rawBox('free', []) , 0, 0, 0]);
  const seen = [];
  iterateBoxes(ok, 0, ok.byteLength, (h) => {
    seen.push(h.type);
    return true;
  });
  assert.deepEqual(seen, ['free']);

  const truncated = new Uint8Array([...rawBox('free', []), 1, 2, 3]);
  assert.throws(
    () => iterateBoxes(truncated, 0, truncated.byteLength, () => true),
    (e) => e.code === 'PARSE_ERROR' && /truncated box header/.test(e.message),
  );
});

test('iterateBoxes：visit 返回 false 提前终止', () => {
  const bytes = new Uint8Array([...rawBox('free', []), ...rawBox('skip', [])]);
  const seen = [];
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    seen.push(h.type);
    return false;
  });
  assert.deepEqual(seen, ['free']);
});

test('fourcc 可读性：非 ASCII 类型按 Latin-1 逐字节还原（©nam 类）', () => {
  const nam = new Uint8Array(12);
  new DataView(nam.buffer).setUint32(0, 12);
  nam.set([0xa9, 0x6e, 0x61, 0x6d], 4); // ©nam
  new DataView(nam.buffer).setUint16(8, 0);
  const seen = [];
  iterateBoxes(nam, 0, nam.byteLength, (h) => {
    seen.push(h.type);
    return true;
  });
  assert.equal(seen[0].charCodeAt(0), 0xa9);
  assert.equal(seen[0].slice(1), 'nam');
});

test('parseMoov：容器递归解析出 mvhd/trak 结构树', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 240, nextTrackId: 2 }));
    w.writeRaw(
      box('trak', (tw) => {
        tw.writeRaw(buildTkhd({ trackId: 1, duration: 240, isVideo: true, width: 64, height: 48 }));
        tw.writeRaw(
          box('mdia', (mw) => {
            mw.writeRaw(buildMdhd({ timescale: 600, duration: 240 }));
            mw.writeRaw(buildHdlr({ handlerType: 'vide', name: 'x' }));
          }),
        );
      }),
    );
  });
  const parsed = parseMoov(moov);
  assert.equal(parsed.mvhd.timescale, 600);
  assert.equal(parsed.mvhd.duration, 240);
  assert.equal(parsed.traks.length, 1);
  const trak = parsed.traks[0];
  assert.equal(trak.tkhd.trackId, 1);
  assert.equal(trak.tkhd.width, 64);
  assert.equal(trak.tkhd.height, 48);
  assert.equal(trak.mdhd.timescale, 600);
  assert.equal(trak.hdlr.handlerType, 'vide');
  // parseTrak 单独吃完整 trak box 也能得到一致结果
  const trakBox = box('trak', (tw) => {
    tw.writeRaw(buildTkhd({ trackId: 7, duration: 1 }));
    tw.writeRaw(
      box('mdia', (mw) => {
        mw.writeRaw(buildMdhd({ timescale: 30, duration: 3 }));
        mw.writeRaw(buildHdlr({ handlerType: 'soun', name: 'y' }));
      }),
    );
  });
  const solo = parseTrak(trakBox);
  assert.equal(solo.tkhd.trackId, 7);
  assert.equal(solo.hdlr.handlerType, 'soun');
});

test('parseMoov：缺少 mvhd 抛 PARSE_ERROR', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(buildTkhd({ trackId: 1, duration: 0 }));
  });
  assert.throws(
    () => parseMoov(moov),
    (e) => e.code === 'PARSE_ERROR' && /mvhd/.test(e.message),
  );
});

test('parseMoov：零 size moov（到 buffer 尾）与空 trak 均不崩', () => {
  // moov 头 size=0：按 buffer 尾处理
  const inner = new Uint8Array([...u32be(0).subarray(0, 0)]);
  void inner;
  const content = new Uint8Array([...buildMvhd({ timescale: 600, duration: 0, nextTrackId: 1 })]);
  const moov = new Uint8Array(8 + content.length);
  new DataView(moov.buffer).setUint32(0, 0); // size=0
  moov.set([0x6d, 0x6f, 0x6f, 0x76], 4);
  moov.set(content, 8);
  const parsed = parseMoov(moov);
  assert.equal(parsed.mvhd.timescale, 600);
  assert.deepEqual(parsed.traks, []);

  // 零长度 trak（无任何子盒）：trak 保持 null 字段骨架
  const withEmptyTrak = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 0, nextTrackId: 2 }));
    w.writeRaw(box('trak', () => {}));
  });
  const p2 = parseMoov(withEmptyTrak);
  assert.equal(p2.traks.length, 1);
  assert.equal(p2.traks[0].tkhd, null);
});

test('parseMoov：largesize moov 头被剥离', () => {
  const content = buildMvhd({ timescale: 600, duration: 240, nextTrackId: 1 });
  const b = new Uint8Array(16 + content.length);
  new DataView(b.buffer).setUint32(0, 1);
  b.set([0x6d, 0x6f, 0x6f, 0x76], 4);
  b.set(u64be(16 + content.length), 8);
  b.set(content, 16);
  const parsed = parseMoov(b);
  assert.equal(parsed.mvhd.timescale, 600);
});
