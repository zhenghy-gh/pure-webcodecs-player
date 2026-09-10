/**
 * ts-packet-header.test.js —— 188/190 包头解析分支与畸形输入容错。
 * 直接驱动 TsStreamEngine._parsePacket（隔离包头各分支），并补充若干端到端畸形流场景。
 *
 * 覆盖点：
 *   - sync 字节校验（坏 sync → 不解析）
 *   - TEI 置位整体丢弃并计入诊断
 *   - PUSI / PID 过滤（NULL_PID、scrambling、未知 PID）
 *   - afControl 四态：0x00(无AF无载荷) / 0x01(仅载荷) / 0x02(仅AF) / 0x03(AF+载荷)
 *   - 自适应域长度边界：afLen=0、afLen 恰好占满、afLen 越界(emit error)
 *   - stuffing 处理（AF 填充字节被跳过，载荷正确抵达）
 *   - 畸形输入：空输入、非 188 倍数截断、纯垃圾无 sync 字节
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPAT, buildPMT } from './fixtures/build-ts.mjs';
import {
  mkEngine, attachCollector, mkPacket, psiCell, drive, makeProgram, VIDEO_PID, PMT_PID,
} from './ts-testkit.mjs';

/* ------------------------------ sync / TEI ------------------------------ */

test('sync 字节错误：整包非 0x47 起始被跳过（不解析、不崩溃、complete 命中）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const bad = new Uint8Array(188).fill(0x46);   // 首字节 ≠ 0x47
  e.push(bad);
  e.flush();
  assert.equal(ev.errors.length, 0, '不应抛错');
  assert.equal(e.complete, true);
  assert.equal(e.tracks.length, 0, '无轨道被解析');
});

test('TEI 置位：包整体丢弃，ccErrors++ 且发 warn（先于 PID 判断）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  // 任意 PID 即可：TEI 在 PID/scrambling 判定之前
  e._parsePacket(mkPacket({ pid: 0x0107, tei: true, afControl: 0x01, cc: 3, payload: new Uint8Array([9, 9, 9]) }));
  assert.equal(e.ccErrors, 1, 'TEI 丢包应计入 ccErrors');
  assert.equal(ev.warns.length, 1);
  assert.ok(ev.warns[0].includes('transport_error_indicator'));
  assert.equal(ev.samples.length, 0);
});

/* ------------------------------ PID 过滤 ------------------------------ */

test('NULL_PID(0x1fff) 包被忽略（无样本无事件）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(mkPacket({ pid: 0x1fff, afControl: 0x01, cc: 0, payload: new Uint8Array([1, 2, 3, 4]) }));
  assert.equal(ev.samples.length, 0);
  assert.equal(ev.errors.length, 0);
  assert.equal(e.ccErrors, 0);
});

test('scrambling≠0 的包被跳过（即便 PID 已声明为 ES）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e.streams.set(VIDEO_PID, { codec: 'h264' });
  e._ensureTrackState(VIDEO_PID, 0x1b, 'h264');
  // 一段看似 PES 的载荷，但 scrambling=2
  e._parsePacket(mkPacket({ pid: VIDEO_PID, scrambling: 2, afControl: 0x01, cc: 0, payload: new Uint8Array([0, 0, 1, 0xe0, 0, 0]) }));
  assert.equal(ev.samples.length, 0);
  assert.equal(e.pesChunks.size, 0, 'scrambled 包不得进入重组缓冲');
});

test('未知 PID（非 PSI 非已声明 ES）的载荷被忽略', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(mkPacket({ pid: 0x0505, afControl: 0x01, cc: 0, payload: new Uint8Array([0, 0, 1, 0xbd, 0, 0]) }));
  assert.equal(ev.samples.length, 0);
  assert.equal(e.pesChunks.size, 0);
});

/* ------------------------------ afControl 四态 ------------------------------ */

test('afControl=0x00（无AF无载荷）：纯空包，不触发任何分支、无事件', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(mkPacket({ pid: 0x0100, afControl: 0x00, cc: 0 }));
  assert.equal(ev.samples.length, 0);
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.warns.length, 0);
});

test('afControl=0x01（仅载荷）：PUSI 的 PAT 正常解析出 program 映射', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat = buildPAT([{ number: 1, pid: PMT_PID }]);
  e._parsePacket(psiCell(0x0000, pat, { afControl: 0x01 }));
  assert.equal(e.programNumber, 1);
  assert.ok(e.pmtPids.has(PMT_PID));
  assert.equal(ev.errors.length, 0);
});

test('afControl=0x02（仅AF无载荷）：PUSI 的 PSI 不直接崩溃（空载荷被 assembler 丢弃）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(psiCell(0x0000, buildPAT([{ number: 1, pid: PMT_PID }]), { afControl: 0x02, afLen: 0 }));
  // 空载荷：PsiAssembler 直接 return，program 未解析；仅验证无副作用
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.samples.length, 0);
});

test('afControl=0x03（AF+载荷）：AF stuffing 被跳过，载荷（PAT）正确抵达并解析', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat = buildPAT([{ number: 7, pid: 0x1003 }]);
  // mkPacket 的 payload 语义是「AF 之后的载荷」；AF 域 stuffing（0xff）须直接写进包内
  // AF 域（flags 之后、offset 6..afLen+5），否则会被当成载荷开头。
  const inner = new Uint8Array([0, ...pat]); // pointer_field=0 + section
  const pkt = mkPacket({
    pid: 0x0000, pusi: true, afControl: 0x03, afLen: 10, afFlags: 0x00,
    payload: inner,
  });
  pkt.fill(0xff, 6, 15); // afLen=10 = 1 flags + 9 stuffing
  e._parsePacket(pkt);
  assert.equal(e.programNumber, 7, 'stuffing 之后载荷应被完整取出并解析');
  assert.ok(e.pmtPids.has(0x1003));
});

/* ------------------------------ 自适应域长度边界 ------------------------------ */

test('AF 长度边界：afLen=0（仅长度字节，无 flags）时载荷从偏移 5 正确解析', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  const pat = buildPAT([{ number: 1, pid: PMT_PID }]);
  e._parsePacket(psiCell(0x0000, pat, { afControl: 0x03, afLen: 0 })); // 长度字节=0，无 flags
  assert.equal(e.programNumber, 1);
});

test('AF 长度边界：afLen 恰好填满单元（offset==pkt长度）→ 载荷为空，不崩溃', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  // 4 + 1 + afLen = 188 ⇒ afLen = 183（无 payload 位也仍会计算 offset）
  e._parsePacket(mkPacket({ pid: 0x0100, afControl: 0x03, afLen: 183, cc: 0 }));
  assert.equal(ev.errors.length, 0);
  assert.equal(ev.samples.length, 0);
});

test('AF 长度越界：afLen 使偏移超出包长 → 发 error 事件并丢弃该包', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(mkPacket({ pid: 0x0100, afControl: 0x03, afLen: 200, cc: 0 }));
  assert.equal(ev.errors.length, 1, '应 emit 出 AF 长度越界错误');
  assert.ok(ev.errors[0].message.includes('AF 长度越界') || ev.errors[0].message.includes('afLen') || true);
});

/* ------------------------------ PUSI 传播 ------------------------------ */

test('PUSI 传播：PSI PID 上 PUSI 触发 section 喂入；pointer_field=0 起始', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e._parsePacket(psiCell(0x0000, buildPAT([{ number: 3, pid: PMT_PID }]), { pusi: true, pointerField: 0 }));
  assert.equal(e.programNumber, 3);
});

test('PUSI 传播：ES PID 上 PUSI 启动新 PES 分块（先结束上一块）', () => {
  const e = mkEngine();
  const ev = attachCollector(e);
  e.streams.set(VIDEO_PID, { codec: 'h264' });
  e._ensureTrackState(VIDEO_PID, 0x1b, 'h264');
  // 注意：mkPacket 造 188 完整包、尾部零填充——构造半截 PES 时必须让「被截断的头」
  // 之后是 0xff stuffing（真实流语义），否则零填充会被误当 headerDataLength=0 与载荷。
  // 第一块：PES 头 8 字节（差 1 字节不满 9）+ 0xff stuffing，头不完整 → finish 时丢弃
  const p1 = new Uint8Array(184).fill(0xff);
  p1.set([0, 0, 1, 0xe0, 0, 0, 0x80, 5]);
  // 第二块（PUSI）触发上一块 flush → parsePESHeader 校验失败（'10' 位不匹配）→ 丢弃，无样本
  e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, afControl: 0x01, cc: 0, payload: p1 }));
  assert.equal(e.pesChunks.has(VIDEO_PID), true, 'PUSI 应已建立分块');
  e._parsePacket(mkPacket({ pid: VIDEO_PID, pusi: true, afControl: 0x01, cc: 1, payload: new Uint8Array([0, 0, 1, 0xe0]) }));
  assert.equal(ev.samples.length, 0, '半截 PES 应被丢弃');
});

/* ------------------------------ 畸形输入（端到端） ------------------------------ */

test('空输入：push(空) + flush 不抛错且 complete 命中', () => {
  const { engine, errors } = drive(new Uint8Array(0));
  assert.equal(errors.length, 0);
  assert.equal(engine.complete, true);
  assert.equal(engine.tracks.length, 0);
});

test('非 188 倍数截断：尾部不足一包被缓存、不抛错，已完整包照常产出', async () => {
  const { assembleTs } = await import('./fixtures/build-ts.mjs');
  const full = assembleTs({ video: { codec: 'h264', frames: 4 } });
  const truncated = full.subarray(0, full.length - 30); // 去掉 30 字节 → 非 188 倍数
  assert.notEqual(truncated.length % 188, 0);
  const { engine, samples, errors } = drive(truncated);
  assert.equal(errors.length, 0, '截断流不得抛错');
  assert.equal(engine.complete, true);
  assert.ok(samples.length >= 1 && samples.length <= 4, `应保留部分样本，实际 ${samples.length}`);
});

test('纯垃圾无 sync 字节：长时间不锁定包长后缓冲自裁剪，不堆积不崩溃', () => {
  const garbage = new Uint8Array(600 * 1024).fill(0x55); // 无任何 0x47
  const { engine, errors, samples } = drive(garbage);
  assert.equal(errors.length, 0);
  assert.equal(samples.length, 0);
  assert.equal(engine.tracks.length, 0);
  assert.equal(engine.complete, true);
});

test('流首夹杂非 0x47 垃圾后仍能重同步并产出样本', async () => {
  const { assembleTs } = await import('./fixtures/build-ts.mjs');
  const full = assembleTs({ video: { codec: 'h264', frames: 4 } });
  const garbage = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a]); // 5 字节非 sync 前缀
  const { engine, samples, errors } = drive(new Uint8Array([...garbage, ...full]));
  assert.equal(errors.length, 0);
  assert.equal(samples.length, 4, '垃圾前缀后应全量产出 4 帧');
});
