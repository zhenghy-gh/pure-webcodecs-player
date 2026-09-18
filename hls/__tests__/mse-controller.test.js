/**
 * hls MseController 可测化（env/浏览器依赖层）
 * ------------------------------------------------------------
 * 用 Fake MediaSource/SourceBuffer/URL 注入 globalThis，覆盖 attach/addSourceBuffer/
 * append 队列化与配额分类/remove/trim 修剪窗口/currentBufferSeconds 回退链/destroy 全链。
 * 不覆盖：真实浏览器 SourceBuffer 的异步 updateend 时序与配额行为语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MseController } from '../src/mse-controller.js';
import { ErrorCode } from '../../core/src/errors.js';

/** 可手工触发事件的假 SourceBuffer；autoEnd 模拟真浏览器 append/remove 后异步派发 updateend */
class FakeSourceBuffer {
  constructor() {
    this.mode = '';
    this.updating = false;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.appended = [];
    this.removed = [];
    this.aborts = 0;
    this.autoEnd = true;
    this.appendBufferThrows = null;
    this.removeThrows = null;
    this.bufferedThrows = false;
    this._buffered = { length: 0, start: () => 0, end: () => 0 };
    this._listeners = new Map();
  }
  /** bufferedThrows 模拟 SB 被 Chrome 移除后读 buffered 抛异常 */
  get buffered() {
    if (this.bufferedThrows) throw new Error('SourceBuffer has been removed');
    return this._buffered;
  }
  set buffered(v) { this._buffered = v; }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
  removeEventListener(t, fn) { this._listeners.set(t, (this._listeners.get(t) ?? []).filter((f) => f !== fn)); }
  __fire(t) { for (const fn of [...(this._listeners.get(t) ?? [])]) fn({ type: t }); }
  appendBuffer(data) {
    if (this.appendBufferThrows) throw this.appendBufferThrows;
    this.appended.push(data);
    if (this.autoEnd) queueMicrotask(() => this.__fire('updateend'));
  }
  remove(start, end) {
    if (this.removeThrows) throw this.removeThrows;
    this.removed.push([start, end]);
    if (this.autoEnd) queueMicrotask(() => this.__fire('updateend'));
  }
  abort() { this.aborts += 1; }
}

/** 假 MediaSource：构造即微任务派发 sourceopen（真浏览器为异步）；AUTO_OPEN=false 时静音供 error 用例 */
class FakeMediaSource {
  static AUTO_OPEN = true;
  static isTypeSupported(mime) { return !mime.includes('unsupported'); }
  constructor() {
    this.readyState = 'open';
    this.duration = NaN;
    this._listeners = new Map();
    this.created = new Set();
    this.endedCalls = 0;
    this.removedSbs = [];
    if (FakeMediaSource.AUTO_OPEN) queueMicrotask(() => this.__fire('sourceopen'));
  }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
  __fire(t) { for (const fn of [...(this._listeners.get(t) ?? [])]) fn({ type: t }); }
  addSourceBuffer(mime) {
    const sb = new FakeSourceBuffer();
    this.created.add(sb);
    return sb;
  }
  removeSourceBuffer(sb) { this.removedSbs.push(sb); }
  endOfStream() { this.endedCalls += 1; }
}

function makeVideo() {
  const attrs = new Map();
  return {
    currentTime: 0,
    src: null,
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.get(k); },
    removeAttribute(k) { attrs.delete(k); },
  };
}

/** 保存/还原 globalThis 若干属性 */
async function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

const MIME = 'video/mp4; codecs="avc1.42E01E"';

/* ------------------------------ attach ------------------------------ */

test('attach：无 MSE/ManagedMediaSource 全局 → notSupported；Node 默认即此', async () => {
  const c = new MseController();
  assert.throws(() => c.attach(makeVideo()), (e) => e.code === 'NOT_SUPPORTED');
});

test('attach：sourceopen resolve、video.src 接 ObjectURL；sourceerror 以 DECODE_ERROR 拒绝', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, ManagedMediaSource: undefined, URL: { createObjectURL: () => 'blob:fake' } }, async () => {
    const c = new MseController();
    const video = makeVideo();
    const { mediaSource } = await c.attach(video);
    assert.ok(mediaSource instanceof FakeMediaSource);
    assert.equal(c.mediaSource, mediaSource);
    assert.equal(video.src, 'blob:fake');
    assert.equal(c._objectUrl, 'blob:fake');

    const c2 = new MseController();
    FakeMediaSource.AUTO_OPEN = false; // 只测 sourceerror 拒绝路径
    const p = assert.rejects(c2.attach(makeVideo()), (e) => e.code === ErrorCode.DECODE_ERROR);
    FakeMediaSource.AUTO_OPEN = true;
    queueMicrotask(() => c2.mediaSource.__fire('sourceerror'));
    await p;
  });
});

test('attach：ManagedMediaSource 优先于 MediaSource（iOS Safari 路线）', async () => {
  class FakeMMS extends FakeMediaSource {}
  await withGlobals({
    MediaSource: FakeMediaSource,
    ManagedMediaSource: FakeMMS,
    URL: { createObjectURL: () => 'blob:fake' },
  }, async () => {
    const c = new MseController();
    const { mediaSource } = await c.attach(makeVideo());
    assert.ok(mediaSource instanceof FakeMMS);
  });
});

/* ------------------------------ addSourceBuffer ------------------------------ */

test('addSourceBuffer：未 open 抛 STATE_ERROR；isTypeSupported false 抛 NOT_SUPPORTED；成功建队列', async () => {
  const c = new MseController();
  assert.throws(() => c.addSourceBuffer('video', MIME), (e) => e.code === 'STATE_ERROR', 'mediaSource 为 null');

  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const video = makeVideo();
    await c.attach(video);
    assert.throws(
      () => c.addSourceBuffer('video', 'video/mp4; codecs="unsupported"'),
      (e) => e.code === 'NOT_SUPPORTED',
    );
    const sb = c.addSourceBuffer('video', MIME);
    assert.equal(sb.mode, 'segments');
    assert.equal(c.sourceBuffers.video, sb);
    assert.ok(c._queues.video instanceof Promise);
  });
});

/* ------------------------------ append ------------------------------ */

test('append：未初始化拒绝；appendBuffer 同步抛原样上抛；updateend resolve', async () => {
  const c = new MseController();
  await assert.rejects(c.append('video', new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');

  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);

    await c.append('video', new Uint8Array([1, 2])); // 正常路径
    assert.equal(sb.appended.length, 1);

    // 非 Uint8Array 输入被转换
    await c.append('video', [9]);
    assert.ok(sb.appended[1] instanceof Uint8Array);

    // 同步抛（QuotaExceededError 原样上抛，不转 DECODE_ERROR）
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    sb.appendBufferThrows = quota;
    await assert.rejects(c.append('video', new Uint8Array([3])), (e) => e === quota);
    sb.appendBufferThrows = null;
  });
});

test('append：error 事件 + buffered>=30 → 配额回调 + DECODE_ERROR；读 buffered 抛 → 普通 append 错误', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);

    const evictions = [];
    c._onQuotaEvict = (type, ranges) => evictions.push([type, ranges]);

    // 配额路径：buffered 满 30 段（关 autoEnd，让 error 事件驱动拒绝）
    sb.autoEnd = false;
    sb.buffered = { length: 30, start: () => 0, end: () => 10 };
    const p1 = c.append('video', new Uint8Array([1]));
    const p1Assert = assert.rejects(p1, (e) => e.code === ErrorCode.DECODE_ERROR && e.detail?.type === 'video');
    queueMicrotask(() => sb.__fire('error'));
    await p1Assert;
    assert.equal(evictions.length, 1, '上层收到一次裁剪回调');
    assert.equal(evictions[0][0], 'video');
    assert.equal(evictions[0][1].length, 30, '回调携带完整 buffered 区间列表');

    // SB 已被 Chrome 移除：读 buffered 抛 → 按普通 append 错误
    sb.bufferedThrows = true;
    const p2 = c.append('video', new Uint8Array([2]));
    const p2Assert = assert.rejects(p2, (e) => e.code === ErrorCode.DECODE_ERROR);
    queueMicrotask(() => sb.__fire('error'));
    await p2Assert;
    assert.equal(evictions.length, 1, '无配额信息不再回调');
  });
});

test('append：队列串行化，前一任务失败不阻塞后续任务', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);

    sb.autoEnd = false; // 关闭自动派发，手动驱动事件时序
    const first = c.append('video', new Uint8Array([1]));
    const second = c.append('video', new Uint8Array([2]));
    const firstAssert = assert.rejects(first, (e) => e.code === ErrorCode.DECODE_ERROR);
    queueMicrotask(() => sb.__fire('error')); // 第一个失败
    await firstAssert;
    queueMicrotask(() => sb.__fire('updateend')); // 手动完成第二笔
    await second;
    assert.deepEqual(sb.appended.map((d) => [...d]), [[1], [2]], '假件两笔都入队，但第二笔 promise 正常 resolve 即证明不被阻塞');
  });
});

/* ------------------------------ remove / trim ------------------------------ */

test('remove：无 sb 直接 resolve；updating 先 abort；updateend resolve；同步抛 reject', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.remove('video', 0, 5); // 无 sb → resolve

    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);
    sb.updating = true;
    await c.remove('video', 0, 5);
    assert.equal(sb.aborts, 1);
    assert.deepEqual(sb.removed, [[0, 5]]);

    sb.removeThrows = new Error('remove boom');
    await assert.rejects(c.remove('video', 0, 5), (e) => e.message === 'remove boom');
  });
});

test('trim：窗口外整段移除、部分重叠保留、显式 currentTime、removed 汇总', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.attach(makeVideo());
    const vsb = c.addSourceBuffer('video', MIME);
    const asb = c.addSourceBuffer('audio', 'audio/mp4; codecs="mp4a.40.2"');
    // remove() 走队列且 sb.remove 不改 buffered —— 测试用 buffered 快照模拟逐步收缩
    let videoRanges = [[0, 10], [25, 45], [100, 200]];
    let audioRanges = [[95, 105]];
    vsb.buffered = { get length() { return videoRanges.length; }, start: (i) => videoRanges[i][0], end: (i) => videoRanges[i][1] };
    asb.buffered = { get length() { return audioRanges.length; }, start: (i) => audioRanges[i][0], end: (i) => audioRanges[i][1] };

    const removed = await c.trim({ behindSec: 10, aheadSec: 15, currentTime: 40 });

    // t=40，keep=[30,55]：[0,10] 全在左外→删；[25,45] 部分重叠→留；[100,200] 全在右外→删；
    // audio [95,105] 全在右外→删
    assert.deepEqual(removed, [
      { type: 'video', start: 0, end: 10 },
      { type: 'video', start: 100, end: 200 },
      { type: 'audio', start: 95, end: 105 },
    ]);
    assert.deepEqual(vsb.removed, [[0, 10], [100, 200]]);
    assert.deepEqual(asb.removed, [[95, 105]]);

    // 非 Number 播放点 → 空操作
    c.video = { currentTime: NaN };
    assert.deepEqual(await c.trim({}), []);
  });
});

/* ------------------------------ 缓冲读取 ------------------------------ */

test('getBuffered：无 sb/读抛 → 安全空数组；正常展开区间', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    assert.deepEqual(c.getBuffered('video'), []);

    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);
    sb.buffered = { length: 2, start: (i) => i * 10, end: (i) => i * 10 + 5 };
    assert.deepEqual(c.getBuffered(), [[0, 5], [10, 15]]);

    sb.bufferedThrows = true;
    assert.deepEqual(c.getBuffered(), [], 'SB 移除期读取失败属正常');
  });
});

test('currentBufferSeconds：视频命中优先、音频回退、双未命中为 0', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    assert.equal(c.currentBufferSeconds(), 0, '无 video');

    const video = makeVideo();
    await c.attach(video);
    const vsb = c.addSourceBuffer('video', MIME);
    const asb = c.addSourceBuffer('audio', 'audio/mp4; codecs="mp4a.40.2"');

    const ranges = [[0, 30]];
    vsb.buffered = { length: 1, start: () => ranges[0][0], end: () => ranges[0][1] };
    asb.buffered = { length: 0, start: () => 0, end: () => 0 };

    video.currentTime = 10; // 视频命中 → 30-10=20
    assert.equal(c.currentBufferSeconds(), 20);

    video.currentTime = 100; // 视频未命中
    assert.equal(c.currentBufferSeconds(), 0, '音频也无缓冲');

    const aRanges = [[99, 130]];
    asb.buffered = { length: 1, start: () => aRanges[0][0], end: () => aRanges[0][1] };
    assert.equal(c.currentBufferSeconds(), 30, '回退音频轨');

    video.currentTime = 29.8; // s-0.5 容差内侧
    assert.ok(Math.abs(c.currentBufferSeconds() - 0.2) < 1e-9, `≈0.2，实际 ${c.currentBufferSeconds()}`);
  });
});

/* ------------------------------ finalize / endOfStream / destroy ------------------------------ */

test('finalize：设置有限 duration；非法值忽略；setter 抛错不炸', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.finalize(120); // mediaSource null → 空操作

    await c.attach(makeVideo());
    await c.finalize(120);
    assert.equal(c.mediaSource.duration, 120);

    await c.finalize(NaN); // 非法
    await c.finalize(Infinity);
    assert.equal(c.mediaSource.duration, 120);

    Object.defineProperty(c.mediaSource, 'duration', {
      get: () => 120,
      set() { throw new Error('read-only duration'); },
      configurable: true,
    });
    await c.finalize(150); // 吞掉 setter 异常
    assert.equal(c.mediaSource.duration, 120);
  });
});

test('endOfStream：open 时先 drain 队列再收尾；非 open 不动作', async () => {
  await withGlobals({ MediaSource: FakeMediaSource, URL: { createObjectURL: () => 'blob:x' } }, async () => {
    const c = new MseController();
    await c.attach(makeVideo());
    const sb = c.addSourceBuffer('video', MIME);

    let msReadyState = 'open';
    Object.defineProperty(c.mediaSource, 'readyState', { get: () => msReadyState, configurable: true });

    const pend = c.append('video', new Uint8Array([1])); // 在队列中
    await c.endOfStream(); // drainAll 保证先消费完再收尾
    await pend;
    assert.equal(sb.appended.length, 1);
    assert.equal(c.mediaSource.endedCalls, 1);

    msReadyState = 'ended';
    await c.endOfStream();
    assert.equal(c.mediaSource.endedCalls, 1, '非 open 不重复收尾');

    // endOfStream 抛错被吞
    msReadyState = 'open';
    c.mediaSource.endOfStream = () => { throw new Error('InvalidStateError'); };
    await c.endOfStream();
  });
});

test('destroy：逐轨 removeSourceBuffer、abort updating、收尾 open MS、revoke URL、清空引用且幂等', async () => {
  const revoked = [];
  await withGlobals({
    MediaSource: FakeMediaSource,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) },
  }, async () => {
    const c = new MseController();
    const video = makeVideo();
    await c.attach(video);
    const vsb = c.addSourceBuffer('video', MIME);
    const asb = c.addSourceBuffer('audio', 'audio/mp4; codecs="mp4a.40.2"');
    asb.updating = true;
    const ms = c.mediaSource;
    let msReadyState = 'open';
    Object.defineProperty(ms, 'readyState', { get: () => msReadyState, configurable: true });

    c.destroy();
    assert.deepEqual(ms.removedSbs, [vsb, asb]);
    assert.equal(asb.aborts, 1, 'updating 中的 SB 先 abort');
    assert.equal(ms.endedCalls, 1, 'open 状态下收尾');
    assert.deepEqual(revoked, ['blob:x']);
    assert.equal(video.getAttribute('src'), undefined, 'video.src 属性已移除');
    assert.equal(c.mediaSource, null);
    assert.equal(c.video, null);
    assert.deepEqual(Object.keys(c.sourceBuffers), []);

    msReadyState = 'ended';
    c.destroy(); // 幂等：mediaSource/video 已 null
    assert.deepEqual(revoked, ['blob:x']);
  });
});
