/**
 * ape/__tests__/ape-edge.test.js — MAC 头与 APE TAG 边界/容错补充单测（node --test）
 * ------------------------------------------------------------
 * 与 ape.test.js 互补，聚焦 qa 门槛要求的畸变与边界面：
 *   · MAC 魔数畸变容错（\xef\xbe\xad\xde 变体等）
 *   · descriptor 版本边界（3979/3980/3999…）字段布局差异
 *   · 时长换算 µs 边界（整秒精确 / 亚样本舍入 / 接近 u32 帧数上限）
 *   · APE 标签 footer 定位（最小标签、含 header 三段形态、前导 ID3v1 多种偏移）
 *   · item flags 位矩阵（utf8/binary/locator/reserved × readOnly）逐位断言
 *   · 封面 <mime>\0<data> 拆包 mime 矩阵与空封面容错
 *   · 标签 size/count 字段畸形容错、非 UTF8 字节不崩溃
 * fixture 全程序化内联生成，离线可测。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMacHeader,
  describeFormatFlags,
  findApeTag,
  tagValue,
  summarizeApe,
  probeApe,
} from '../src/index.js';

/* ============================================================
 * fixture 构造
 * ============================================================ */

/** 快捷字节数组 */
function u8(...bytes) {
  return Uint8Array.from(bytes);
}

/** 合成 APE_DESCRIPTOR 形态文件（版本 ≥3980，布局与 ape.test.js 一致） */
function buildDescriptorFile(opt = {}) {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, opt.version ?? 3990, true);
  dv.setUint32(6, 80, true);        // descriptorLen（示意值）
  dv.setUint32(10, 24, true);       // headerLen
  dv.setUint32(14, opt.seekTableLen ?? 0, true);
  dv.setUint32(18, 44, true);       // waveHeaderLen
  dv.setUint32(22, opt.audioLen ?? 100000, true);
  dv.setUint32(26, 0, true);
  // p=32 起 HEADER 24 字节
  let p = 32;
  dv.setUint16(p, opt.compression ?? 4001, true); p += 2;
  dv.setUint16(p, opt.flags ?? 0x02, true); p += 2;
  dv.setUint32(p, opt.blocksPerFrame ?? 73728, true); p += 4;
  dv.setUint32(p, opt.finalBlocks ?? 12345, true); p += 4;
  dv.setUint32(p, opt.totalFrames ?? 10, true); p += 4;
  dv.setUint16(p, opt.bps ?? 16, true); p += 2;
  dv.setUint16(p, opt.channels ?? 2, true); p += 2;
  dv.setUint32(p, opt.sampleRate ?? 44100, true);
  return b;
}

/** 合成 legacy 形态文件（版本 <3980，30B 旧头的前 16B 有效区） */
function buildLegacyFile(opt = {}) {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  for (const [i, ch] of ['M', 'A', 'C', ' '].entries()) b[i] = ch.charCodeAt(0);
  dv.setUint16(4, opt.version ?? 3950, true);
  dv.setUint16(6, opt.compression ?? 4000, true);
  dv.setUint16(8, opt.flags ?? 0x02, true);
  dv.setUint16(10, opt.channels ?? 2, true);
  dv.setUint32(12, opt.sampleRate ?? 44100, true);
  return b;
}

/** 单个 item 字节：valueLen(4le)+itemFlags(4le)+key(ascii\0)+value */
function buildItem(key, value, flags = 0) {
  const enc = new TextEncoder();
  const vb = typeof value === 'string' ? enc.encode(value) : value;
  const kb = enc.encode(key);
  const arr = new Uint8Array(8 + kb.length + 1 + vb.length);
  const dv = new DataView(arr.buffer);
  dv.setUint32(0, vb.length, true);
  dv.setUint32(4, flags >>> 0, true);
  arr.set(kb, 8);
  arr[8 + kb.length] = 0;
  arr.set(vb, 9 + kb.length);
  return arr;
}

/**
 * 组装标签字节。opt：
 *   version       写入 footer/header 的版本号（默认 2000）
 *   withHeader    生成 header+items+footer 三段形态
 *   sizeOverride  覆写 tagSize 字段（构造畸形用）
 *   countOverride 覆写 itemCount 字段（构造畸形用）
 * item 形如 { key, value, flags }
 */
function buildTag(items, opt = {}) {
  const { version = 2000, withHeader = false, sizeOverride, countOverride } = opt;
  const itemsBytes = concat(items.map((it) => buildItem(it.key, it.value, it.flags ?? 0)));
  const size = sizeOverride ?? itemsBytes.length + (withHeader ? 64 : 32);
  const count = countOverride ?? items.length;
  /** 32B footer/header：'APETAGEX'+version+size+count+flags+reserved(8×0) */
  const mk = (flags) => {
    const f = new Uint8Array(32);
    const dv = new DataView(f.buffer);
    for (const [i, ch] of [...'APETAGEX'].entries()) f[i] = ch.charCodeAt(0);
    dv.setUint32(8, version, true);
    dv.setUint32(12, size, true);
    dv.setUint32(16, count, true);
    dv.setUint32(20, flags, true);
    return f;
  };
  // header 置 contains-header|is-header 位，footer 仅置 contains-header 位
  return withHeader
    ? concat([mk(0xa0000000), itemsBytes, mk(0x80000000)])
    : concat([itemsBytes, mk(0)]);
}

/** 合成 ID3v1 尾巴：'TAG'+125 字节花纹 */
function buildId3v1() {
  const b = new Uint8Array(128);
  b[0] = 0x54; b[1] = 0x41; b[2] = 0x47;
  for (let i = 3; i < 128; i++) b[i] = (i * 7) & 0x7f;
  return b;
}

function concat(list) {
  const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

/* ============================================================
 * MAC 头畸变与版本边界
 * ============================================================ */

describe('MAC 头畸变与版本边界', () => {
  test('魔数逐字节畸变（\\xef\\xbe\\xad\\xde 变体）：probe 拒识、解析抛 PARSE_ERROR', () => {
    // 逐字节破坏 'MAC ' 四个魔数字节，均不得误判
    for (const pos of [0, 1, 2, 3]) {
      const bad = buildDescriptorFile();
      bad[pos] ^= 0xff;
      assert.equal(probeApe(bad), null, `字节 ${pos} 畸变后 probe 应拒识`);
      assert.throws(() => parseMacHeader(bad), (e) => e.code === 'PARSE_ERROR');
    }
    // 整段替换为 \xef\xbe\xad\xde（经典 marker 值）也不得命中
    const marker = buildDescriptorFile();
    marker.set(u8(0xef, 0xbe, 0xad, 0xde), 0);
    assert.equal(probeApe(marker), null);
    // 小写 'mac ' 同样不是合法魔数
    const lower = buildDescriptorFile();
    lower.set(new TextEncoder().encode('mac '), 0);
    assert.equal(probeApe(lower), null);
  });

  test('probeApe 长度边界：4/5 字节返回 null、6 字节即命中', () => {
    const head = buildDescriptorFile();
    assert.equal(probeApe(head.subarray(0, 4)), null); // 有魔数但 <6B
    assert.equal(probeApe(head.subarray(0, 5)), null);
    const hit = probeApe(head.subarray(0, 6));
    assert.ok(hit && hit.container === 'ape' && hit.confidence === 0.9);
    assert.deepEqual(hit.codecsHint, ['x-ape']);
  });

  test('过短/截断输入一律 PARSE_ERROR，不发生越界读取', () => {
    // 不足 8B 的 MAC 前缀
    assert.throws(() => parseMacHeader(buildDescriptorFile().subarray(0, 7)),
      (e) => e.code === 'PARSE_ERROR');
    // descriptor 形态在 56B 内截断
    assert.throws(() => parseMacHeader(buildDescriptorFile().subarray(0, 40)),
      (e) => e.code === 'PARSE_ERROR');
    // legacy 形态在 14B 内截断
    assert.throws(() => parseMacHeader(buildLegacyFile().subarray(0, 13)),
      (e) => e.code === 'PARSE_ERROR');
  });

  test('descriptor 版本边界：3979 走 legacy、3980/3999/65535 走 descriptor', () => {
    // 3979 是旧式头的最后一个版本：字段布局完全不同
    const old_ = parseMacHeader(buildLegacyFile({ version: 3979 }));
    assert.equal(old_.kind, 'legacy');
    assert.equal(old_.bitsPerSample, 16); // legacy 无 bps 字段，固定推断值
    assert.equal(old_.durationUs, null);
    assert.equal(old_.audioOffset, 14);
    // 3980 起为新布局
    for (const v of [3980, 3999, 65535]) {
      const info = parseMacHeader(buildDescriptorFile({ version: v }));
      assert.equal(info.kind, 'descriptor', `版本 ${v} 应为 descriptor`);
      assert.equal(info.version, v);
      assert.equal(info.audioOffset, 56); // 32B DESCRIPTOR + 24B HEADER
    }
  });

  test('legacy 块大小按版本与压缩码推导矩阵', () => {
    // ≥3900：73728 × 2^(code-4000)
    assert.equal(parseMacHeader(buildLegacyFile({ compression: 4000 })).blocksPerFrame, 73728);
    assert.equal(parseMacHeader(buildLegacyFile({ compression: 4001 })).blocksPerFrame, 147456);
    assert.equal(parseMacHeader(buildLegacyFile({ compression: 4002 })).blocksPerFrame, 294912);
    // <3900：固定 9216，与压缩码无关
    assert.equal(parseMacHeader(buildLegacyFile({ version: 3899, compression: 4000 })).blocksPerFrame, 9216);
    assert.equal(parseMacHeader(buildLegacyFile({ version: 3860, compression: 3000 })).blocksPerFrame, 9216);
  });

  test('legacy 极端压缩码容错：块大小保持有限非负、不崩溃', () => {
    // code 3000 使 2^(code-4000) 下溢为极小正数，实现须给出有限值而非 NaN/负数
    const info = parseMacHeader(buildLegacyFile({ version: 3950, compression: 3000 }));
    assert.equal(info.compressionLevel, 'insane');
    assert.ok(Number.isFinite(info.blocksPerFrame));
    assert.ok(info.blocksPerFrame >= 0);
  });

  test('descriptor 时长 µs 边界：整秒精确换算与亚样本四舍五入', () => {
    // 96000 样本 @48kHz = 整 2 秒，不得引入浮点误差
    const exact = parseMacHeader(buildDescriptorFile({
      sampleRate: 48000, blocksPerFrame: 48000, finalBlocks: 48000, totalFrames: 2,
    }));
    assert.equal(exact.durationUs, 2_000_000);
    // 44101 样本 @44100Hz：1e6×44101/44100 ≈ 1000022.68 → 四舍五入 1000023
    const round = parseMacHeader(buildDescriptorFile({
      sampleRate: 44100, blocksPerFrame: 73728, finalBlocks: 44101, totalFrames: 1,
    }));
    assert.equal(round.durationUs, 1_000_023);
  });

  test('接近 u32 上限的总帧数时长换算保持双精度精确', () => {
    // totalFrames=u32max、每帧 1 块：总样本 4294967295，仍在 2^53 安全区内
    const info = parseMacHeader(buildDescriptorFile({
      sampleRate: 48000, blocksPerFrame: 1, finalBlocks: 1, totalFrames: 4294967295,
    }));
    assert.equal(info.totalFrames, 4294967295);
    assert.equal(info.durationUs, 89_478_485_313); // Math.round(u32max/48000×1e6)
  });

  test('formatFlags 位矩阵逐位断言（直接调用 + 经解析路径）', () => {
    // 单个置位逐一验证（bit1 反相为 noWaveHeader）
    assert.deepEqual(describeFormatFlags(0x00), {
      hasSeekTableFirst: false, noWaveHeader: true, crc32PerFrame: false,
      highBitDepth24: false, hasPeakLevel: false,
    });
    assert.equal(describeFormatFlags(0x01).hasSeekTableFirst, true);
    assert.equal(describeFormatFlags(0x02).noWaveHeader, false);
    assert.equal(describeFormatFlags(0x04).crc32PerFrame, true);
    assert.equal(describeFormatFlags(0x08).highBitDepth24, true);
    assert.equal(describeFormatFlags(0x10).hasPeakLevel, true);
    // 全位置位：仅 noWaveHeader 因反相为 false
    assert.deepEqual(describeFormatFlags(0x1f), {
      hasSeekTableFirst: true, noWaveHeader: false, crc32PerFrame: true,
      highBitDepth24: true, hasPeakLevel: true,
    });
    // 经 parseMacHeader 的 descriptor 路径同样携带位分解结果（0x11 = bit0|bit4）
    const info = parseMacHeader(buildDescriptorFile({ flags: 0x11 }));
    assert.deepEqual(info.formatFlags, {
      hasSeekTableFirst: true, noWaveHeader: true, crc32PerFrame: false,
      highBitDepth24: false, hasPeakLevel: true,
    });
  });
});

/* ============================================================
 * APE 标签定位形态
 * ============================================================ */

describe('APE 标签定位形态', () => {
  test('最小合法标签：零 item、tagSize 恰为 32B', () => {
    const file = concat([buildDescriptorFile(), buildTag([])]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.version, 2000);
    assert.equal(tag.itemCount, 0);
    assert.deepEqual(tag.items, []);
  });

  test('含 header 三段形态：从尾部 footer 定位并完整解析 items', () => {
    const file = concat([buildDescriptorFile(), buildTag([
      { key: 'Title', value: '带头的曲目' },
      { key: 'Year', value: '2024' },
    ], { withHeader: true })]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.itemCount, 2);
    // 公开 API 恒从尾部 footer 定位，isHeader 保留字段为 false
    assert.equal(tag.isHeader, false);
    assert.equal(tagValue(tag, 'TITLE'), '带头的曲目');
    assert.equal(tagValue(tag, 'YEAR'), '2024');
  });

  test('APEv1（版本 1000）标签正常解析', () => {
    const file = concat([buildDescriptorFile(), buildTag(
      [{ key: 'Album', value: '老专辑' }], { version: 1000 },
    )]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.version, 1000);
    assert.equal(tagValue(tag, 'ALBUM'), '老专辑');
  });

  test('ID3v1 前导跳过：多种标签尺寸偏移均可定位', () => {
    const id3 = buildId3v1();
    // 偏移一：单条短文本项
    const f1 = concat([buildDescriptorFile(), buildTag([{ key: 'Title', value: '甲' }]), id3]);
    assert.equal(tagValue(findApeTag(f1), 'TITLE'), '甲');
    // 偏移二：多条混合项使标签区域显著变大
    const f2 = concat([buildDescriptorFile(), buildTag([
      { key: 'Title', value: '乙' },
      { key: 'Artist', value: '丙' },
      { key: 'Cover Art (front)', value: concat([new TextEncoder().encode('image/jpeg'), u8(1, 2)]), flags: 2 },
    ]), id3]);
    const t2 = findApeTag(f2);
    assert.equal(tagValue(t2, 'TITLE'), '乙');
    assert.equal(t2.items.filter((i) => i.type === 'binary').length, 1);
    // 偏移三：含 header 三段形态再接 ID3v1
    const f3 = concat([buildDescriptorFile(),
      buildTag([{ key: 'Title', value: '丁' }], { withHeader: true }), id3]);
    assert.equal(tagValue(findApeTag(f3), 'TITLE'), '丁');
  });

  test('仅有 ID3v1 / 过短的 TAG 尾：一律返回 null', () => {
    // descriptor + 纯 ID3v1，前面并无 APE footer
    const only = concat([buildDescriptorFile(), buildId3v1()]);
    assert.equal(findApeTag(only), null);
    // 文件总长 <160B 时即便尾部形似 'TAG' 也无法容纳前置标签
    assert.equal(findApeTag(buildId3v1()), null);
  });

  test('item 值内嵌 "TAG" 字节不影响尾部 footer 定位优先级', () => {
    // 二进制值以 'TAG'+花纹 开头，模拟与 ID3v1 特征冲突的数据
    const tricky = concat([new TextEncoder().encode('TAG'), u8(0, 1, 2, 3)]);
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Title', value: '正主' }, { key: 'Data', value: tricky, flags: 2 }])]);
    const tag = findApeTag(file);
    assert.equal(tagValue(tag, 'TITLE'), '正主');
    const bin = tag.items.find((i) => i.key === 'Data');
    assert.deepEqual([...bin.value], [...tricky]);
  });

  test('标签版本字段异常（999/1500）抛 PARSE_ERROR', () => {
    for (const v of [999, 1500]) {
      const file = concat([buildDescriptorFile(),
        buildTag([{ key: 'Title', value: 'x' }], { version: v })]);
      assert.throws(() => findApeTag(file), (e) => e.code === 'PARSE_ERROR', `版本 ${v}`);
    }
  });
});

/* ============================================================
 * item 解析与 flags 位矩阵
 * ============================================================ */

describe('item flags 位矩阵', () => {
  test('typeCode（bit1-2）位矩阵：utf8/binary/locator/reserved', () => {
    const file = concat([buildDescriptorFile(), buildTag([
      { key: 'K0', value: '文本', flags: 0x00 },           // 00 → utf8
      { key: 'K1', value: u8(1, 2), flags: 0x02 },         // 01 → binary
      { key: 'K2', value: u8(3), flags: 0x04 },            // 10 → locator（外链）
      { key: 'K3', value: u8(4), flags: 0x06 },            // 11 → reserved
    ])]);
    const tag = findApeTag(file);
    const byKey = Object.fromEntries(tag.items.map((i) => [i.key, i]));
    assert.equal(byKey.K0.type, 'utf8');
    assert.equal(byKey.K0.value, '文本');
    assert.equal(byKey.K1.type, 'binary');
    assert.ok(byKey.K1.value instanceof Uint8Array);
    assert.equal(byKey.K2.type, 'locator');
    assert.deepEqual([...byKey.K2.value], [3]); // locator 同样保留原始字节
    assert.equal(byKey.K3.type, 'reserved');
    for (const i of tag.items) assert.equal(i.readOnly, false);
  });

  test('readOnly（bit0）独立于类型位组合生效', () => {
    const file = concat([buildDescriptorFile(), buildTag([
      { key: 'R0', value: '只读文本', flags: 0x01 },       // ro + utf8
      { key: 'R1', value: u8(9), flags: 0x03 },            // ro + binary
      { key: 'R2', value: u8(8), flags: 0x05 },            // ro + locator
      { key: 'R3', value: u8(7), flags: 0x07 },            // ro + reserved
    ])]);
    const tag = findApeTag(file);
    const types = tag.items.map((i) => `${i.type}:${i.readOnly}`);
    assert.deepEqual(types, ['utf8:true', 'binary:true', 'locator:true', 'reserved:true']);
    assert.equal(tag.items[0].value, '只读文本'); // bit0 不影响类型判定
  });

  test('binary 项保留原始字节（含 \\0 与高位字节）不崩溃', () => {
    const raw = u8(0, 0xff, 0x7f, 0x80, 0x01, 0x00, 0xfe, 0x89, 0x50, 0x4e, 0x47);
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Bin', value: raw, flags: 0x02 }])]);
    const bin = findApeTag(file).items[0];
    assert.ok(bin.value instanceof Uint8Array);
    assert.deepEqual([...bin.value], [...raw]); // 逐字节保真，不做任何变换
  });

  test('utf8 项含非法 UTF-8 序列：替换符解码而非抛异常', () => {
    // 0xc3 后跟 ASCII、以及裸 0xff/0xfe 均为坏序列
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Broken', value: u8(0xc3, 0x28, 0xff, 0xfe), flags: 0x00 }])]);
    const item = findApeTag(file).items[0];
    assert.equal(typeof item.value, 'string');     // 不崩溃
    assert.ok(item.value.includes('\uFFFD'));      // 坏字节替换为 U+FFFD
  });

  test('key 首尾空白 trim；tagValue 大小写不敏感且只匹配 utf8 项', () => {
    const file = concat([buildDescriptorFile(), buildTag([
      { key: ' Artist ', value: '某人' },
      { key: 'title', value: u8(0xaa, 0xbb), flags: 2 }, // 同名 binary 项
    ])]);
    const tag = findApeTag(file);
    assert.equal(tag.items[0].key, 'Artist');
    assert.equal(tagValue(tag, 'artist'), '某人');   // 查询键任意大小写
    assert.equal(tagValue(tag, 'TITLE'), undefined); // binary 项不参与取值
  });
});

/* ============================================================
 * 标签尺寸与数量畸形容错
 * ============================================================ */

describe('标签尺寸与数量畸形容错', () => {
  test('tagSize=0：抛 PARSE_ERROR（尺寸字段非法）', () => {
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Title', value: 'x' }], { sizeOverride: 0 })]);
    assert.throws(() => findApeTag(file), (e) => e.code === 'PARSE_ERROR');
  });

  test('tagSize 超过文件长度（0xFFFFFFFF）：抛 PARSE_ERROR 不越界读', () => {
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Title', value: 'x' }], { sizeOverride: 0xffffffff })]);
    assert.throws(() => findApeTag(file), (e) => e.code === 'PARSE_ERROR');
  });

  test('声明 itemCount 虚高：按可用字节安全截停不崩溃', () => {
    // 实际只有 2 个 item 却声称 5 个：循环受 itemsEnd 约束安全终止
    const file = concat([buildDescriptorFile(), buildTag([
      { key: 'A', value: '1' }, { key: 'B', value: '2' },
    ], { countOverride: 5 })]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.itemCount, 5);   // 如实上报声明值
    assert.equal(tag.items.length, 2); // 但只解析真实存在的项
  });

  test('itemCount=0 但区域含杂散字节：忽略之，不解析任何项', () => {
    const file = concat([buildDescriptorFile(),
      buildTag([{ key: 'Ghost', value: '幽灵项' }], { countOverride: 0 })]);
    const tag = findApeTag(file);
    assert.ok(tag);
    assert.equal(tag.itemCount, 0);
    assert.deepEqual(tag.items, []);
  });
});

/* ============================================================
 * 封面拆包与汇总容错
 * ============================================================ */

describe('封面拆包与汇总容错', () => {
  test('mime 矩阵：jpeg/png/gif 全部正确拆包', () => {
    const mimes = ['image/jpeg', 'image/png', 'image/gif'];
    for (const [i, mime] of mimes.entries()) {
      const payload = u8(0xff, 0xd8 + i, i); // 各 mime 配不同图片字节
      const coverVal = concat([new TextEncoder().encode(mime), u8(0), payload]);
      const s = summarizeApe(concat([buildDescriptorFile(),
        buildTag([{ key: 'Cover Art (front)', value: coverVal, flags: 2 }])]));
      assert.equal(s.cover.mime, mime, mime);
      assert.deepEqual([...s.cover.data], [...payload]);
    }
  });

  test('空图片数据：mime 后紧跟 \\0 结束，data 为空数组', () => {
    const coverVal = concat([new TextEncoder().encode('image/gif'), u8(0)]);
    const s = summarizeApe(concat([buildDescriptorFile(),
      buildTag([{ key: 'Cover Art (front)', value: coverVal, flags: 2 }])]));
    assert.equal(s.cover.mime, 'image/gif');
    assert.equal(s.cover.data.length, 0);
  });

  test('封面容错：值中无 \\0 分隔或 \\0 在首位 → cover 为 null', () => {
    // 缺失分隔符：整段视为图片字节，无法确定 mime
    const noSep = concat([buildDescriptorFile(),
      buildTag([{ key: 'Cover Art (front)', value: u8(1, 2, 3), flags: 2 }])]);
    assert.equal(summarizeApe(noSep).cover, null);
    // \0 在首位意味着空 mime，同样放弃拆包
    const emptyMime = concat([buildDescriptorFile(),
      buildTag([{ key: 'Cover Art (front)', value: u8(0, 9, 9), flags: 2 }])]);
    assert.equal(summarizeApe(emptyMime).cover, null);
  });

  test('COVER ART 键大小写与 (back) 变体命中，非封面二进制键不误报', () => {
    const mkCover = () => concat([new TextEncoder().encode('image/png'), u8(0), u8(1)]);
    const upper = concat([buildDescriptorFile(),
      buildTag([{ key: 'COVER ART (FRONT)', value: mkCover(), flags: 2 }])]);
    assert.equal(summarizeApe(upper).cover.mime, 'image/png');
    const back = concat([buildDescriptorFile(),
      buildTag([{ key: 'Cover Art (back)', value: mkCover(), flags: 2 }])]);
    assert.ok(summarizeApe(back).cover);
    // 其它二进制项不应被当成封面
    const other = concat([buildDescriptorFile(),
      buildTag([{ key: 'Lyrics', value: mkCover(), flags: 2 }])]);
    assert.equal(summarizeApe(other).cover, null);
  });

  test('无标签文件的 summarize：info 正常而 tag/cover 为 null', () => {
    const d = summarizeApe(buildDescriptorFile());
    assert.equal(d.info.kind, 'descriptor');
    assert.equal(d.tag, null);
    assert.equal(d.cover, null);
    const l = summarizeApe(buildLegacyFile());
    assert.equal(l.info.kind, 'legacy');
    assert.equal(l.tag, null);
    assert.equal(l.cover, null);
  });
});
