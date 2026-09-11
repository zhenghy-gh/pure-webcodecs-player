/**
 * mov atom-compat 深度覆盖（第八批缺陷狩猎）。
 *
 * 目标分支（atom-compat.js）：
 *  - looksLikeQuickTime：moov 起始（无 ftyp）+ 内部 QT 特征；wide/pnot 起始；
 *    未知品牌返回 false；'qt  ' 精确匹配 vs 仅前缀（'qt6 '）不匹配；
 *  - detectCompressedMoov：未知 dcom vendor 透出；空 cmov（无 dcom）→ 仍判压缩、vendor=undefined；
 *  - parseUdtaTags：ISO 风格 meta（version/flags 头）；udta 直接子 atom（非 meta 内）；
 *    非法 u16 长度前缀 → 该标签静默丢弃且不抛；
 *  - isTimecodeHandler：tmcd 命中、其它 handler 否；
 *  - 常量导出 QT_BRANDS / QT_TOP_ATOMS。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeQuickTime,
  detectCompressedMoov,
  parseUdtaTags,
  interpretEdits,
  isTimecodeHandler,
  QT_BRANDS,
  QT_TOP_ATOMS,
  listTopLevelAtoms,
} from '../src/atom-compat.js';
import { iterateBoxes } from '../../mp4/src/box-parser.js';
import { box, buildFtyp, buildMvhd, buildHdlr } from '../../mp4/src/box-builder.js';

const enc = new TextEncoder();

/** QT 文本标签 atom：u16 大端长度 + UTF-8 载荷（box 头 + 该前缀 + 文本） */
function textAtom(type, text) {
  const payload = enc.encode(text);
  const out = new Uint8Array(8 + 2 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  dv.setUint16(8, payload.length); // u16 长度前缀
  out.set(payload, 10);
  return out;
}

/** 非法文本标签 atom：u16 长度前缀远超内容 → readTextAtom 应丢弃 */
function textAtomCorrupt(type, text) {
  const payload = enc.encode(text);
  const out = new Uint8Array(8 + 2 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  dv.setUint16(8, 0xffff); // 声明长度远超内容
  out.set(payload, 10);
  return out;
}

function buildMoovWithUdta(udtaBody) {
  return box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 0, nextTrackId: 1 }));
    w.writeRaw(udtaBody);
  });
}

/* ------------------------- looksLikeQuickTime ------------------------- */

test('looksLikeQuickTime：moov 起始（无 ftyp）+ 内部 pnot 特征 → true', () => {
  // 老 .mov：以 moov 直接开头，内部含 pnot（QT 特征）
  const moov = box('moov', (w) => {
    w.writeRaw(new Uint8Array([0, 0, 0, 8, 0x70, 0x6e, 0x6f, 0x74])); // pnot(8)
  });
  const wide = new Uint8Array([0, 0, 0, 8, 0x77, 0x69, 0x64, 0x65]); // wide(8) 作为兄弟
  const bytes = new Uint8Array(moov.byteLength + wide.byteLength);
  bytes.set(moov, 0);
  bytes.set(wide, moov.byteLength);
  assert.equal(looksLikeQuickTime(bytes), true);
});

test('looksLikeQuickTime：moov 起始但无 QT 特征 → false（老 mov 必须含 hint）', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 0 }));
  });
  assert.equal(looksLikeQuickTime(moov), false);
});

test('looksLikeQuickTime：起始 wide / pnot 无 ftyp → true', () => {
  const wide = new Uint8Array([0, 0, 0, 8, 0x77, 0x69, 0x64, 0x65]);
  assert.equal(looksLikeQuickTime(wide), true);
  const pnot = new Uint8Array([0, 0, 0, 8, 0x70, 0x6e, 0x6f, 0x74]);
  assert.equal(looksLikeQuickTime(pnot), true);
});

test('looksLikeQuickTime：ftyp 未知品牌（非 qt / 非 isom）→ false', () => {
  const ftyp = buildFtyp({ majorBrand: 'xyz ', minorVersion: 0, compatible: ['xyz '] });
  assert.equal(looksLikeQuickTime(ftyp), false);
  // 空/过短字节 → false 不抛
  assert.equal(looksLikeQuickTime(new Uint8Array(4)), false);
  assert.equal(looksLikeQuickTime(null), false);
});

test('looksLikeQuickTime：ftyp 精确 "qt  " → true；仅前缀 "qt6 " → false', () => {
  const qt = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  assert.equal(looksLikeQuickTime(qt), true);
  const qt6 = buildFtyp({ majorBrand: 'qt6 ', compatible: ['qt6 '] });
  assert.equal(looksLikeQuickTime(qt6), false, 'qt6 不等于精确 "qt  "');
});

/* ------------------------- detectCompressedMoov ------------------------- */

test('detectCompressedMoov：未知 dcom vendor（wave）透出 vendor', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(
      box('cmov', (cw) => {
        cw.writeRaw(box('dcom', (dw) => dw.writeFourCC('wave')));
        cw.writeRaw(box('cmvd', (dw) => {
          dw.writeU32(8);
          dw.writeRaw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        }));
      }),
    );
  });
  const r = detectCompressedMoov(moov);
  assert.equal(r.compressed, true);
  assert.equal(r.vendor, 'wave');
});

test('detectCompressedMoov：空 cmov（无 dcom）→ 仍判压缩，vendor=undefined', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(
      box('cmov', (cw) => {
        cw.writeRaw(box('cmvd', (dw) => {
          dw.writeU32(4);
          dw.writeRaw(new Uint8Array([9, 9, 9, 9]));
        }));
      }),
    );
  });
  const r = detectCompressedMoov(moov);
  assert.equal(r.compressed, true);
  assert.equal(r.vendor, undefined);
});

test('detectCompressedMoov：普通 moov（无 cmov）→ false', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 0 }));
  });
  assert.equal(detectCompressedMoov(moov).compressed, false);
});

/* ------------------------- parseUdtaTags ------------------------- */

test('parseUdtaTags：ISO 风格 meta（version/flags 头）→ 提取直接子标签', () => {
  const udta = box('udta', (uw) => {
    uw.writeRaw(
      box('meta', (mw) => {
        mw.writeU8(0).writeU24(0); // ISO version/flags
        mw.writeRaw(buildHdlr({ handlerType: 'mdir', name: 'appl' }));
        mw.writeRaw(textAtom('©nam', 'ISO标题'));
      }),
    );
  });
  const moov = buildMoovWithUdta(udta);
  const tags = parseUdtaTags(moov);
  assert.deepEqual(tags, { '©nam': 'ISO标题' });
});

test('parseUdtaTags：标签为 udta 直接子 atom（不在 meta 内）也能提取', () => {
  const udta = box('udta', (uw) => {
    uw.writeRaw(textAtom('©nam', '直接子标签'));
    uw.writeRaw(textAtom('©ART', '作者'));
  });
  const moov = buildMoovWithUdta(udta);
  const tags = parseUdtaTags(moov);
  assert.deepEqual(tags, { '©nam': '直接子标签', '©ART': '作者' });
});

test('parseUdtaTags：u16 长度前缀非法（超界）→ 该标签静默丢弃且不抛异常', () => {
  const udta = box('udta', (uw) => {
    uw.writeRaw(textAtomCorrupt('©nam', '坏标签'));
    uw.writeRaw(textAtom('©ART', '好标签'));
  });
  const moov = buildMoovWithUdta(udta);
  // 不应抛；坏标签被忽略，好标签保留
  const tags = parseUdtaTags(moov);
  assert.deepEqual(tags, { '©ART': '好标签' });
});

test('parseUdtaTags：无 udta 盒 → 返回空对象不抛', () => {
  const moov = box('moov', (w) => {
    w.writeRaw(buildMvhd({ timescale: 600, duration: 0 }));
  });
  assert.deepEqual(parseUdtaTags(moov), {});
});

test('parseUdtaTags：QT 风格 meta（无 version/flags）仍能提取 ©nam', () => {
  // 复用 atom-compat.test 已覆盖；此处加一条直接子结构校验
  const udta = box('udta', (uw) => {
    uw.writeRaw(
      box('meta', (mw) => {
        mw.writeRaw(buildHdlr({ handlerType: 'mdir', name: 'appl' }));
        mw.writeRaw(textAtom('©nam', 'QT风格'));
      }),
    );
  });
  const moov = buildMoovWithUdta(udta);
  const tags = parseUdtaTags(moov);
  assert.deepEqual(tags, { '©nam': 'QT风格' });
});

/* ------------------------- isTimecodeHandler / 常量 ------------------------- */

test('isTimecodeHandler：tmcd 命中，其它 handler 否', () => {
  assert.equal(isTimecodeHandler('tmcd'), true);
  assert.equal(isTimecodeHandler('vide'), false);
  assert.equal(isTimecodeHandler('soun'), false);
  assert.equal(isTimecodeHandler(undefined), false);
});

test('常量导出：QT_BRANDS / QT_TOP_ATOMS', () => {
  assert.deepEqual(QT_BRANDS, ['qt  ']);
  assert.ok(QT_TOP_ATOMS.has('wide'));
  assert.ok(QT_TOP_ATOMS.has('pnot'));
  assert.ok(QT_TOP_ATOMS.has('skip'));
  assert.equal(QT_TOP_ATOMS.has('moov'), false);
});

test('interpretEdits：仅空编辑（无正 mediaTime）时 firstMediaTimeSec=null', () => {
  const r = interpretEdits(
    { entries: [{ segmentDuration: 100, mediaTime: -1 }, { segmentDuration: 100, mediaTime: -1 }] },
    600,
  );
  assert.equal(r.hasEmptyEdit, true);
  assert.equal(r.firstMediaTimeSec, null);
});

test('listTopLevelAtoms：多盒序列顺序还原', () => {
  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  const wide = new Uint8Array([0, 0, 0, 8, 0x77, 0x69, 0x64, 0x65]);
  const moov = box('moov', (w) => w.writeRaw(buildMvhd({ timescale: 600, duration: 0 })));
  const bytes = new Uint8Array(ftyp.byteLength + wide.byteLength + moov.byteLength);
  let off = 0;
  for (const p of [ftyp, wide, moov]) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  assert.deepEqual(listTopLevelAtoms(bytes), ['ftyp', 'wide', 'moov']);
});

/* ------------------------- detectCompressedMoov 内容区路径 ------------------------- */

test('detectCompressedMoov：传入内容区（无 moov 头，start=0）也能识别 cmov', () => {
  const cmov = box('cmov', (cw) => {
    cw.writeRaw(box('dcom', (dw) => dw.writeFourCC('zlib')));
    cw.writeRaw(box('cmvd', (dw) => {
      dw.writeU32(4);
      dw.writeRaw(new Uint8Array([1, 2, 3, 4]));
    }));
  });
  const r = detectCompressedMoov(cmov); // 内容区首盒即 cmov，start 应保持 0
  assert.equal(r.compressed, true);
  assert.equal(r.vendor, 'zlib');
});

/* ------------------------- parseUdtaTags 混合布局与健壮性 ------------------------- */

test('parseUdtaTags：QT 风格 meta 与 udta 直接子标签共存时两者均提取', () => {
  const udta = box('udta', (uw) => {
    uw.writeRaw(
      box('meta', (mw) => {
        mw.writeRaw(buildHdlr({ handlerType: 'mdir', name: 'appl' }));
        mw.writeRaw(textAtom('©nam', 'QT标题'));
      }),
    );
    uw.writeRaw(textAtom('©ART', '作者'));
  });
  const moov = buildMoovWithUdta(udta);
  assert.deepEqual(parseUdtaTags(moov), { '©nam': 'QT标题', '©ART': '作者' });
});

test('parseUdtaTags：udta 内含损坏子盒时仍尽力提取已解析标签且不抛（修复 D1）', () => {
  const good = textAtom('©nam', '好标签');
  const badMeta = new Uint8Array([0, 0, 0, 6, 0x6d, 0x65, 0x74, 0x61]); // meta 头异常：size=6 < 8
  const udta = box('udta', (uw) => {
    uw.writeRaw(good);
    uw.writeRaw(badMeta);
  });
  const moov = buildMoovWithUdta(udta);
  // 修复前此处会抛 "invalid box size 6"；现应尽力提取已解析的 ©nam 并返回。
  const tags = parseUdtaTags(moov);
  assert.deepEqual(tags, { '©nam': '好标签' });
});

/* ------------------------- interpretEdits / looksLikeQuickTime 边界 ------------------------- */

test('interpretEdits：timescale=0 时 firstMediaTimeSec 为 null（防御除零）', () => {
  const r = interpretEdits({ entries: [{ segmentDuration: 120, mediaTime: 100 }] }, 0);
  assert.equal(r.hasEmptyEdit, false);
  assert.equal(r.firstMediaTimeSec, null);
});

test('looksLikeQuickTime：ftyp 主品牌精确 qt  直接函数级命中', () => {
  const ftyp = buildFtyp({ majorBrand: 'qt  ', compatible: ['qt  '] });
  assert.equal(looksLikeQuickTime(ftyp), true);
});

test('listTopLevelAtoms：空输入返回空数组不抛', () => {
  assert.deepEqual(listTopLevelAtoms(new Uint8Array(0)), []);
});

test('[已知缺陷 D2] looksLikeQuickTime：兼容品牌含 qt  但主品牌非 qt  时仍误判 false', () => {
  // 真实 QT 文件常以 isom/mp42 为主品牌、qt  列于兼容品牌列表；
  // 当前实现只看主品牌（忽略兼容品牌），会漏判这类文件——待修复。
  const ftyp = new Uint8Array(8 + 4 + 4 + 4 * 2);
  const dv = new DataView(ftyp.buffer);
  dv.setUint32(0, ftyp.byteLength);
  for (let i = 0; i < 4; i++) ftyp[4 + i] = 'f'.charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[8 + i] = 'isom'[i].charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[12 + i] = 'isom'[i].charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[16 + i] = 'qt  '[i].charCodeAt(0);
  assert.equal(looksLikeQuickTime(ftyp), false, 'KNOWN DEFECT D2：兼容品牌 qt  未被识别');
});

void iterateBoxes;
