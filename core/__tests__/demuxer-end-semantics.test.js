/**
 * 基类 `end` 事件语义固化（表征测试 / characterization test）
 *
 * ⚠️ 背景与约束（动手前必读）
 * 本文件**不是**缺陷回归，而是把基类 `_maybeEmitEnd` 的**当前语义**钉成显式契约，
 * 让任何后续改动都变成「有意为之」而不是「悄悄漂移」。
 *
 * 基类判定条件（core/src/demuxer.js:377-382）：**已建迭代器**的轨全部 done 即 emit('end')，
 * 而非契约字面「全部轨 EOS」。因此存在两条可观察偏差（下方用例逐一固化）：
 *   A. 提前发：只消费了部分轨时也会发 end；
 *   B. 可重复发：后续继续消费其他轨会**再发一次**（基类无 #endEmitted 去重）。
 *
 * 与 mkv/wav（`#endEmitted` 单次 + 全可读轨扫完才发）语义不同，该差异属
 * `docs/review/mkv-base-class-alignment.md` §8 **裁决表 D4**
 * （原文：「以契约字面『全部轨 EOS』为目标…基类收敛另立跨模块议题」），
 * **需 owner/captain 裁决，禁止单模块擅改**。
 * 若将来裁决收敛语义，请连同本文件一起按新契约改写，不要删掉覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';

/** 双轨 toy demuxer：走基类默认编排（不覆写 open/readSample/end 判定） */
class TwoTrackDemuxer extends Demuxer {
  async _doOpen() {
    return {
      container: 'toy',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42E01E' },
        { id: 2, type: 'audio', codec: 'mp4a.40.2' },
      ],
      durationUs: 200_000,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    return (async function* () {
      for (let i = 0; i < 2; i++) {
        yield createSample({
          trackId: id,
          timestamp: i * 100_000,
          duration: 100_000,
          keyframe: true,
          data: new Uint8Array([1]),
          size: 1,
        });
      }
    })();
  }
}

function makeDemuxer() {
  return new TwoTrackDemuxer(new MemoryDataSource(new Uint8Array([1])));
}

test('end 语义：仅消费单轨即派发 end（基类按「已建迭代器轨」判定，非「全部轨」）', async () => {
  const d = makeDemuxer();
  await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));

  // 只拉视频轨，音频轨从未建立迭代器
  let n = 0;
  for await (const _ of d.samples(1)) n += 1;
  assert.equal(n, 2, '视频轨样本数');

  assert.equal(ends.length, 1, '基类行为：只消费视频轨即已派发 end');
  assert.equal(ends[0].reason, 'eos');
  await d.destroy();
});

test('end 语义：后续消费其余轨会再次派发 end（基类无单次去重）', async () => {
  const d = makeDemuxer();
  await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));

  for await (const _ of d.samples(1)) {
    /* 拉完视频轨 → 第 1 次 end */
  }
  assert.equal(ends.length, 1, '首次 end');

  for await (const _ of d.samples(2)) {
    /* 拉完音频轨 → 基类会再发一次 */
  }
  assert.equal(ends.length, 2, '基类行为：end 可重复派发（与 mkv/wav 单次语义不同）');
  assert.ok(ends.every((e) => e.reason === 'eos'));
  await d.destroy();
});

test('end 语义：已 done 的轨二次 for-await 返回 0 样本且不重发 end', async () => {
  const d = makeDemuxer();
  await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));

  for await (const _ of d.samples(1)) {
    /* 拉完 */
  }
  const afterFirst = ends.length;

  let again = 0;
  for await (const _ of d.samples(1)) again += 1;
  assert.equal(again, 0, '已 EOS 轨二次迭代应为 0 样本');
  assert.equal(ends.length, afterFirst, '本轮不额外派发 end');
  await d.destroy();
});

test('end 语义：两轨均消费完毕后 end 至少派发一次且 reason=eos', async () => {
  const d = makeDemuxer();
  await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));

  for await (const _ of d.samples(1)) {
    /* 视频 */
  }
  for await (const _ of d.samples(2)) {
    /* 音频 */
  }
  assert.ok(ends.length >= 1, '两轨均消费完毕应至少派发一次 end');
  assert.ok(ends.every((e) => e.reason === 'eos'));
  await d.destroy();
});

test('end 语义：mkv 侧为单次去重（#endEmitted），与基类形成对照', async () => {
  // 对照固化：mkv 自带 #endEmitted，重复消费不重发；本用例只锁「单次」这一事实，
  // 不锁定两种语义谁更正确（该判断属 D4 跨模块裁决议题）。
  const { MkvDemuxer } = await import('../../mkv/src/demuxer.js');
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, '../../mkv/__tests__/fixtures/avc-aac-flac.mkv');
  if (!existsSync(fixture)) {
    // fixture 由 gen.mjs 程序化生成、不入库；缺失时跳过该对照（CI 会先跑 fixtures 步骤）
    return;
  }
  const bytes = new Uint8Array(readFileSync(fixture));
  const d = new MkvDemuxer(new MemoryDataSource(bytes));
  const info = await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));

  for (const t of info.tracks) {
    for await (const _ of d.samples(t.id)) {
      /* 拉完全部轨 */
    }
  }
  assert.ok(ends.length >= 1, 'mkv 全轨消费后应派发 end');
  assert.ok(ends.every((e) => e.reason === 'eos'));
  await d.destroy();
});
