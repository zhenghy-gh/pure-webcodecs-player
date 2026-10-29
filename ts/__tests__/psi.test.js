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

test('PAT/PMT：声明长度或循环边界损坏时拒绝解析', () => {
  assert.throws(
    () => parsePAT(new Uint8Array([0x00, 0xb0, 0x09])),
    (e) => e.code === 'PARSE_ERROR' && /section (truncated|length mismatch)/.test(e.message),
  );

  const pmt = buildPMT({ pcrPid: 0x0101, streams: [{ streamType: 0x1b, pid: 0x0101 }] });
  pmt[16] = 0x10; // ES_info_length 声明超出 section 末尾
  assert.throws(
    () => parsePMT(pmt),
    (e) => e.code === 'PARSE_ERROR' && /ES descriptors truncated/.test(e.message),
  );
});

test('PAT/PMT：声明 section_length 与实际字节数不一致时拒绝', () => {
  const shortPat = buildPAT([{ number: 1, pid: 0x1000 }]);
  shortPat[2] -= 1;
  assert.throws(
    () => parsePAT(shortPat),
    (error) => error.code === 'PARSE_ERROR' && /section length mismatch/.test(error.message),
  );

  const longPmt = buildPMT({ pcrPid: 0x0101, streams: [{ streamType: 0x1b, pid: 0x0101 }] });
  longPmt[2] += 1;
  assert.throws(
    () => parsePMT(longPmt),
    (error) => error.code === 'PARSE_ERROR' && /section length mismatch/.test(error.message),
  );
});

test('PAT/PMT：section_length 受 MPEG-2 1021 字节上限约束', () => {
  const maxPat = buildPAT(Array.from({ length: 253 }, (_, i) => ({ number: i + 1, pid: 0x100 + i })));
  assert.equal(((maxPat[1] & 0x0f) << 8) | maxPat[2], 1021);
  assert.equal(parsePAT(maxPat).programs.length, 253);

  const oversizedPat = buildPAT(Array.from({ length: 254 }, (_, i) => ({ number: i + 1, pid: 0x100 + i })));
  assert.equal(((oversizedPat[1] & 0x0f) << 8) | oversizedPat[2], 1025);
  assert.throws(
    () => parsePAT(oversizedPat),
    (error) => error.code === 'PARSE_ERROR' && /section_length 1025 exceeds maximum 1021/.test(error.message),
  );

  const oversizedPmt = buildPMT({
    pcrPid: 0x0100,
    streams: Array.from({ length: 202 }, (_, i) => ({ streamType: 0x1b, pid: 0x100 + i })),
  });
  assert.equal(((oversizedPmt[1] & 0x0f) << 8) | oversizedPmt[2], 1023);
  assert.throws(
    () => parsePMT(oversizedPmt),
    (error) => error.code === 'PARSE_ERROR' && /section_length 1023 exceeds maximum 1021/.test(error.message),
  );
});

test('PAT/PMT：拒绝不匹配的 table_id', () => {
  const pat = buildPAT([{ number: 1, pid: 0x1000 }]);
  pat[0] = 0x02;
  assert.throws(() => parsePAT(pat), (e) => e.code === 'PARSE_ERROR' && /PAT table_id mismatch/.test(e.message));

  const pmt = buildPMT({ pcrPid: 0x0101, streams: [{ streamType: 0x1b, pid: 0x0101 }] });
  pmt[0] = 0x00;
  assert.throws(() => parsePMT(pmt), (e) => e.code === 'PARSE_ERROR' && /PMT table_id mismatch/.test(e.message));
});

test('PAT/PMT：拒绝非法 section_syntax_indicator 与保留位', () => {
  const pat = buildPAT([{ number: 1, pid: 0x1000 }]);
  pat[1] &= 0x7f;
  assert.throws(() => parsePAT(pat), (e) => e.code === 'PARSE_ERROR' && /PAT section header flags/.test(e.message));

  const pmt = buildPMT({ pcrPid: 0x0101, streams: [{ streamType: 0x1b, pid: 0x0101 }] });
  pmt[1] &= 0xcf;
  assert.throws(() => parsePMT(pmt), (e) => e.code === 'PARSE_ERROR' && /PMT section header flags/.test(e.message));
});

test('PAT/PMT：拒绝 PID 与长度字段中清零的保留位', () => {
  const pat = buildPAT([{ number: 1, pid: 0x1000 }]);
  pat[10] &= 0x1f;
  assert.throws(
    () => parsePAT(pat),
    (error) => error.code === 'PARSE_ERROR' && /PAT program_map_PID reserved bits/.test(error.message),
  );

  const pmtFields = [
    { name: 'PCR_PID', offset: 8, mask: 0x1f },
    { name: 'program_info_length', offset: 10, mask: 0x0f },
    { name: 'elementary_PID', offset: 13, mask: 0x1f },
    { name: 'ES_info_length', offset: 15, mask: 0x0f },
  ];
  for (const field of pmtFields) {
    const pmt = buildPMT({ pcrPid: 0x0101, streams: [{ streamType: 0x1b, pid: 0x0101 }] });
    pmt[field.offset] &= field.mask;
    assert.throws(
      () => parsePMT(pmt),
      (error) => error.code === 'PARSE_ERROR' && error.message.includes(field.name) && /reserved bits/.test(error.message),
    );
  }
});

test('mpegCrc32 与已知向量一致', () => {
  // "123456789" 的 MPEG-2 CRC32 = 0x0376E6E7
  const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
  assert.equal(mpegCrc32(data), 0x0376e6e7);
});
