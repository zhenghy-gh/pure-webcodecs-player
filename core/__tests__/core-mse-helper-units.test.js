/**
 * mse-helper 可测化（env/浏览器依赖层）：MediaSource 封装在 Node 下用注入 Fake 覆盖。
 *
 * 覆盖点：SourceBuffer 写入队列串行化与错误双通道、bufferedAhead 水位计算分支、
 *        resetTrack 决策、_ctor 的 managed/MSE 选择与缺失兜底、open/destroy 的对象 URL 生命周期。
 * 不覆盖：真实浏览器 SourceBuffer 的 QuotaExceededError / updateend 时序语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MseHelper, mseMonotonicTime } from '../src/mse-helper.js';
import { mseIsTypeSupported } from '../src/codec-string.js';

/** 可控 SourceBuffer 假件：手动触发 updateend/error 观察队列时序 */
class FakeSourceBuffer {
  constructor({ updateOnRemove = true } = {}) {
    this.listeners = new Map();
    this.updating = false;
    this.buffered = null;
    this.appended = [];
    this.removed = [];
    this.aborts = 0;
    this._updateOnRemove = updateOnRemove;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }
  emit(type) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({});
  }
  appendBuffer(data) {
    this.appended.push(data);
    this.updating = true;
  }
  remove(start, end) {
    this.removed.push([start, end]);
    if (this._updateOnRemove) this.updating = true;
  }
  abort() {
    this.aborts += 1;
    this.updating = false;
  }
}

/** 假 MediaSource 实例：带**实例** isTypeSupported（走 mse-helper 的实例方法分支） */
class FakeMediaSource {
  constructor({ supported = true, duration = NaN } = {}) {
    this.supportedFlag = supported;
    this.readyState = 'closed';
    this.duration = duration;
    this.sourceBuffers = [];
    this._listeners = new Map();
    this.ended = undefined;
    this.startStreamingCalls = 0;
  }
  isTypeSupported() {
    return this.supportedFlag;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((f) => f !== fn));
  }
  emit(type) {
    for (const fn of [...(this._listeners.get(type) ?? [])]) fn({});
  }
  addSourceBuffer(mime) {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push({ mime, sb });
    return sb;
  }
  endOfStream(reason) {
    this.ended = arguments.length === 0 ? '__noarg__' : reason;
  }
  startStreaming() {
    this.startStreamingCalls += 1;
  }
}

/** 组装一个已打开、已注入 fake MediaSource 的 helper，并预置一条轨 */
async function makeOpenedHelper(mime = 'video/mp4; codecs="avc1.42E01E"', msOpts = {}) {
  const ms = new FakeMediaSource(msOpts);
  const helper = new MseHelper({ currentTime: 0, addEventListener() {}, removeEventListener() {} });
  helper.mediaSource = ms;
  helper.opened = true;
  const channel = await helper.addTrack('v1', mime);
  return { helper, ms, channel, sb: ms.sourceBuffers[0].sb };
}

function rangeSet(ranges) {
  return {
    length: ranges.length,
    start: (i) => ranges[i][0],
    end: (i) => ranges[i][1],
  };
}

/** 让出微任务队列：enqueue 的 executor 在 this.queue.then 回调中执行，需先 flush */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------ addTrack / mime 判定 ------------------------------ */

test('addTrack：实例自带 isTypeSupported 时尊重实例方法（不依赖构造器静态）', async () => {
  const { helper, channel } = await makeOpenedHelper();
  assert.equal(helper.channels.size, 1);
  assert.equal(channel.label, 'v1');
  // 幂等：同 key 再次 addTrack 返回同一 channel，不重复建 SB
  const again = await helper.addTrack('v1', 'video/mp4; codecs="x"');
  assert.equal(again, channel);
  assert.equal(helper.mediaSource.sourceBuffers.length, 1);
});

test('addTrack：mime 不支持时抛 NOT_SUPPORTED', async () => {
  const ms = new FakeMediaSource({ supported: false });
  const helper = new MseHelper({});
  helper.mediaSource = ms;
  helper.opened = true;
  await assert.rejects(
    () => helper.addTrack('v1', 'video/mp4; codecs="nope"'),
    (e) => e.code === 'NOT_SUPPORTED',
  );
});

test('addTrack/append：未 open 时抛 STATE_ERROR', async () => {
  const helper = new MseHelper({});
  assert.throws(() => helper.append('v1', new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(
    () => helper.addTrack('v1', 'video/mp4'),
    (e) => e.code === 'STATE_ERROR',
  );
});

test('append：未知轨 key 抛 STATE_ERROR', async () => {
  const { helper } = await makeOpenedHelper();
  assert.throws(() => helper.append('nope', new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
});

/* ------------------------------ SourceBuffer 写入队列 ------------------------------ */

test('append：updateend 后 resolve，且队列串行（前一次未结束不启动后一次）', async () => {
  const { channel, sb } = await makeOpenedHelper();
  let first = null;
  let secondFinished = false;
  const p1 = channel.append(new Uint8Array([1])).then(() => { first = 'done'; });
  const p2 = channel.append(new Uint8Array([2])).then(() => { secondFinished = true; });
  await tick();
  assert.equal(sb.appended.length, 1, '第二次 append 必须等待第一次 updateend');
  sb.updating = false;
  sb.emit('updateend');
  await p1;
  await tick();
  assert.equal(first, 'done');
  assert.equal(secondFinished, false);
  assert.equal(sb.appended.length, 2);
  sb.updating = false;
  sb.emit('updateend');
  await p2;
  assert.equal(secondFinished, true);
});

test('enqueue：非更新类操作（updating 保持 false）立即 resolve', async () => {
  const { channel } = await makeOpenedHelper();
  const sb2 = new FakeSourceBuffer({ updateOnRemove: false });
  channel.sb = sb2;
  const p = channel.remove(0, 1);
  await tick();
  assert.deepEqual(sb2.removed, [[0, 1]]);
  await p; // 未触发 updateend 也应完成
});

test('enqueue：update 出错走 error 事件 → reject DECODE_ERROR，且队列继续流动', async () => {
  const { helper, channel, sb } = await makeOpenedHelper();
  const errors = [];
  helper.on('bufferError', (e) => errors.push(e));
  const p = channel.append(new Uint8Array([1]));
  await tick();
  sb.emit('error');
  await assert.rejects(p, (e) => e.code === 'DECODE_ERROR');
  assert.ok(errors.length >= 1, 'error 双通道上报：返回 promise + bufferError 事件');
  // 队列未卡死：后续 append 仍可执行
  const p2 = channel.append(new Uint8Array([2]));
  await tick();
  sb.updating = false;
  sb.emit('updateend');
  await p2;
  assert.equal(sb.appended.length, 2);
});

test('enqueue：operation 同步抛错 → reject，不残留监听', async () => {
  const { channel, sb } = await makeOpenedHelper();
  await assert.rejects(
    () => channel.enqueue(() => { throw new Error('sync boom'); }),
    /sync boom/,
  );
  assert.equal(sb.listeners.get('updateend')?.length ?? 0, 0, '异常路径清理 updateend 监听');
  assert.equal(sb.listeners.get('error')?.length ?? 0, 1, '仅保留构造时的常驻 error 监听');
});

test('enqueue：channel 关闭后一律 reject STATE_ERROR', async () => {
  const { helper, channel } = await makeOpenedHelper();
  helper.destroy();
  await assert.rejects(() => channel.append(new Uint8Array([1])), (e) => e.code === 'STATE_ERROR');
});

/* ------------------------------ bufferedAhead 水位分支 ------------------------------ */

test('bufferedAhead：无轨/空区间返回 0', async () => {
  const { helper } = await makeOpenedHelper();
  assert.equal(helper.buffered('missing'), null);
  assert.equal(helper.bufferedAhead('missing'), 0);
  assert.equal(helper.bufferedAhead('v1'), 0, 'sb.buffered=null → 0');
  helper.buffered = () => rangeSet([]);
  assert.equal(helper.bufferedAhead('v1', 5), 0);
});

test('bufferedAhead：当前点落在区间内只算剩余，之后的区间整段计入，之前的忽略', async () => {
  const { helper, sb } = await makeOpenedHelper();
  sb.buffered = rangeSet([[0, 10], [20, 30]]);
  // t=5：区间[0,10] 剩 5；[20,30] 整段 10 → 15
  assert.equal(helper.bufferedAhead('v1', 5), 15);
  // t=15（落在空隙）：[0,10] 已过 → 0；[20,30] 整段 → 10
  assert.equal(helper.bufferedAhead('v1', 15), 10);
  // t=25：区间[20,30] 剩 5 → 5
  assert.equal(helper.bufferedAhead('v1', 25), 5);
  // t=40：全过 → 0
  assert.equal(helper.bufferedAhead('v1', 40), 0);
});

test('bufferedAhead：currentTime 缺省时回落元素 currentTime', async () => {
  const element = { currentTime: 0, addEventListener() {}, removeEventListener() {} };
  const ms = new FakeMediaSource();
  const helper = new MseHelper(element);
  helper.mediaSource = ms;
  helper.opened = true;
  const channel = await helper.addTrack('v1', 'video/mp4');
  channel.sb.buffered = rangeSet([[0, 10]]);
  element.currentTime = 4;
  assert.equal(helper.bufferedAhead('v1'), 6);
});

/* ------------------------------ resetTrack 决策 ------------------------------ */

test('resetTrack：未知轨 no-op；keepPosition 有缓冲时只清当前位置之后', async () => {
  const { helper, sb } = await makeOpenedHelper();
  assert.equal(await helper.resetTrack('nope'), undefined);

  helper.element.currentTime = 2;
  sb.buffered = rangeSet([[0, 10]]);
  helper.mediaSource.duration = 10;
  const channel = helper.channels.get('v1');
  const removed = [];
  channel.remove = async (a, b) => removed.push([a, b]);
  await helper.resetTrack('v1', true);
  assert.equal(removed.length, 1);
  assert.ok(Math.abs(removed[0][0] - (2 + 1e-4)) < 1e-9, '起点=currentTime+ε');
  assert.equal(removed[0][1], 10, '终点取 durationOr(最后区间 end)');
});

test('resetTrack：无缓冲或 keepPosition=false 时 abortThenClear + 全清', async () => {
  const { helper, sb } = await makeOpenedHelper();
  const channel = helper.channels.get('v1');
  const ops = [];
  channel.abortThenClear = async () => ops.push('abortThenClear');
  channel.remove = async (a, b) => ops.push(['remove', a, b]);
  helper.mediaSource.duration = NaN; // durationOr 回落 MAX_SAFE_INTEGER/1000

  await helper.resetTrack('v1', false);
  assert.equal(ops[0], 'abortThenClear');
  assert.equal(ops[1][0], 'remove');
  assert.equal(ops[1][1], 0);
  assert.equal(ops[1][2], Number.MAX_SAFE_INTEGER / 1000);
  void sb;
});

test('durationOr：有限正数用自身，否则回落', async () => {
  const { helper } = await makeOpenedHelper();
  helper.mediaSource.duration = 12.5;
  assert.equal(helper.durationOr(99), 12.5);
  helper.mediaSource.duration = 0;
  assert.equal(helper.durationOr(99), 99);
  helper.mediaSource.duration = NaN;
  assert.equal(helper.durationOr(99), 99);
});

/* ------------------------------ setDuration / endOfStream ------------------------------ */

test('setDuration / endOfStream：reason 有值/无值分支，且先 drainAll', async () => {
  const { helper, ms } = await makeOpenedHelper();
  await assert.rejects(() => new MseHelper({}).setDuration(1), (e) => e.code === 'STATE_ERROR');

  await helper.setDuration(42);
  assert.equal(ms.duration, 42);

  let drained = 0;
  helper.drainAll = () => { drained += 1; return Promise.resolve(); };
  await helper.endOfStream('network');
  assert.equal(drained, 1);
  assert.equal(ms.ended, 'network');
  await helper.endOfStream();
  assert.equal(ms.ended, '__noarg__', '无参调用 endOfStream() 不带 reason');
});

/* ------------------------------ _ctor 选择与兜底 ------------------------------ */

test('_ctor：managed 优先 ManagedMediaSource，缺失回落 MediaSource；都没有则 NOT_SUPPORTED', async () => {
  class FakeManaged {}
  class FakeMS {}

  const helper = new MseHelper({});
  assert.throws(() => helper._ctor(), (e) => e.code === 'NOT_SUPPORTED', 'Node 无 MediaSource 兜底');

  const managedHelper = new MseHelper({}, { managed: true });
  const savedManaged = Object.getOwnPropertyDescriptor(globalThis, 'ManagedMediaSource');
  const savedMS = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  try {
    Object.defineProperty(globalThis, 'ManagedMediaSource', { value: FakeManaged, configurable: true });
    assert.equal(managedHelper._ctor(), FakeManaged);
    delete globalThis.ManagedMediaSource;
    Object.defineProperty(globalThis, 'MediaSource', { value: FakeMS, configurable: true });
    assert.equal(managedHelper._ctor(), FakeMS, '无 ManagedMediaSource 时回落 MediaSource');
    assert.equal(new MseHelper({})._ctor(), FakeMS);
  } finally {
    if (savedManaged) Object.defineProperty(globalThis, 'ManagedMediaSource', savedManaged);
    else delete globalThis.ManagedMediaSource;
    if (savedMS) Object.defineProperty(globalThis, 'MediaSource', savedMS);
    else delete globalThis.MediaSource;
  }
  assert.equal(globalThis.ManagedMediaSource, undefined, 'Fake 已还原');
  assert.equal(globalThis.MediaSource, undefined, 'Fake 已还原');
});

/* ------------------------------ open / destroy 生命周期 ------------------------------ */

test('open：等待 sourceopen 后 opened/发 open 事件；element.src 指向 objectURL', async () => {
  class FakeMS {
    constructor() { this._l = new Map(); this.readyState = 'closed'; }
    addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); }
    removeEventListener(t, f) { this._l.set(t, (this._l.get(t) ?? []).filter((x) => x !== f)); }
    emit(t) { for (const f of [...(this._l.get(t) ?? [])]) f({}); }
  }
  class FakeManagedMS extends FakeMS {
    constructor() { super(); this.streaming = 0; }
    startStreaming() { this.streaming += 1; }
  }

  const savedURL = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const savedMS = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  const savedManaged = Object.getOwnPropertyDescriptor(globalThis, 'ManagedMediaSource');
  const revoked = [];
  try {
    URL.createObjectURL = () => 'blob:fake-url';
    URL.revokeObjectURL = (u) => revoked.push(u);
    Object.defineProperty(globalThis, 'MediaSource', { value: FakeMS, configurable: true });
    Object.defineProperty(globalThis, 'ManagedMediaSource', { value: FakeManagedMS, configurable: true });

    const element = { src: '', addEventListener() {}, removeEventListener() {} };
    const helper = new MseHelper(element, { managed: true });
    let openedEvent = 0;
    helper.on('open', () => (openedEvent += 1));
    const p = helper.open();
    assert.equal(helper.objectUrl, 'blob:fake-url');
    assert.equal(element.src, 'blob:fake-url');
    assert.equal(helper.mediaSource.streaming, 1, 'Managed 实现需 startStreaming 提示');
    helper.mediaSource.emit('sourceopen');
    await p;
    assert.equal(helper.opened, true);
    assert.equal(openedEvent, 1);
    assert.equal(await helper.open(), undefined, 'opened 后 open 幂等');
  } finally {
    URL.createObjectURL = savedURL.create;
    URL.revokeObjectURL = savedURL.revoke;
    if (savedMS) Object.defineProperty(globalThis, 'MediaSource', savedMS);
    else delete globalThis.MediaSource;
    if (savedManaged) Object.defineProperty(globalThis, 'ManagedMediaSource', savedManaged);
    else delete globalThis.ManagedMediaSource;
  }
});

test('open：destroyed 状态 reject；element.src 赋值抛错时 reject', async () => {
  const destroyed = new MseHelper({});
  destroyed.destroyed = true;
  await assert.rejects(() => destroyed.open(), (e) => e.code === 'STATE_ERROR');

  class FakeMS {
    addEventListener() {}
    removeEventListener() {}
  }
  const savedMS = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  const savedCreate = URL.createObjectURL;
  try {
    URL.createObjectURL = () => 'blob:fake-url';
    Object.defineProperty(globalThis, 'MediaSource', { value: FakeMS, configurable: true });
    const element = {
      set src(_v) { throw new Error('src 被拒'); },
      addEventListener() {},
      removeEventListener() {},
    };
    const helper = new MseHelper(element);
    await assert.rejects(() => helper.open(), /src 被拒/);
  } finally {
    URL.createObjectURL = savedCreate;
    if (savedMS) Object.defineProperty(globalThis, 'MediaSource', savedMS);
    else delete globalThis.MediaSource;
  }
});

test('destroy：endOfStream + revoke objectURL + 摘除元素 blob src；幂等', async () => {
  const savedURL = { revoke: URL.revokeObjectURL };
  const revoked = [];
  URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    const calls = { removeAttr: 0, load: 0 };
    const element = {
      src: 'blob:abc',
      removeAttribute() { calls.removeAttr += 1; },
      load() { calls.load += 1; },
      addEventListener() {},
      removeEventListener() {},
    };
    const { helper, ms } = await makeOpenedHelper();
    helper.element = element;
    helper.objectUrl = 'blob:abc';
    ms.readyState = 'open';
    let destroyed = 0;
    helper.on('destroy', () => (destroyed += 1));

    helper.destroy();
    assert.equal(ms.ended, '__noarg__', '关闭 MediaSource');
    assert.deepEqual(revoked, ['blob:abc']);
    assert.equal(calls.removeAttr, 1);
    assert.equal(calls.load, 1);
    assert.equal(helper.channels.size, 0);
    assert.equal(destroyed, 1);

    helper.destroy(); // 幂等
    assert.equal(destroyed, 1);
  } finally {
    URL.revokeObjectURL = savedURL.revoke;
  }
});

/* ------------------------------ nowSec 导出 ------------------------------ */

test('mseMonotonicTime：返回以秒为单位的数值', () => {
  const t = mseMonotonicTime();
  assert.equal(typeof t, 'number');
  assert.ok(t >= 0);
});

/* ------------------------------ 与 codec-string 的一致性 ------------------------------ */

test('Node 无 MediaSource 时 mseIsTypeSupported 恒 false（helper 兜底语义一致）', () => {
  assert.equal(mseIsTypeSupported('video/mp4; codecs="avc1.42E01E"'), false);
});
