/**
 * rtsp/src/nal.js 专项测试（分层覆盖率门禁补测）
 *
 * 背景：该文件在覆盖率门禁中仅 42.9%（parser 层门槛 80%），且无任何测试直接引用——
 * 42.9% 全部来自间接调用。本文件覆盖 6 个导出函数的正常路径与边界/容错分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAnnexb,
  fromAnnexb,
  avccToNals,
  nalsToAvcc,
  h264IsKeyframe,
  h265IsKeyframe,
} from '../src/nal.js';

const bytes = (...v) => Uint8Array.from(v);

test('toAnnexb：空数组得空串；多 NAL 以 4 字节起始码拼接', () => {
  assert.equal(toAnnexb([]).length, 0);

  const out = toAnnexb([bytes(0x65, 0xaa), bytes(0x41, 0xbb, 0xcc)]);
  // 4+2 + 4+3 = 13
  assert.equal(out.length, 13);
  assert.deepEqual([...out.slice(0, 6)], [0, 0, 0, 1, 0x65, 0xaa]);
  assert.deepEqual([...out.slice(6, 13)], [0, 0, 0, 1, 0x41, 0xbb, 0xcc]);
});

test('fromAnnexb：4 字节起始码切分，丢弃起始码本身', () => {
  const nal = bytes(0x65, 0x11, 0x22);
  const stream = toAnnexb([nal]);
  const got = fromAnnexb(stream);
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0]], [0x65, 0x11, 0x22]);
});

test('fromAnnexb：3 字节起始码同样识别，并与 4 字节混排', () => {
  // [00 00 01] A [00 00 00 01] B
  const stream = bytes(0, 0, 1, 0x41, 0xaa, 0, 0, 0, 1, 0x65, 0xbb);
  const got = fromAnnexb(stream);
  assert.equal(got.length, 2);
  assert.deepEqual([...got[0]], [0x41, 0xaa]);
  assert.deepEqual([...got[1]], [0x65, 0xbb]);
});

test('fromAnnexb：无起始码 / 空输入 → 空数组', () => {
  assert.equal(fromAnnexb(bytes(1, 2, 3, 4, 5)).length, 0);
  assert.equal(fromAnnexb(new Uint8Array(0)).length, 0);
});

test('avccToNals：按长度前缀切分，支持自定义 lengthSize', () => {
  const two = bytes(0, 2, 0x65, 0xaa, 0, 1, 0x41);
  const got4 = avccToNals(two, 2);
  assert.equal(got4.length, 2);
  assert.deepEqual([...got4[0]], [0x65, 0xaa]);
  assert.deepEqual([...got4[1]], [0x41]);

  const four = bytes(0, 0, 0, 1, 0x65);
  const got = avccToNals(four); // 默认 lengthSize=4
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0]], [0x65]);
});

test('avccToNals：len=0 与越界长度均容错中断，不抛异常', () => {
  assert.equal(avccToNals(bytes(0, 0, 0, 0)).length, 0, 'len=0 应 break');
  assert.equal(avccToNals(bytes(0, 0, 0, 9, 1, 2)).length, 0, '声明长度越界应 break');
  assert.equal(avccToNals(bytes(0, 0)).length, 0, '不足 lengthSize 直接结束');
});

test('nalsToAvcc：写入 4 字节大端长度，与 avccToNals 往返一致', () => {
  const nals = [bytes(0x65, 0xaa, 0xbb), bytes(0x41)];
  const avcc = nalsToAvcc(nals);
  assert.equal(avcc.length, (4 + 3) + (4 + 1));
  assert.deepEqual([...avcc.slice(0, 4)], [0, 0, 0, 3], '首个长度前缀应为 3');
  const back = avccToNals(avcc);
  assert.equal(back.length, 2);
  assert.deepEqual([...back[0]], [0x65, 0xaa, 0xbb]);
  assert.deepEqual([...back[1]], [0x41]);
});

test('nalsToAvcc：空数组得空串', () => {
  assert.equal(nalsToAvcc([]).length, 0);
});

test('h264IsKeyframe：NAL 类型 5（IDR）为真，其余为假', () => {
  assert.equal(h264IsKeyframe([bytes(0x65)]), true, '0x65 → type 5');
  assert.equal(h264IsKeyframe([bytes(0x41), bytes(0x65)]), true, 'AU 内任一 IDR 即关键帧');
  assert.equal(h264IsKeyframe([bytes(0x41)]), false, '0x41 → type 1 非 IDR');
  assert.equal(h264IsKeyframe([]), false);
});

test('h265IsKeyframe：IDR_W_RADL(19)/IDR_N_LP(20)/CRA(21) 为真', () => {
  const mk = (t) => bytes((t << 1) & 0xff);
  assert.equal(h265IsKeyframe([mk(19)]), true);
  assert.equal(h265IsKeyframe([mk(20)]), true);
  assert.equal(h265IsKeyframe([mk(21)]), true);
  assert.equal(h265IsKeyframe([mk(1)]), false, '非关键帧类型');
  assert.equal(h265IsKeyframe([]), false);
});

test('AnnexB ↔ AVCC 端到端：AnnexB 流可转为 AVCC 再还原', () => {
  const nals = [bytes(0x65, 1, 2, 3), bytes(0x41, 4, 5)];
  const annexb = toAnnexb(nals);
  const parsed = fromAnnexb(annexb);
  assert.equal(parsed.length, 2);
  const avcc = nalsToAvcc(parsed);
  const roundTrip = avccToNals(avcc);
  assert.equal(roundTrip.length, 2);
  assert.deepEqual([...roundTrip[0]], [...nals[0]]);
  assert.deepEqual([...roundTrip[1]], [...nals[1]]);
});
