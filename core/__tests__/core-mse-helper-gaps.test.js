/**
 * core-mse-helper-gaps.test.js —— MseHelper 残余分支补测（wave 157）
 *
 * 覆盖：
 *   - SourceBufferChannel.abortThenClear：updating 两态 + changeType 预留分支；
 *   - MseHelper.append 正常经通道入队（241）与未知 key 守卫；
 *   - drainAll：等待全部通道队列落定；
 *   - destroy：readyState 竞态下 endOfStream 抛错被吞（324-325）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MseHelper } from '../src/mse-helper.js';

class FakeSourceBuffer {
  constructor() {
    this.listeners = new Map();
    this.updating = false;
    this.appended = [];
    this.aborts = 0;
    this.changeTypeCalls = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  emit(type) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({});
  }
  appendBuffer(data) { this.appended.push(data); this.updating = true; }
  abort() { this.aborts += 1; this.updating = false; }
  get changeType() { return this._changeType ?? null; }
  set changeType(fn) { this._changeType = fn; }
}

class FakeMediaSource {
  constructor() {
    this.readyState = 'open';
    this.sourceBuffers = [];
    this.endOfStream = () => {};
  }
  addSourceBuffer() {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  }
  isTypeSupported() { return true; }
}

async function makeOpenedHelper() {
  const ms = new FakeMediaSource();
  const helper = new MseHelper({ currentTime: 0, addEventListener() {}, removeEventListener() {} });
  helper.mediaSource = ms;
  helper.opened = true;
  await helper.addTrack('v1', 'video/mp4; codecs="avc1.42E01E"');
  return { helper, ms, sb: ms.sourceBuffers[0] };
}

const tick = () => new Promise((r) => setImmediate(r));

test('abortThenClear：非更新态不 abort；更新态 abort；changeType 存在时进入预留分支', async () => {
  const { helper, sb } = await makeOpenedHelper();
  const ch = helper.channels.get('v1');

  await ch.abortThenClear(); // updating=false → 不 abort
  assert.equal(sb.aborts, 0);

  sb.updating = true;
  await ch.abortThenClear(); // updating=true → abort 一次
  assert.equal(sb.aborts, 1);
  assert.equal(sb.updating, false);

  sb.changeType = () => { sb.changeTypeCalls++; };
  await ch.abortThenClear(); // changeType 为函数 → 预留 no-op 分支
  assert.equal(sb.changeTypeCalls, 0, '预留分支为 no-op');
});

test('append：经通道正常入队；未知 key 抛 STATE_ERROR', async () => {
  const { helper, sb } = await makeOpenedHelper();
  const data = new Uint8Array([1, 2, 3]);
  const p = helper.append('v1', data);
  await tick();
  assert.deepEqual(sb.appended, [data]);
  sb.emit('updateend');
  await p;

  assert.throws(() => helper.append('nope', data), (e) => e.code === 'STATE_ERROR');
});

test('drainAll：全部通道队列落定后 resolve', async () => {
  const { helper, sb } = await makeOpenedHelper();
  const p = helper.append('v1', new Uint8Array([9]));
  let drained = false;
  const drain = helper.drainAll().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false, 'updateend 前队列未落定');
  sb.emit('updateend');
  await Promise.all([p, drain]);
  assert.equal(drained, true);
});

test('destroy：endOfStream 因 readyState 竞态抛错 → 吞掉不影响销毁', async () => {
  const { helper, ms } = await makeOpenedHelper();
  ms.endOfStream = () => { throw new Error('readyState 竞态'); };
  assert.doesNotThrow(() => helper.destroy());
  assert.equal(helper.destroyed, true);
});
