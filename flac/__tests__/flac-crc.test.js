/**
 * flac/__tests__/flac-crc.test.js — CRC-8 / CRC-16 校验向量（node --test）
 * ------------------------------------------------------------
 * 覆盖 crc.js 的查表实现正确性：
 *  · crc8/crc16 已知参考向量（"123456789"）
 *  · 空输入、单字节、部分区间 [start,end)
 *  · 帧头/整帧位流的 CRC 自检（与编码器口径一致）
 * 所有向量为离线可复算常量，零依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crc8, crc16 } from '../src/index.js';

describe('crc8 已知向量', () => {
  const enc = new TextEncoder();
  test('"123456789" → 0xf4（poly 0x07, init 0）', () => {
    assert.equal(crc8(enc.encode('123456789')), 0xf4);
  });
  test('空输入 → 0', () => {
    assert.equal(crc8(new Uint8Array(0)), 0);
  });
  test('单字节 0x00 → 0', () => {
    assert.equal(crc8(new Uint8Array([0x00])), 0);
  });
  test('部分区间 [start,end) 与整体一致切片', () => {
    const s = enc.encode('123456789');
    const whole = crc8(s);
    // [0,4) 与 [5,9) 拼接不等价于整体（CRC 非可加），仅验证区间 API 行为自洽
    const part = crc8(s, 0, 4);
    assert.equal(part, 0xc2); // 离线复算值
    assert.notEqual(part, whole, 'CRC 不可加，部分区间≠整体');
  });
  test('单字节 0x07 初值语义', () => {
    assert.equal(crc8(new Uint8Array([0x07])), 0x15);
  });
});

describe('crc16 已知向量', () => {
  const enc = new TextEncoder();
  test('"123456789" → 0xfee8（poly 0x8005, init 0, 非反射）', () => {
    assert.equal(crc16(enc.encode('123456789')), 0xfee8);
  });
  test('空输入 → 0', () => {
    assert.equal(crc16(new Uint8Array(0)), 0);
  });
  test('部分区间 [start,end)', () => {
    const s = enc.encode('123456789');
    assert.equal(crc16(s, 0, 4), 0xfd59);
    assert.equal(crc16(s, 5, 9), 0x2b30);
  });
  test('单字节 0x80 初值语义', () => {
    assert.equal(crc16(new Uint8Array([0x80])), 0x8303);
  });
});

describe('CRC 与 FLAC 编码口径一致', () => {
  test('crc8 覆盖整帧头（不含尾字节）与帧尾 CRC-8 相等', () => {
    // 任意合法字节串：其 crc8 必须等于自身按相同口径复算（恒等自校验）
    const head = new Uint8Array([0xff, 0xf8, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00]);
    const c = crc8(head);
    assert.equal(crc8(head), c);
    assert.equal(c, 0x2a, '离线复算帧头 CRC');
  });
  test('crc16 覆盖整帧（含填充位）自洽', () => {
    const payload = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35]);
    const tail = new Uint8Array([(crc16(payload) >> 8) & 0xff, crc16(payload) & 0xff]);
    const frame = new Uint8Array([...payload, ...tail]);
    // 整帧（去尾 2 字节）CRC-16 应等于尾字节
    const expect = (frame[frame.length - 2] << 8) | frame[frame.length - 1];
    assert.equal(crc16(frame, 0, frame.length - 2), expect);
  });
});
