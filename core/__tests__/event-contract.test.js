import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/emitter.js';
import { EventBus } from '../../hls/src/utils.js';
import { MiniEmitter } from '../../rtmp/src/mini-emitter.js';
import { RtspChunkSource } from '../../rtsp/src/source.js';

test('core Emitter：多参数、取消订阅与 once 语义统一', () => {
  const bus = new Emitter();
  const seen = [];
  const off = bus.on('frame', (...args) => seen.push(args));
  bus.emit('frame', new Uint8Array([1]), { ptsUs: 2 });
  off();
  bus.emit('frame', new Uint8Array([3]), { ptsUs: 4 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].ptsUs, 2);

  let count = 0;
  bus.once('end', (...args) => { count += args[0]; });
  bus.emit('end', 1, 'first');
  bus.emit('end', 1, 'second');
  assert.equal(count, 1);
});

test('平行事件件复用 core Emitter：HLS EventBus、RTMP MiniEmitter、RTSP source', () => {
  assert.equal(EventBus, Emitter);
  assert.ok(MiniEmitter.prototype instanceof Emitter);
  assert.ok(RtspChunkSource.prototype instanceof Emitter);
});

test('core Emitter：监听器异常隔离且不阻断后续监听器', () => {
  const bus = new Emitter();
  let called = false;
  const original = console.error;
  console.error = () => {};
  try {
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => { called = true; });
    assert.equal(bus.emit('x', 1), true);
    assert.equal(called, true);
  } finally {
    console.error = original;
  }
});
