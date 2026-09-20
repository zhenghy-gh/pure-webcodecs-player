/**
 * source-gaps.test.js —— RtspChunkSource 残余分支补测（wave 163）
 *
 * 覆盖：
 *   - close 事件：未手动 stop 且未配重连 → 派发 end（48）；
 *   - start：meta 到达前 client 报 error → 清看门狗并拒绝（67-68）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RtspChunkSource } from '../src/source.js';
import { Emitter } from '../../core/src/emitter.js';

class FakeClient extends Emitter {
  constructor({ reconnect = false, failStart = null } = {}) {
    super();
    this.opts = { reconnect };
    this.failStart = failStart;
    this.stopCalls = 0;
  }
  async start() {
    await new Promise((r) => setImmediate(r));
    if (this.failStart) this.emit('error', this.failStart);
  }
  stop() { this.stopCalls += 1; }
}

test('close：未 stop 且无重连配置 → 派发 end（48）', () => {
  const client = new FakeClient();
  const source = new RtspChunkSource(client);
  const ends = [];
  source.on('end', () => ends.push(1));

  client.emit('close', { code: 1006 });

  assert.deepEqual(ends, [1]);
});

test('start：meta 前 client error → 清定时器并把错误拒绝给调用方（67-68）', async () => {
  const boom = new Error('链路故障');
  const client = new FakeClient({ failStart: boom });
  const source = new RtspChunkSource(client);

  await assert.rejects(() => source.start(), /链路故障/);
  assert.equal(source.started, true);

  // 未收到 meta：meta 仍为 null
  assert.equal(source.meta, null);
});
