/**
 * RtspWsClient 周边纯函数/状态契约测试（零网络）：
 *   - Backoff 退避数学（抖动边界、上限封顶、reset）
 *   - STATES 冻结对象完整性
 *   - 状态机入口守卫：缺 url 的 start、非 interleaved 模式的 request 抛 STATE_ERROR
 * 不触发任何 WebSocket 连接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RtspWsClient, Backoff, STATES } from '../src/client.js';

// ---------- Backoff ----------

test('Backoff.next：基础退避落在 [base*(1-jitter), base*(1+jitter)] 内', () => {
  const b = new Backoff({ baseMs: 500, factor: 2, maxMs: 30000, jitter: 0.3 });
  const v = b.next();
  assert.ok(v >= 349 && v <= 651, `首次退避应在 [350,650]，实际 ${v}`);
});

test('Backoff.next：永不返回 < 50（下限保护）', () => {
  // 极小 base 也应被 max(50,...) 兜住
  const b = new Backoff({ baseMs: 1, factor: 2, maxMs: 30000, jitter: 0.9 });
  for (let i = 0; i < 10; i++) {
    const v = b.next();
    assert.ok(v >= 50, `第 ${i} 次退避不应 < 50，实际 ${v}`);
  }
});

test('Backoff.next：不超过 maxMs 的上界（含抖动）', () => {
  const b = new Backoff({ baseMs: 100, factor: 2, maxMs: 120, jitter: 0.3 });
  // 多次调用后 raw 远超 maxMs，但返回值被封顶在 maxMs*(1+jitter)=156 内
  for (let i = 0; i < 20; i++) {
    const v = b.next();
    assert.ok(v <= 156, `第 ${i} 次退避不应 > 156，实际 ${v}`);
    assert.ok(v >= 50, `第 ${i} 次退避不应 < 50，实际 ${v}`);
  }
});

test('Backoff.reset：重置后 attempt 归零，退避回到基础值', () => {
  const b = new Backoff({ baseMs: 500, factor: 2, maxMs: 30000, jitter: 0 });
  const first = b.next(); // attempt 0
  b.next(); b.next();      // attempt 1,2
  b.reset();
  const after = b.next();  // 回到 attempt 0
  assert.equal(first, 500);
  assert.equal(after, 500);
});

test('Backoff 默认参数可实例化且可调用', () => {
  const b = new Backoff();
  const v = b.next();
  assert.ok(Number.isInteger(v) && v >= 50);
});

// ---------- STATES ----------

test('STATES 为冻结对象且含完整状态枚举', () => {
  assert.ok(Object.isFrozen(STATES));
  for (const k of ['IDLE', 'CONNECTING', 'DESCRIBING', 'SETTING_UP', 'PLAYING', 'RECONNECTING', 'CLOSED']) {
    assert.ok(k in STATES, `缺少状态 ${k}`);
    assert.equal(typeof STATES[k], 'string');
  }
});

// ---------- 状态机入口守卫 ----------

test('client.start：缺少 url 抛 STATE_ERROR（不同步触发网络）', async () => {
  const c = new RtspWsClient({}); // 无 url
  await assert.rejects(() => c.start(), (e) => e.code === 'STATE_ERROR');
});

test('client.request：非 interleaved 模式直接拒绝（STATE_ERROR，含 interleaved 提示）', async () => {
  const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/rtsp', framing: 'rtp' });
  await assert.rejects(
    () => c.request('OPTIONS', '*', {}),
    (e) => e.code === 'STATE_ERROR' && /interleaved/.test(e.message),
  );
});

test('client 构造后状态为 IDLE，未启动不建立 ws', () => {
  const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/rtsp' });
  assert.equal(c.state, STATES.IDLE);
  assert.equal(c.ws, null);
});
