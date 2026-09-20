/**
 * slow-consumer-gaps.test.js —— SlowConsumerQueue 残余分支补测（wave 146）
 *
 * 覆盖：
 *   - sendText：底层 send 抛错 → 返回 false（文本信令直发失败面）；
 *   - drain：底层 send 抛错 → 视为写失败保留队列（try/catch 分支）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SlowConsumerQueue } from '../src/slow-consumer.js';

test('sendText：底层 send 抛错 → false', () => {
  const q = new SlowConsumerQueue({ send: () => { throw new Error('socket gone'); } });
  assert.equal(q.sendText('hi'), false);
  assert.equal(q.queuedBytes, 0, '文本不排队');
});

test('drain：底层 send 抛错 → 保留队列等待重试', async () => {
  let boom = false;
  const sent = [];
  const q = new SlowConsumerQueue({
    send: (chunk) => {
      if (boom) throw new Error('write boom');
      sent.push(chunk.length);
      return true;
    },
  });
  q.enqueueBinary(new Uint8Array(10));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [10], '正常路径应发出');

  boom = true;
  q.enqueueBinary(new Uint8Array(20));
  await new Promise((r) => setImmediate(r));
  assert.equal(q.queue.length, 1, '抛错块保留在队列');
  assert.equal(q.queuedBytes, 20);

  boom = false;
  q.enqueueBinary(new Uint8Array(1)); // 下一次入队触发重排
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [10, 20, 1], '恢复后应继续排空');
  assert.equal(q.queuedBytes, 0);
});
