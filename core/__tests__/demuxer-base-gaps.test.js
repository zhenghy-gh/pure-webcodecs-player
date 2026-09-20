/**
 * core Demuxer 基类残余分支补测（wave 126）：
 *  - 非法状态迁移抛错 / _transitionSafe 终态吞错
 *  - 无 source open / 未实现钩子的默认抛错（_doOpen/_createTrackIterator/_doSeek）
 *  - attach 仅限 open 前 / seek 非法时间戳 / 直播暂停 readSample 分支
 *  - destroy 时 source.close 抛错吞并 / getTracks(type)/getTrack(id) 过滤
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';

const INFO = {
  container: 'toy',
  tracks: [
    { id: 1, type: 'audio', codec: 'pcm-s16' },
    { id: 2, type: 'video', codec: 'avc1' },
  ],
  durationUs: 1000,
  seekable: true,
  live: false,
};

/** 双轨空样本 toy demuxer */
class ToyDemuxer extends Demuxer {
  async _doOpen() { return INFO; }
  _createTrackIterator() { return (async function* () {})(); }
  async _doSeek(t) { return { actualTimestampUs: t }; }
}

test('_transition：非法迁移 → STATE_ERROR', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  assert.throws(
    () => d._transition('bogus-state'),
    (e) => e.code === 'STATE_ERROR' && /illegal demuxer state transition/.test(e.message)
  );
  await d.destroy();
});

test('_transitionSafe：终态后迁移尝试被吞掉', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  await d.destroy();
  assert.doesNotThrow(() => d._transitionSafe('ready'));
  assert.equal(d.state, 'destroyed');
});

test('open：无 source → STATE_ERROR 提示传参', async () => {
  const d = new ToyDemuxer();
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'STATE_ERROR' && /no source/.test(e.message)
  );
});

test('未实现 _doOpen → open 抛 STATE_ERROR 指明类名', async () => {
  class Empty extends Demuxer {}
  const d = new Empty(new MemoryDataSource(new Uint8Array([1])));
  await assert.rejects(
    () => d.open(),
    (e) => e.code === 'STATE_ERROR' && /Empty must implement _doOpen/.test(e.message)
  );
});

test('未实现 _createTrackIterator → readSample 抛 STATE_ERROR 指明类名', async () => {
  class NoIter extends Demuxer {
    async _doOpen() { return INFO; }
  }
  const d = new NoIter(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  await assert.rejects(
    () => d.readSample(1),
    (e) => e.code === 'STATE_ERROR' && /NoIter must implement _createTrackIterator/.test(e.message)
  );
  await d.destroy();
});

test('基类默认 _doSeek → SEEK_UNSUPPORTED', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  // 直接调用基类默认钩子验证其契约
  await assert.rejects(
    () => Demuxer.prototype._doSeek.call(d, 100),
    (e) => e.code === 'SEEK_UNSUPPORTED' && /does not support seeking/.test(e.message)
  );
  await d.destroy();
});

test('attach：open 后调用 → STATE_ERROR', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  assert.throws(
    () => d.attach(new MemoryDataSource(new Uint8Array([2]))),
    (e) => e.code === 'STATE_ERROR' && /only allowed before open/.test(e.message)
  );
  await d.destroy();
});

test('seek：负数与 NaN → STATE_ERROR（seekable 流）', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  for (const bad of [-1, NaN, Infinity]) {
    await assert.rejects(
      () => d.seek(bad),
      (e) => e.code === 'STATE_ERROR' && /invalid timestampUs/.test(e.message)
    );
  }
  await d.destroy();
});

test('直播暂停：readSample 照常返回样本并派发 sample 事件（缓冲语义）', async () => {
  class LiveToy extends ToyDemuxer {
    async _doOpen() { return { ...INFO, live: true, seekable: false }; }
    _createTrackIterator() {
      return (async function* () {
        yield { trackId: 1, codec: 'pcm-s16', timestamp: 0, duration: 1, keyframe: true, data: new Uint8Array(2) };
      })();
    }
  }
  const d = new LiveToy(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  const samples = [];
  d.on('sample', ({ sample }) => samples.push(sample));
  d.pause();
  const s = await d.readSample(1);
  assert.ok(s, '直播暂停不拦截样本返回');
  assert.equal(samples.length, 1, 'sample 事件照常派发');
  await d.destroy();
});

test('destroy：source.close 抛错被吞并，end(aborted) 照发', async () => {
  const source = {
    size: 1,
    read: async (o, l) => new Uint8Array(l),
    close: async () => { throw new Error('close exploded'); },
  };
  const d = new ToyDemuxer(source);
  await d.open();
  const ends = [];
  d.on('end', (e) => ends.push(e));
  await assert.doesNotReject(() => d.destroy());
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'aborted');
});

test('getTracks(type) 过滤 / getTrack(id) 查找与未命中 null', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([1])));
  await d.open();
  assert.deepEqual(d.getTracks('audio').map((t) => t.id), [1]);
  assert.deepEqual(d.getTracks('video').map((t) => t.id), [2]);
  assert.equal(d.getTracks().length, 2);
  assert.equal(d.getTrack(2).codec, 'avc1');
  assert.equal(d.getTrack(99), null);
  await d.destroy();
});
