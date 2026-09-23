/**
 * mov/atom 头部字段定向边界回归（第二百一十六波）
 * ------------------------------------------------------------
 * 定向 mutation 战线（213 wav/flac、214 mkv EBML 之后）推进到 QT 兼容层：
 * ftyp size 字段全边界 × 截断长度、cmov/dcom 位型、udta 文本 atom
 * strLen 全边界、interpretEdits 敌意形状/非有限值、probe 顶层 size 回绕。
 * 本波修复：interpretEdits（index.js 公开导出）定义域守卫——
 *   {} 无 entries / entries 非数组 / null 条目直接裸 TypeError，
 *   Infinity mediaTime ÷ 有限 timescale 泄漏非有限 firstMediaTimeSec，
 *   timescale=Infinity 过 >0 判定产出 NaN。合法解析路径逐位不变。
 * 契约基线：box 结构面敌意输入允许受控 PlayerError（带 code），禁裸
 * TypeError/RangeError；detectCompressedMoov/parseUdtaTags 内部捕获尽力而为。
 * 探测 .tmp/probe-mov-atom.mjs 680 调用后固化。
 * 全文件零 top-level await（--test-force-exit 静默丢例禁令，第二百零七波）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  looksLikeQuickTime, listTopLevelAtoms, detectCompressedMoov,
  parseUdtaTags, interpretEdits, isTimecodeHandler,
} from '../src/atom-compat.js';
import { MovDemuxer } from '../src/demuxer.js';

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
/** box size 字段 = 整盒长度（size4 + type4 + payload） */
const box = (type, payload = [], sizeOverride) => {
  const body = enc(type).concat(payload);
  return new Uint8Array(u32(sizeOverride ?? body.length + 4).concat(body));
};
const concat = (...bs) => {
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};
/** 受控调用：返回结果；受控错误（带 code）→ 'CTRL'；裸抛直接外溢炸测试 */
const ctrl = (fn) => {
  try { return fn(); } catch (e) {
    assert.ok(e.code, `裸抛 ${e.constructor.name}: ${String(e.message).slice(0, 60)}`);
    return 'CTRL';
  }
};

test('ftyp size 字段全边界 × 截断：looksLikeQuickTime 恒布尔，品牌判定不误杀', () => {
  for (const sz of [0, 1, 4, 7, 8, 11, 12, 15, 16, 17, 20, 24, 0x7fffffff, 0xffffffff]) {
    for (const major of ['qt  ', 'isom', '\u0000\u0000\u0000\u0000']) {
      const compat = concat(...['qt  ', 'avc1'].map((b) => new Uint8Array(enc(b))));
      const full = box('ftyp', enc(major).concat([0, 0, 0, 0]), sz);
      const withCompat = concat(full, compat);
      for (const cut of [0, 1, 3, 4, 7, 8, 12, 16, 20, 24, withCompat.length]) {
        assert.equal(
          typeof looksLikeQuickTime(withCompat.subarray(0, cut)), 'boolean',
          `sz=${sz} major=${JSON.stringify(major)} cut=${cut}`);
      }
    }
  }
  // 语义锚：主品牌 'qt  ' 恒命中；兼容品牌含 'qt  ' 命中；纯 isom 不命中
  assert.equal(looksLikeQuickTime(box('ftyp', enc('qt  ').concat([0, 0, 0, 0]))), true);
  assert.equal(looksLikeQuickTime(
    box('ftyp', enc('isom').concat([0, 0, 0, 0, ...enc('qt  ')]))), true);
  assert.equal(looksLikeQuickTime(box('ftyp', enc('isom').concat([0, 0, 0, 0]))), false);
  // wide/pnot 开头恒真；mdat 不真
  for (const t of ['wide', 'pnot']) {
    assert.equal(looksLikeQuickTime(box(t, [1, 2, 3, 4, 5, 6, 7, 8])), true, t);
  }
  assert.equal(looksLikeQuickTime(box('mdat', [1, 2, 3, 4, 5, 6, 7, 8])), false);
  // moov 开头 + 顶层尾随 wide → hasQuickTimeHints 命中（只扫顶层兄弟）
  assert.equal(looksLikeQuickTime(concat(
    box('moov', [0, 0, 0, 0, 0, 0, 0, 0]), box('wide', [1, 2, 3, 4]))), true);
  assert.equal(looksLikeQuickTime(box('moov', [0, 0, 0, 0, 0, 0, 0, 0])), false);
});

test('listTopLevelAtoms：size=0/越界/largesize 敌意序列恒字符串数组或受控错误', () => {
  const largesize = (type, big) => new Uint8Array(
    [0, 0, 0, 1, ...enc(type), 0, 0, 0, 0, 0, 0, 0, ...u32(big)]);
  const SEQ = [
    box('wide', [], 0),                                   // size=0 → 延伸到末尾
    box('skip', [1], 4),                                  // size<8 受控拒绝
    box('pnot', [1, 2], 0xffffffff),                      // size 越界
    box('wide', [1, 2, 3, 4]),                            // 恰等尾
    largesize('wide', 16),                                // largesize 恰等头
    concat(largesize('pnot', 2 ** 32), new Uint8Array(4)),// largesize 超末尾
  ];
  for (const b of SEQ) {
    const t = ctrl(() => listTopLevelAtoms(b));
    if (t !== 'CTRL') {
      assert.ok(Array.isArray(t));
      for (const x of t) assert.equal(typeof x, 'string');
    }
  }
  // 正例锚：常规序列保序输出
  assert.deepEqual(
    listTopLevelAtoms(concat(box('ftyp', enc('qt  ').concat([0, 0, 0, 0])),
      box('moov', [0, 0, 0, 0]), box('mdat', [9]))),
    ['ftyp', 'moov', 'mdat']);
});

test('detectCompressedMoov：cmov/dcom 位型返回形状不变，vendor 无控制字符', () => {
  const cases = [
    box('moov', Array.from(box('mvhd', [0, 0, 0, 0]))),
    box('moov', Array.from(box('cmov', Array.from(box('dcom', enc('zlib')))))),
    box('moov', Array.from(box('cmov', []))),
    box('moov', Array.from(box('cmov', Array.from(box('dcom', [1, 2]))))),  // dcom 截断
    box('moov', Array.from(box('cmov', Array.from(
      new Uint8Array([...u32(0xfffffff0), ...enc('dcom'), 1]))))),          // dcom size 越界
    box('moov', Array.from(new Uint8Array(
      [...u32(0), ...enc('cmov'), ...enc('dcom'), ...enc('zmms')]))),        // cmov size=0
    new Uint8Array(0), new Uint8Array([1, 2]),
  ];
  for (const bytes of cases) {
    const r = ctrl(() => detectCompressedMoov(bytes));
    if (r !== 'CTRL') {
      assert.equal(typeof r.compressed, 'boolean');
      if (r.vendor !== undefined) {
        assert.equal(typeof r.vendor, 'string');
        // 截断位型不得泄漏 \u0000 垃圾（fromCharCode(undefined) → '\0'）
        assert.ok(!/[\u0000-\u001f\u007f]/.test(r.vendor), `vendor=${JSON.stringify(r.vendor)}`);
      }
    }
  }
  // 语义锚：常规 cmov>dcom(zlib)
  assert.deepEqual(detectCompressedMoov(
    box('moov', Array.from(box('cmov', Array.from(box('dcom', enc('zlib'))))))),
    { compressed: true, vendor: 'zlib' });
});

test('parseUdtaTags：文本 atom strLen 全边界 + meta 双布局，值恒字符串', () => {
  const textAtom = (type, payload) => box(type, [0, payload.length, ...payload]);
  const nam = enc('Title');
  const udta = (children) =>
    box('udta', children.reduce((a, c) => a.concat(Array.from(c)), []));
  const suites = [
    udta([textAtom('©nam', nam)]),
    // QT 风格 meta（无 version/flags）与 ISO 风格 meta
    udta([box('meta', Array.from(concat(
      box('hdlr', enc('mdir____').concat([0, 0, 0, 0])), textAtom('©nam', nam))))]),
    udta([box('meta', [0, 0, 0, 0].concat(Array.from(concat(
      box('hdlr', enc('mdir____')), textAtom('©nam', nam)))))]),
    textAtom('©nam', nam.slice(0, 5)),  // strLen 恰满
    box('©nam', [0, 6, ...enc('abcde')]),  // strLen 超长 1 → 忽略
    box('©nam', [0, 0, ...enc('abc')]),    // strLen=0 → 忽略
    box('©nam', [0xff, 0xff, 1, 2]),       // strLen=65535 超载荷 → 忽略
    box('©nam', [1]),                      // 载荷仅 1B
    box('©nam', []),                       // 载荷空
    box('©nam', [0, 3, 0xff, 0xfe, 0xfd]), // 非法 UTF-8（非 fatal 解码不抛）
    udta([box('meta', [1, 2, 3])]),        // meta contentLen<8
    udta([new Uint8Array([...u32(0xffffff00), ...enc('©nam'), 0, 3, ...enc('x')])]),
  ];
  for (const raw of suites) {
    for (const bytes of [raw, box('moov', Array.from(raw))]) {
      const t = parseUdtaTags(bytes); // 内部双层 try/catch：禁裸抛
      assert.equal(typeof t, 'object');
      assert.ok(!Array.isArray(t));
      for (const [k, v] of Object.entries(t)) {
        assert.equal(typeof k, 'string');
        assert.equal(typeof v, 'string');
      }
    }
  }
  // 语义锚：合法 ©nam 解码出文本；超长 strLen 不产标签
  assert.equal(parseUdtaTags(udta([textAtom('©nam', nam)]))['©nam'], 'Title');
  assert.deepEqual(parseUdtaTags(box('©nam', [0, 6, ...enc('abcde')])), {});
  // 垃圾输入恒返回对象
  for (const g of [new Uint8Array(0), new Uint8Array([1]), new Uint8Array(3),
    new Uint8Array([255, 255, 255, 255, ...enc('moov')])]) {
    assert.equal(typeof parseUdtaTags(g), 'object');
  }
});

test('interpretEdits 定义域守卫（本波修复）：敌意形状不裸抛、非有限不泄漏', () => {
  const HOSTILE = [
    undefined, null, {}, { entries: 'x' }, { entries: '' }, { entries: [] },
    { entries: [null] },
    { entries: [{ mediaTime: NaN }] },
    { entries: [{ mediaTime: Infinity }] },
    { entries: [{ mediaTime: -Infinity }] },
    { entries: [{ mediaTime: '50' }] },        // 字符串不参与（严格数值域）
    { entries: [{ mediaTime: 2 ** 53 }] },
    { entries: [{ mediaTime: -5 }, null, { mediaTime: 3 }] },
  ];
  const TS = [undefined, null, NaN, 0, -1, 0.5, 1, 1000, 2 ** 53, Infinity, -Infinity];
  for (const e of HOSTILE) {
    for (const ts of TS) {
      const r = interpretEdits(e, ts);
      assert.equal(typeof r.hasEmptyEdit, 'boolean', `entries=${JSON.stringify(e)} ts=${ts}`);
      const f = r.firstMediaTimeSec;
      assert.ok(f === null || Number.isFinite(f), `firstMediaTimeSec=${f}`);
    }
  }
  // 语义锚（既有行为不变）：空编辑 + 首个非负起点换算秒
  const ok = interpretEdits(
    { entries: [{ mediaTime: -1 }, { mediaTime: 90000 }] }, 44100);
  assert.equal(ok.hasEmptyEdit, true);
  assert.equal(ok.firstMediaTimeSec, 90000 / 44100);
  // 全负 mediaTime → null 起点（既有 compat-edge 语义）
  const neg = interpretEdits({ entries: [{ mediaTime: -1 }, { mediaTime: -5 }] }, 600);
  assert.deepEqual(neg, { hasEmptyEdit: true, firstMediaTimeSec: null });
});

test('MovDemuxer.probe：顶层 size 敌意恒受控，qt 品牌命中/无特征让位语义不变', () => {
  const mkTop = (type, sizeOv) => concat(
    box(type, [1, 2, 3, 4], sizeOv), box('moov', Array.from(box('mvhd', [0, 0, 0, 0]))));
  for (const b of [
    mkTop('wide', 0), mkTop('wide', 5), mkTop('pnot', 0xffffffff),
    new Uint8Array(16),
    new Uint8Array([0xff, 0xff, 0xff, 0xfc, ...enc('wide'), 1]),
    box('ftyp', enc('isom').concat([0, 0, 0, 0])),
  ]) {
    const r = ctrl(() => MovDemuxer.probe(b));
    assert.ok(r === null || (typeof r.confidence === 'number'
      && r.confidence >= 0 && r.confidence <= 1), `confidence=${r?.confidence}`);
  }
  // 正例锚：主品牌 qt 高分命中
  const qt = MovDemuxer.probe(box('ftyp', enc('qt  ').concat([0, 0, 0, 0])));
  assert.ok(qt && qt.confidence >= 0.9 && qt.container === 'mov');
  assert.equal(isTimecodeHandler('tmcd'), true);
  assert.equal(isTimecodeHandler('vide'), false);
});

test('正例锚点：真实 quicktime.mov fixture 全链不抛', () => {
  const bytes = new Uint8Array(readFileSync(
    new URL('./fixtures/quicktime.mov', import.meta.url)));
  assert.equal(looksLikeQuickTime(bytes), true);
  assert.deepEqual(listTopLevelAtoms(bytes), ['ftyp', 'wide', 'moov', 'mdat']);
  const r = MovDemuxer.probe(bytes);
  assert.ok(r.confidence >= 0.9 && r.container === 'mov');
  assert.equal(detectCompressedMoov(bytes).compressed, false);
  const t = parseUdtaTags(bytes);
  for (const v of Object.values(t)) assert.equal(typeof v, 'string');
});
