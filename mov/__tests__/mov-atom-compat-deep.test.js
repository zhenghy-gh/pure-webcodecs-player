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

test('[D2 修复回归] looksLikeQuickTime：兼容品牌含 qt  但主品牌非 qt  时应识别为 true', () => {
  // 真实 QT 文件常以 isom/mp42 为主品牌、qt  列于兼容品牌列表；
  // 修复后兼容品牌列表中的精确 'qt  ' 也应命中（D2）。
  const ftyp = new Uint8Array(8 + 4 + 4 + 4 * 2);
  const dv = new DataView(ftyp.buffer);
  dv.setUint32(0, ftyp.byteLength);
  for (let i = 0; i < 4; i++) ftyp[4 + i] = 'ftyp'[i].charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[8 + i] = 'isom'[i].charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[12 + i] = 'isom'[i].charCodeAt(0);
  for (let i = 0; i < 4; i++) ftyp[16 + i] = 'qt  '[i].charCodeAt(0);
  assert.equal(looksLikeQuickTime(ftyp), true, 'D2：兼容品牌 qt  应被识别');
});

test('[D2 回归] 主品牌 mp42 + 兼容品牌含 qt  应识别为 true（buildFtyp 多兼容品牌）', () => {
  const ftyp = buildFtyp({ majorBrand: 'mp42', compatible: ['mp42', 'qt  ', 'isom'] });
  assert.equal(looksLikeQuickTime(ftyp), true, 'mp42 主品牌 + 兼容 qt  应命中');
  // 传入截断 head 仍应命中（兼容品牌列表边界按 ftyp size 安全裁剪）
  assert.equal(looksLikeQuickTime(ftyp.subarray(0, 64)), true, '截断 head 也应命中');
});

test('[D2 回归] 兼容品牌仅 qt6 （前缀相似）仍不算 qt  ，应返回 false', () => {
  const ftyp = buildFtyp({ majorBrand: 'isom', compatible: ['qt6 '] });
  assert.equal(looksLikeQuickTime(ftyp), false, 'qt6 不等于精确 "qt  "，避免前缀误判');
});

test('[D2 回归] probe：ftyp isom + 兼容 qt  应直接命中 mov 高置信 0.98', async () => {
  const ftyp = buildFtyp({ majorBrand: 'isom', compatible: ['isom', 'qt  '] });
  const head = ftyp.subarray(0, 64);
  const { MovDemuxer } = await import('../src/demuxer.js');
  const hit = MovDemuxer.probe(head);
  assert.ok(hit && hit.container === 'mov', '应路由到 mov 而非 mp4');
  assert.equal(hit.confidence, 0.98, '直接命中应为高置信 0.98');
});

test('[D2 边界] ftyp size=0（box 语义：延伸到输入末尾）且兼容品牌含 qt  应识别为 true', () => {
  // size 字段为 0，按 box-parser.js iterateBoxes 约定视为“到末尾”；
  // 此前 helper 会因 limit=0 漏扫兼容品牌列表，这是本次边界修复要点。
  const ftyp = new Uint8Array(8 + 4 + 4 + 4); // header + major + minor + 1 compatible
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom' major
  ftyp.set([0x00, 0x00, 0x02, 0x00], 12); // minor version
  ftyp.set([0x71, 0x74, 0x20, 0x20], 16); // 'qt  ' compatible
  // size 字段(0..3) 保持 0
  assert.equal(looksLikeQuickTime(ftyp), true, 'size=0 应视为延伸到末尾并扫描兼容品牌');
});

test('[D2 边界] 截断 head（声明 size > 实际长度）仍扫描可见兼容品牌，不漏扫', () => {
  // 声明 size=24 但仅提供 20 字节；兼容品牌 qt  位于可见的 [16..20)。
  const ftyp = new Uint8Array(20);
  const dv = new DataView(ftyp.buffer);
  dv.setUint32(0, 24); // 声明大于实际，模拟截断
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom' major
  ftyp.set([0x00, 0x00, 0x02, 0x00], 12); // minor version
  ftyp.set([0x71, 0x74, 0x20, 0x20], 16); // 'qt  ' compatible（在截断窗口内）
  assert.equal(looksLikeQuickTime(ftyp), true, '截断 head 中不因 size 大于实际长度而漏扫');
});

test('[D2 边界] 截断 head 末尾不足一个兼容品牌（<16B 或仅主品牌）应返回 false 不抛', () => {
  const short = new Uint8Array(12); // 仅 header + major，无任何兼容品牌空间
  const dv = new DataView(short.buffer);
  dv.setUint32(0, 24);
  short.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  short.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom' major
  assert.equal(looksLikeQuickTime(short), false, '空间不足时应安全返回 false');
});

void iterateBoxes;
