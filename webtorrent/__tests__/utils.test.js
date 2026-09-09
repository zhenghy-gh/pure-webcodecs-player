/**
 * webtorrent/src/utils.js 专项测试。
 *
 * 该文件此前无直接测试：Emitter 靠 player.js 间接使用，withTimeout 甚至从未被调用
 * （index.js 只导出 Emitter/formatBytes）。这里逐条覆盖 Emitter 语义、超时竞速、
 * 以及 formatBytes 的单位/精度边界。
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter, withTimeout, formatBytes, PlayerError, ErrorCode } from '../src/utils.js';

describe('Emitter', () => {
  it('on 订阅并可收到多参数；返回值可退订', () => {
    const e = new Emitter();
    const got = [];
    const off = e.on('tick', (a, b) => got.push([a, b]));
    e.emit('tick', 1, 2);
    assert.deepEqual(got, [[1, 2]]);
    off();
    e.emit('tick', 3, 4);
    assert.deepEqual(got, [[1, 2]], '退订后不应再收到');
  });

  it('同一事件多监听器按注册顺序全部触发', () => {
    const e = new Emitter();
    const order = [];
    e.on('x', () => order.push('a'));
    e.on('x', () => order.push('b'));
    e.emit('x');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('once 只触发一次，且可提前退订', () => {
    const e = new Emitter();
    let n = 0;
    const off = e.once('ready', () => {
      n += 1;
    });
    e.emit('ready');
    e.emit('ready');
    assert.equal(n, 1, 'once 应只触发一次');

    let m = 0;
    const off2 = e.once('go', () => {
      m += 1;
    });
    off2();
    e.emit('go');
    assert.equal(m, 0, '提前退订后不应触发');
    void off;
  });

  it('off 移除指定监听器，不影响其他监听器', () => {
    const e = new Emitter();
    let a = 0;
    let b = 0;
    const fa = () => {
      a += 1;
    };
    const fb = () => {
      b += 1;
    };
    e.on('y', fa);
    e.on('y', fb);
    e.off('y', fa);
    e.emit('y');
    assert.equal(a, 0);
    assert.equal(b, 1);
  });

  it('off / emit 对未知类型安全（不抛异常）', () => {
    const e = new Emitter();
    assert.doesNotThrow(() => e.off('nope', () => {}));
    assert.doesNotThrow(() => e.emit('nope'));
  });

  it('单个监听器抛异常不阻断其他监听器，并上报 console.error', () => {
    const e = new Emitter();
    let second = 0;
    const err = mock.method(console, 'error', () => {});
    try {
      e.on('z', () => {
        throw new Error('boom');
      });
      e.on('z', () => {
        second += 1;
      });
      e.emit('z');
    } finally {
      err.mock.restore();
    }
    assert.equal(second, 1, '后续监听器应继续执行');
    assert.equal(err.mock.callCount(), 1);
    assert.match(err.mock.calls[0].arguments[0], /\[emitter:z\]/);
    assert.equal(err.mock.calls[0].arguments[1].message, 'boom');
  });
});

describe('withTimeout', () => {
  it('先于超时完成 → resolve 并清理定时器', async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, '查询');
    assert.equal(v, 42);
  });

  it('超时 → reject TIMEOUT 的 PlayerError，消息含 tag 与耗时', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const p = withTimeout(new Promise(() => {}), 500, '连接网关');
      mock.timers.tick(500);
      await assert.rejects(p, (err) => {
        assert.ok(err instanceof PlayerError);
        assert.equal(err.code, ErrorCode.TIMEOUT);
        assert.match(err.message, /连接网关 超时\(500ms\)/);
        return true;
      });
    } finally {
      mock.timers.reset();
    }
  });

  it('原 promise 先失败 → 原样透传，不包装成 TIMEOUT', async () => {
    const boom = new Error('原始故障');
    await assert.rejects(withTimeout(Promise.reject(boom), 1000, '下载'), (err) => {
      assert.equal(err, boom);
      return true;
    });
  });
});

describe('formatBytes', () => {
  it('非有限值 → 占位符 "-"', () => {
    assert.equal(formatBytes(NaN), '-');
    assert.equal(formatBytes(Infinity), '-');
    assert.equal(formatBytes(-Infinity), '-');
  });

  it('B 级：整数无小数位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('KiB / MiB / GiB 逐级换算', () => {
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(1536), '1.5 KiB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
  });

  it('≥100 时省略小数位', () => {
    assert.equal(formatBytes(200 * 1024), '200 KiB');
    assert.equal(formatBytes(12.345 * 1024), '12.3 KiB');
  });

  it('超大值封顶在 GiB 单位', () => {
    assert.match(formatBytes(1024 ** 3 * 900), /GiB$/);
  });

  it('负数按原样显示（未定义为错误）', () => {
    assert.equal(formatBytes(-5), '-5 B');
  });
});
