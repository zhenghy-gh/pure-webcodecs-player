import test from 'node:test';
import assert from 'node:assert/strict';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource } from '../src/data-source.js';
import { createSample } from '../src/types.js';
import { raceAbort, throwIfAborted } from '../src/abort.js';

/**
 * 门控 demuxer：`gate` 由外部 resolve 控制，未放开时首个 next() 永久挂起，
 * 用于验证 AbortSignal 能在「读取挂起」时取消，且取消后仍可续读。
 */
class GatedDemuxer extends Demuxer {
  constructor(source) {
    super(source);
    this.releaseGate = null;
    this.gate = new Promise((resolve) => { this.releaseGate = resolve; });
    this.pullCount = 0;
  }
  async _doOpen() {
    return {
      container: 'wav',
      tracks: [{ id: 1, type: 'audio', codec: 'pcm-s16', numberOfChannels: 2 }],
      durationUs: 1000,
      seekable: true,
      live: false,
    };
  }
  _createTrackIterator(id) {
    const self = this;
    return (async function* () {
      for (let i = 0; i < 3; i++) {
        await self.gate;
        self.pullCount += 1;
        yield createSample({
          trackId: id,
          codec: 'pcm-s16',
          timestamp: i,
          duration: 1,
          keyframe: true,
          data: new Uint8Array(1),
          size: 1,
        });
      }
    })();
  }
  async _doSeek(t) { return { actualTimestampUs: t }; }
}

const src = () => new MemoryDataSource(new Uint8Array(16));

/* --------------------------- 原语：raceAbort --------------------------- */

test('raceAbort：不传 signal 时零开销直通（返回同一 promise 引用）', async () => {
  const p = Promise.resolve(42);
  assert.equal(raceAbort(p, null), p);
  assert.equal(raceAbort(p, undefined), p);
  assert.equal(await raceAbort(p, null), 42);
});

test('raceAbort：signal 已 aborted 时立即 reject ABORTED（不等底层）', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => raceAbort(new Promise(() => {}), ac.signal, 'boom'),
    (err) => err?.code === 'ABORTED' && /boom/.test(err.message),
  );
});

test('raceAbort：运行中 abort 能取消挂起的 promise', async () => {
  const ac = new AbortController();
  const p = raceAbort(new Promise(() => {}), ac.signal, 'cancelled');
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => p, (err) => err?.code === 'ABORTED');
});

test('raceAbort：未 abort 时正常 resolve；底层 reject 原样透传', async () => {
  const ac = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(7), ac.signal), 7);
  const boom = new Error('io-fail');
  await assert.rejects(() => raceAbort(Promise.reject(boom), ac.signal), (err) => err === boom);
});

test('throwIfAborted：仅在已中断时抛 ABORTED', () => {
  assert.doesNotThrow(() => throwIfAborted(null));
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => throwIfAborted(ac.signal), (err) => err?.code === 'ABORTED');
});

/* ---------------------- 集成：readSample(trackId, options) ---------------------- */

test('readSample：不传 options 时行为与冻结版完全一致（向后兼容）', async () => {
  const d = new GatedDemuxer(src());
  await d.open();
  d.releaseGate();
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0);
  assert.equal(d.pullCount, 1);
});

test('readSample：传入 signal 且在读取挂起时 abort → reject ABORTED', async () => {
  const d = new GatedDemuxer(src());
  await d.open();
  const ac = new AbortController();
  const p = d.readSample(1, { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => p, (err) => err?.code === 'ABORTED');
});

test('readSample：已 abort 的 signal 前置快速失败，不触碰数据源', async () => {
  const d = new GatedDemuxer(src());
  await d.open();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => d.readSample(1, { signal: ac.signal }), (err) => err?.code === 'ABORTED');
  // 未创建/推进迭代器：放开 gate 后首个样本仍完整可取（中断不吞样本）
  d.releaseGate();
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0);
});

test('readSample：abort 后可续读，且 abort 不进 error 事件面', async () => {
  const d = new GatedDemuxer(src());
  await d.open();
  const errors = [];
  d.on('error', (e) => errors.push(e));

  const ac = new AbortController();
  const p = d.readSample(1, { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => p, (err) => err?.code === 'ABORTED');

  d.releaseGate();
  // 迟到样本经微任务写入 pendingResult，让出一个宏任务再续读
  await new Promise((r) => setTimeout(r, 0));
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0, '被中断那次已落地的样本不得丢弃');
  assert.equal(errors.length, 0, 'abort 属预期控制流，不得 emit error');
});

test('readSample：中断不吞样本，续读可完整消费至 EOS', async () => {
  const d = new GatedDemuxer(src());
  await d.open();

  const ac = new AbortController();
  const p = d.readSample(1, { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => p, (err) => err?.code === 'ABORTED');

  d.releaseGate();
  await new Promise((r) => setTimeout(r, 0));
  const got = [];
  for (;;) {
    const s = await d.readSample(1);
    if (s === null) break;
    got.push(s.timestamp);
  }
  assert.deepEqual(got, [0, 1, 2], '中断不得造成丢帧');
});

test('samples：糖层透传 signal，中断后迭代抛出 ABORTED', async () => {
  const d = new GatedDemuxer(src());
  await d.open();
  const ac = new AbortController();
  const it = d.samples(1, { signal: ac.signal })[Symbol.asyncIterator]();
  const p = it.next();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => p, (err) => err?.code === 'ABORTED');
});
