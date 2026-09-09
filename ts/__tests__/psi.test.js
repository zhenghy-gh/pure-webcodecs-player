/**
 * PSI（PAT/PMT）解析单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPAT, buildPMT, sectionToPackets } from './fixtures/build-ts.mjs';
import { parsePAT, parsePMT, mpegCrc32, PsiAssembler } from '../src/psi.js';

test('PAT：解析节目映射与 CRC', () => {
  const section = buildPAT([
    { number: 1, pid: 0x1000 },
    { number: 2, pid: 0x1001 },
  ]);
  const pat = parsePAT(section);
  assert.equal(pat.crcOk, true, 'CRC 校验应通过');
  assert.deepEqual(pat.programs, [
    { number: 1, pid: 0x1000 },
    { number: 2, pid: 0x1001 },
  ]);
});

test('PAT：CRC 篡改后校验失败仍可解析', () => {
  const section = buildPAT([{ number: 7, pid: 0x07ff }]);
  section[section.length - 1] ^= 0xff;   // 破坏 CRC
  const pat = parsePAT(section);
  assert.equal(pat.crcOk, false);
  assert.equal(pat.programs[0].pid, 0x07ff);
});

test('PMT：多流解析与 stream_type 映射', () => {
  const section = buildPMT({
    pcrPid: 0x0101,
    streams: [
      { streamType: 0x1b, pid: 0x0101 }, // H264
      { streamType: 0x24, pid: 0x0102 }, // HEVC
      { streamType: 0x0f, pid: 0x0103 }, // AAC ADTS
      { streamType: 0x11, pid: 0x0104 }, // AAC LATM
      { streamType: 0x06, pid: 0x0105 }, // 私有数据（无映射）
    ],
  });
  const pmt = parsePMT(section);
  assert.equal(pmt.crcOk, true);
  assert.equal(pmt.pcrPid, 0x0101);
  assert.deepEqual(pmt.streams.map((s) => s.codec), ['h264', 'hevc', 'aac-adts', 'aac-latm', undefined]);
});

test('PsiAssembler：跨包 Section 重组（60 个流的超长 PMT）', () => {
  const manyStreams = Array.from({ length: 60 }, (_, i) => ({ streamType: 0x1b, pid: 0x200 + i }));
  const section = buildPMT({ pcrPid: 0x100, streams: manyStreams });
  assert.ok(section.length > 184, 'section 应超过单个包容量');

  const received = [];
  const asm = new PsiAssembler((pid, sec) => received.push({ pid, sec }));
  const packets = sectionToPackets(0x1000, section);
  for (const pkt of packets) {
    // 模拟 demuxer 去头：剥离自适应域后喂给重组器
    const afControl = (pkt[3] >> 4) & 0x03;
    let offset = 4;
    if (afControl & 0x02) offset += 1 + pkt[4];
    asm.feed(0x1000, pkt.subarray(offset), (pkt[1] & 0x40) !== 0);
  }
  assert.equal(received.length, 1, '重组后应恰好收到一个完整 section');
  const pmt = parsePMT(received[0].sec);
  assert.equal(pmt.streams.length, 60);
  assert.equal(pmt.streams[59].pid, 0x23b);
});

test('mpegCrc32 与已知向量一致', () => {
  // "123456789" 的 MPEG-2 CRC32 = 0x0376E6E7
  const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
  assert.equal(mpegCrc32(data), 0x0376e6e7);
});
