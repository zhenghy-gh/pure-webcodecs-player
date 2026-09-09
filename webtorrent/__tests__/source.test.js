/**
 * source.test.js —— TorrentFileSource（slice/顺序双策略）与 MediaByteSource 契约单测
 *
 * 交叉验证：用 mkv 模块的 fixture 字节做真实 demux 消费，
 * 证明 webtorrent 源可直接喂给 MkvDemuxer（契约互通）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TorrentFileSource, createTorrentSource } from '../src/index.js';
import { makeMinimalWebm, EXPECT_WEBM } from '../../mkv/__tests__/fixtures/make-fixture.mjs';
import { MkvDemuxer } from '../../mkv/src/index.js';

/** slice 能力假文件：slice() 返回 TypedArray 视图 */
class FakeSliceFile {
  constructor(name, bytes) {
    this.name = name;
    this.bytes = bytes;
  }
  get length() { return this.bytes.length; }
  slice(start, end) {
    return this.bytes.subarray(start, Math.min(end, this.bytes.length));
  }
}

/** 纯顺序流假文件：无 slice()，stream() 分小块产出 */
class FakeStreamFile {
  /**
   * @param {string} name
   * @param {Uint8Array} bytes
   * @param {number} chunkBytes 流式块大小
   */
  constructor(name, bytes, chunkBytes = 64) {
    this.name = name;
    this.bytes = bytes;
    this.chunkBytes = chunkBytes;
    this.restarts = 0;     // 未读完即取消的次数（中途流才触发 cancel 回调）
    this.openCount = 0;    // stream() 被打开的总次数（EOF 后重启的唯一可靠信号）
  }
  get length() { return this.bytes.length; }
  stream() {
    const self = this;
    const { bytes, chunkBytes } = this;
    let pos = 0;
    this.openCount += 1;
    return new ReadableStream({
      pull: (controller) => {
        if (pos >= bytes.length) {
          controller.close();
          return;
        }
        const n = Math.min(chunkBytes, bytes.length - pos);
        controller.enqueue(bytes.subarray(pos, pos + n));
        pos += n;
      },
      cancel: () => { self.restarts += 1; },
    });
  }
}

test('slice 快路径：随机读 / EOF 短读', async () => {
  const { bytes } = makeMinimalWebm();
  const src = new TorrentFileSource(new FakeSliceFile('a.webm', bytes));
  assert.equal(src.supportsRandomAccess, true);
  assert.equal(src.byteLength, bytes.length);

  const head = await src.read(0, 16);
  assert.deepEqual([...head], [...bytes.subarray(0, 16)]);

  const mid = await src.read(bytes.length - 5, 100); // 跨末尾 → 短读（EOF 信号）
  assert.equal(mid.length, 5);

  // 完全越界 → reject SOURCE_ERROR（契约 §2.1 / 评审严重1）
  await assert.rejects(
    () => src.read(bytes.length + 10, 4),
    (e) => e.code === 'SOURCE_ERROR',
  );

  let counted = 0;
  const src2 = createTorrentSource(new FakeSliceFile('b.webm', bytes), {
    onRead: (n) => { counted += n; },
  });
  await src2.read(0, 8);
  assert.equal(counted, 8);
});

test('顺序流策略：前进读 / 向后读自动重启 / 契约参数校验', async () => {
  const { bytes } = makeMinimalWebm();
  const file = new FakeStreamFile('c.webm', bytes, 48);
  const src = new TorrentFileSource(file, {});
  assert.equal(src.supportsRandomAccess, false);

  // 前进读若干段
  const r1 = await src.read(0, 32);
  assert.deepEqual([...r1], [...bytes.subarray(0, 32)]);
  const r2 = await src.read(32, 40); // 跨块拼接
  assert.deepEqual([...r2], [...bytes.subarray(32, 72)]);
  const r3 = await src.read(bytes.length - 40, 16); // 界内前向读（新语义下越界会拒绝）
  assert.deepEqual([...r3], [...bytes.subarray(bytes.length - 40, bytes.length - 24)]);

  // 回到更早偏移：触发重启丢弃慢路径
  const back = await src.read(8, 12);
  assert.deepEqual([...back], [...bytes.subarray(8, 20)]);
  // EOF 已自然闭合的流不再触发 cancel；重启信号以「重新打开 stream」为准
  assert.ok(file.openCount >= 2 || file.restarts >= 1, '向后读取应重建底层流');

  // 参数校验
  await assert.rejects(() => src.read(-1, 4), /参数非法/);
  await assert.rejects(() => src.read(0, -1), /参数非法/);

  src.close();
  await assert.rejects(() => src.read(0, 1), /已关闭/);
});

test('交叉验证：TorrentFileSource 直接喂给 mkv 的 MkvDemuxer（契约互通）', async () => {
  const { bytes } = makeMinimalWebm();
  for (const fake of [
    new FakeSliceFile('sample.webm', bytes),
    new FakeStreamFile('sample.webm', bytes, 96),
  ]) {
    const d = new MkvDemuxer(createTorrentSource(fake));
    const info = await d.init();
    assert.equal(info.container, EXPECT_WEBM.container);
    assert.equal(info.durationUs, EXPECT_WEBM.durationUs);
    assert.equal(d.tracks[0].codec, EXPECT_WEBM.tracks[0].codec);

    // 契约面：逐轨 pull 计数（视频 3 帧 + 音频 laced 5 帧）
    let vCount = 0;
    for (;;) { const s = await d.readSample(1); if (!s) break; vCount++; }
    let aCount = 0;
    for (;;) { const s = await d.readSample(2); if (!s) break; aCount++; }
    assert.equal(vCount, 3);
    assert.equal(aCount, EXPECT_WEBM.samplesInOrder.length - 3);
  }
});
