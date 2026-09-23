/**
 * decodeFlacToPlayable 损坏帧重同步回归（第二百波）
 * ------------------------------------------------------------
 * 补齐 player.js 解码循环的 catch 重同步路径（此前从未执行）：
 *   - 尾部伪同步 + 垃圾：坏帧贡献 0 样本，结果与干净解码逐字节一致；
 *   - 帧中损坏（CRC-16 兜住）：丢当前帧、从下一好帧续解，样本位不虚增；
 *   - 帧头 CRC-8 非法阻断策略位：登记为结构性不可达（见文件尾注释）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFix } from './helpers.mjs';
import { decodeFlacToPlayable } from '../src/player.js';
import { parseMetadata } from '../src/metadata.js';
import { findSync } from '../src/frame-header.js';

/** 定位音频区内第 n 个帧同步位置（0 起） */
function nthSync(bytes, audioOffset, n) {
  let pos = audioOffset;
  for (let k = 0; k <= n; k++) {
    pos = findSync(bytes, pos);
    if (pos < 0) return -1;
    if (k < n) pos++; // 跳过当前同步再找下一个（帧体不含 14bit 伪同步时近似下一帧头）
  }
  return pos;
}

test('尾部伪同步垃圾帧：贡献 0 样本，与干净解码逐字节一致', async () => {
  const flac = await readFix('sample-basic.flac');
  const clean = decodeFlacToPlayable(flac);

  // 合法流之后追加「伪帧头 + 全零垃圾」：decodeFrame 必抛 → catch pos++ 重扫至耗尽
  const dirty = new Uint8Array(flac.length + 40);
  dirty.set(flac);
  dirty[flac.length] = 0xff;
  dirty[flac.length + 1] = 0xf8; // 帧同步 0x3FFE 前 14 位（阻断策略位=0，后续字段非法）

  const r = decodeFlacToPlayable(dirty);
  assert.equal(r.totalSamples, clean.totalSamples, '坏帧不计入样本位');
  assert.deepEqual([...r.wavBytes], [...clean.wavBytes], 'WAV 载荷不受尾部垃圾影响');
});

test('帧中数据损坏：CRC-16 拦截后从下一好帧续解，丢帧数可观察', async () => {
  const flac = await readFix('sample-basic.flac');
  const meta = parseMetadata(flac);
  const sync0 = nthSync(flac, meta.audioOffset, 0);
  const sync1 = nthSync(flac, meta.audioOffset, 1);
  assert.ok(sync0 >= 0 && sync1 > sync0, 'fixture 至少两帧才可验证续解');

  const corrupted = new Uint8Array(flac); // 注意：readFix 返回 Buffer，Buffer#slice 是视图不拷贝
  // 破坏第一帧帧体（避开帧头与前两字节，防止翻转出伪同步；此处命中帧尾 CRC-16 区）
  corrupted[sync1 - 2] ^= 0x55;

  const clean = decodeFlacToPlayable(flac);
  const r = decodeFlacToPlayable(corrupted);
  const frameSamples = clean.totalSamples / 2; // 两帧等长（16×2）
  assert.equal(r.totalSamples, clean.totalSamples - frameSamples, '仅丢被损坏的第一帧');
});

test('尾部半帧（声明长度内数据不足）：不抛错，完整帧照常交付', async () => {
  const flac = await readFix('sample-basic.flac');
  const meta = parseMetadata(flac);
  const syncLast = nthSync(flac, meta.audioOffset, 1);
  assert.ok(syncLast > meta.audioOffset);

  // 裁掉最后一帧的大半帧体 → 伪残留触发重同步失败或直接越界，均不得抛错
  const truncated = flac.slice(0, syncLast + 4);
  const r = decodeFlacToPlayable(truncated);
  const clean = decodeFlacToPlayable(flac);
  assert.equal(r.totalSamples, clean.totalSamples - clean.totalSamples / 2, '仅完整首帧交付');
});

/* 登记不硬造：frame-header.js:56-57「阻断策略非法」守卫结构性不可达——
 * blockingStrategy 由 1 bit 读出（0=FIXED、1=VARIABLE 均合法），永不命中 else；
 * 与 RFC 9639「2 bit 阻断策略」的差异系建帧侧以 FIXED 位长落笔，
 * 收紧会改变现有解析行为，维持现状登记（先例：tag-stream 128MB 守卫）。 */
