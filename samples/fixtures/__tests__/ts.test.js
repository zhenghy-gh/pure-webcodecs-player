/**
 * samples/fixtures/__tests__/ts.test.js —— makeTS 结构合法性验证。
 * 含 TS 包/PSI/PES 解析的最小参考实现（含 CRC32 复算），供 ts 模块作者对照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTS, decodePts, crc32Mpeg2 } from '../index.js';

/** 逐包解析 TS 流，校验同步字节与 AF 结构，返回摘要数组 */
function parsePackets(bytes) {
  assert.equal(bytes.length % 188, 0, '总长度必须是 188 的倍数');
  const packets = [];
  for (let off = 0; off < bytes.length; off += 188) {
    const p = bytes.subarray(off, off + 188);
    assert.equal(p[0], 0x47, `包偏移 ${off} 同步字节应为 0x47`);
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const pusi = (p[1] & 0x40) !== 0;
    const afControl = (p[3] >> 4) & 0x3;
    const cc = p[3] & 0x0f;
    let payloadStart = 4;
    let af = null;
    if (afControl === 2 || afControl === 3) {
      const afLen = p[4];
      const hasFlags = afLen > 0;
      af = {
        len: afLen,
        pcrFlag: hasFlags ? (p[5] & 0x10) !== 0 : false,
        pcrBase: null,
        stuffAllFF: true,
      };
      if (af.pcrFlag) {
        // 用乘法而非移位，避免大 PCR 基准值溢出 32 位有符号整数
        const base = p[6] * 2 ** 25 + p[7] * 2 ** 17 + p[8] * 2 ** 9 + p[9] * 2 ** 1 + (p[10] >> 7);
        af.pcrBase = base;
      }
      // AF 内容除标志/PCR 外必须全为 0xFF 填充
      const flagsLen = hasFlags ? 1 : 0;
      const pcrLen = af.pcrFlag ? 6 : 0;
      for (let i = 5 + flagsLen + pcrLen; i < 4 + 1 + afLen; i++) {
        if (p[i] !== 0xff) { af.stuffAllFF = false; break; }
      }
      payloadStart = 5 + afLen;
    } else {
      assert.equal(afControl, 1, 'af_control 只允许 01(无AF)/11(有AF)');
    }
    packets.push({ pid, pusi, cc, af, payload: p.subarray(payloadStart), packet: p });
  }
  return packets;
}

/** 提取 PSI section（跳过 pointer_field），并复算 CRC */
function readSection(packet) {
  assert.ok(packet.pusi, 'PSI section 必须在 PUSI 包中');
  assert.equal(packet.payload[0], 0, 'pointer_field 应为 0');
  const section = packet.payload.subarray(1);
  const tableId = section[0];
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
  const sectionBytes = section.subarray(0, 3 + sectionLength);
  const storedCrc =
    (sectionBytes[sectionBytes.length - 4] << 24)
    | (sectionBytes[sectionBytes.length - 3] << 16)
    | (sectionBytes[sectionBytes.length - 2] << 8)
    | sectionBytes[sectionBytes.length - 1];
  const computed = crc32Mpeg2(sectionBytes.subarray(0, sectionBytes.length - 4));
  return { tableId, sectionLength, sectionBytes, storedCrc: storedCrc >>> 0, computedCrc: computed };
}

test('默认输出：PAT/PMT CRC 正确且 program 表指向一致', () => {
  const { bytes, meta } = makeTS();
  const packets = parsePackets(bytes);

  const patPacket = packets.find((p) => p.pid === 0);
  assert.ok(patPacket, '应存在 PID=0 的 PAT');
  const pat = readSection(patPacket);
  assert.equal(pat.tableId, 0x00);
  assert.equal(pat.computedCrc, pat.storedCrc, 'PAT CRC32/MPEG-2 必须匹配');
  assert.equal(pat.sectionLength, 13, '单 program PAT 的 section 长度应为 13');

  const pmtPacket = packets.find((p) => p.pid === meta.pids.pmt);
  assert.ok(pmtPacket);
  const pmt = readSection(pmtPacket);
  assert.equal(pmt.tableId, 0x02);
  assert.equal(pmt.computedCrc, pmt.storedCrc, 'PMT CRC32/MPEG-2 必须匹配');

  // PAT 循环体：program_number=1 → (0xE000|PMT_PID)
  const loop = pat.sectionBytes.subarray(8, 12);
  const programNumber = (loop[0] << 8) | loop[1];
  const pmtPidField = ((loop[2] << 8) | loop[3]) & 0x1fff;
  assert.equal(programNumber, 1);
  assert.equal(pmtPidField, meta.pids.pmt);
});

test('连续计数器按 PID 独立递增（模 16）', () => {
  const { bytes } = makeTS({ auCount: 3 });
  const packets = parsePackets(bytes);
  const lastCc = new Map();
  for (const p of packets) {
    if (lastCc.has(p.pid)) {
      assert.equal(p.cc, (lastCc.get(p.pid) + 1) & 0x0f, `PID ${p.pid} 的 CC 必须步进`);
    }
    lastCc.set(p.pid, p.cc);
  }
});

test('每个视频 AU：首包带 PCR 且 PUSI，PTS 可从 PES 头解出', () => {
  const { bytes, meta } = makeTS();
  const packets = parsePackets(bytes).filter((p) => p.pid === meta.pids.video);
  assert.equal(packets.length, meta.ptsList.length, '小载荷 AU 应一包一个');

  let auIndex = -1;
  for (const p of packets) {
    assert.ok(p.pusi, '每 AU 单包时都应是 PUSI');
    auIndex++;
    assert.ok(p.af && p.af.pcrFlag, 'AU 首包应携带 PCR');
    assert.equal(p.af.pcrBase, meta.ptsList[auIndex], 'PCR 与 PTS 同步走时钟');
    assert.ok(p.af.stuffAllFF, '填充字节应为 0xFF');

    // PES：00 00 01 E0 ... PTS-only
    assert.deepEqual(Array.from(p.payload.subarray(0, 4)), [0, 0, 1, 0xe0]);
    assert.equal((p.payload[6] & 0xc0) >>> 6, 0b10, "PES 头以 '10' 开头");
    assert.equal(p.payload[7], 0x80, 'flags 应为 PTS-only');
    assert.equal(p.payload[8], 5, 'header_data_length=5');
    assert.equal(decodePts(p.payload.subarray(9)), meta.ptsList[auIndex]);
  }
});

test('auPadBytes 强制跨包：分段后仍满足 CC 连续与 PES 完整性', () => {
  const { bytes, meta } = makeTS({ auPadBytes: 400 });
  const packets = parsePackets(bytes);
  const videoPackets = packets.filter((p) => p.pid === meta.pids.video);
  assert.equal(videoPackets.length, meta.ptsList.length * 3, '400B 填充下每个 AU 应拆成约 3 包');
  assert.equal(videoPackets.filter((p) => p.pusi).length, meta.ptsList.length, '仅 AU 首包 PUSI');

  // 重组每个 AU 的 PES 载荷，验证 PES 长度字段与实际一致
  let buffer = [];
  const aus = [];
  for (const p of videoPackets) {
    if (p.pusi && buffer.length > 0) {
      aus.push(buffer);
      buffer = [];
    }
    buffer.push(...p.payload);
  }
  aus.push(buffer);
  assert.equal(aus.length, meta.ptsList.length);
  aus.forEach((pes, i) => {
    const pesLen = (pes[4] << 8) | pes[5];
    assert.equal(pesLen + 6, pes.length, 'PES length 字段必须覆盖其后全部字节');
    assert.deepEqual(pes.slice(0, 4), [0, 0, 1, 0xe0]);
    assert.equal(decodePts(Uint8Array.from(pes.slice(9, 14))), meta.ptsList[i], `AU#${i} 的 PTS 应可还原`);
  });
});

test('withAudio：PMT 增加 AAC 流且音频 PES 为 ADTS', () => {
  const { bytes, meta } = makeTS({ withAudio: true, auCount: 4 });
  assert.equal(meta.streamTypes[meta.pids.audio], 0x0f);

  const packets = parsePackets(bytes);
  const audioPackets = packets.filter((p) => p.pid === meta.pids.audio);
  assert.equal(audioPackets.length, 2, '4 个 AU 中第 0、2 个配音频');
  assert.ok(audioPackets[0].pusi);
  const pes = audioPackets[0].payload;
  assert.deepEqual(Array.from(pes.subarray(0, 4)), [0, 0, 1, 0xc0]);
  // PES 载荷开头是 ADTS syncword
  const dataStart = 9 + pes[8];
  assert.equal(pes[dataStart], 0xff);
  assert.equal(pes[dataStart + 1] & 0xf0, 0xf0);
});
