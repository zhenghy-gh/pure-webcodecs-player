/**
 * AmfReader 直接单元测试（flv-demuxer 仅间接使用，此前从未被直接覆盖）。
 * 纯函数、零依赖、零网络。重点覆盖：各类型编解码、边界、畸形/截断输入拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AmfReader } from '../src/amf.js';

// ---- 字节构造助手 ----
function u16(n) {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
}
function u32(n) {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function f64(v) {
  const b = new ArrayBuffer(8);
  new DataView(b).setFloat64(0, v);
  return new Uint8Array(b);
}
function strBytes(s) {
  const nb = new TextEncoder().encode(s);
  return Uint8Array.from([0x02, ...u16(nb.length), ...nb]);
}
function objEnd() {
  return Uint8Array.from([0x00, 0x00, 0x09]);
}
function join(...parts) {
  const ps = parts.map((p) => {
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'number') return Uint8Array.from([p & 0xff]); // 单字节
    return Uint8Array.from(p);
  });
  let len = 0;
  for (const p of ps) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test('Number(0x00)：双精度浮点精确往返', () => {
  for (const v of [0, 1, -1, 3.141592653589793, 1e9, -2.5, 255.99609375]) {
    const r = new AmfReader(join(Uint8Array.from([0x00]), f64(v)));
    assert.equal(r.readValue(), v);
  }
});

test('Boolean(0x01)：true/false', () => {
  assert.equal(new AmfReader(join(0x01, 0x01)).readValue(), true);
  assert.equal(new AmfReader(join(0x01, 0x00)).readValue(), false);
});

test('String(0x02)：UTF-8 往返，含中文多字节', () => {
  const r = new AmfReader(strBytes('hello 世界'));
  assert.equal(r.readValue(), 'hello 世界');
  // 空串
  assert.equal(new AmfReader(join(0x02, 0x00, 0x00)).readValue(), '');
});

test('Object(0x03)：键值对与结束标记 00 00 09', () => {
  const body = join(
    u16(5), new TextEncoder().encode('width'), Uint8Array.from([0x00]), f64(1280),
    u16(6), new TextEncoder().encode('height'), Uint8Array.from([0x00]), f64(720),
  );
  const r = new AmfReader(join(Uint8Array.from([0x03]), body, objEnd()));
  assert.deepEqual(r.readValue(), { width: 1280, height: 720 });
});

test('Object(0x03)：嵌套对象解析', () => {
  const innerName = u16(1);
  const innerBody = join(innerName, new TextEncoder().encode('x'), Uint8Array.from([0x00]), f64(7));
  const outer = join(
    u16(5), new TextEncoder().encode('inner'),
    Uint8Array.from([0x03]), innerBody, objEnd(),
  );
  const r = new AmfReader(join(Uint8Array.from([0x03]), outer, objEnd()));
  assert.deepEqual(r.readValue(), { inner: { x: 7 } });
});

test('Null(0x05) / Undefined(0x06)：分别返回 null 与 undefined', () => {
  assert.equal(new AmfReader(join(0x05)).readValue(), null);
  assert.equal(new AmfReader(join(0x06)).readValue(), undefined);
});

test('ECMA Array(0x08)：声明的条目数被忽略，以结束标记为准', () => {
  // 声明 count=99，但实际只有 1 个条目 + 结束标记
  const entry = join(u16(1), new TextEncoder().encode('a'), Uint8Array.from([0x05]));
  const r = new AmfReader(join(Uint8Array.from([0x08]), u32(99), entry, objEnd()));
  assert.deepEqual(r.readValue(), { a: null });
});

test('readCommand：方法名 + 参数序列，尾部畸形静默截断', () => {
  const tail = join(0xff, 0xff); // 0xff 为不支持的标记，readCommand 应在此停止
  const r = new AmfReader(join(strBytes('onStatus'), Uint8Array.from([0x05]), Uint8Array.from([0x00]), f64(42), tail));
  const cmd = r.readCommand();
  assert.equal(cmd.name, 'onStatus');
  assert.deepEqual(cmd.args, [null, 42]);
});

test('不支持的标记：抛错且含标记与位置', () => {
  for (const marker of [0x07, 0x09, 0x0a, 0xff]) {
    const r = new AmfReader(join(marker));
    assert.throws(
      () => r.readValue(),
      (e) => /AMF0 未支持的标记/.test(e.message) && e.message.includes('0x' + marker.toString(16)),
      `marker=0x${marker.toString(16)} 应抛未支持`,
    );
  }
});

test('截断输入：各类型数据不足均抛「AMF0 数据不足」', () => {
  // Number：仅 1 字节（缺 7 字节）
  assert.throws(() => new AmfReader(join(0x00, 0x00)).readValue(), /AMF0 数据不足/);
  // Boolean：仅标记
  assert.throws(() => new AmfReader(join(0x01)).readValue(), /AMF0 数据不足/);
  // String：标记 + 长度但无正文
  assert.throws(() => new AmfReader(join(0x02, 0x00, 0x05)).readValue(), /AMF0 字符串越界|AMF0 数据不足/);
  // Object：键名长度声明超出实际正文 → 抛字符串越界
  assert.throws(() => new AmfReader(join(0x03, 0x00, 0x05, 0x66)).readValue(), /AMF0 字符串越界|AMF0 数据不足/);
  // Object：仅标记后不足 3 字节 → 优雅返回空对象（规范容错，不抛）
  assert.deepEqual(new AmfReader(join(0x03, 0x00)).readValue(), {});
});

test('remaining getter：随读取递减', () => {
  const r = new AmfReader(join(0x05, 0x05));
  assert.equal(r.remaining, 2);
  r.readValue();
  assert.equal(r.remaining, 1);
  r.readValue();
  assert.equal(r.remaining, 0);
});

test('畸形 UTF-8 不抛：解码失败时回退原始 latin1 串', () => {
  // 0x42 0xff 0xfe 非合法 UTF-8；#utf 会 catch 并返回 s
  const r = new AmfReader(join(0x02, 0x00, 0x03, 0x42, 0xff, 0xfe));
  assert.doesNotThrow(() => r.readValue());
  assert.equal(r.remaining, 0);
});
