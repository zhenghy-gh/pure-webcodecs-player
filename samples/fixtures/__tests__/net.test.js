/**
 * samples/fixtures/__tests__/net.test.js —— makeSDP / makeRTPH264Packet(s) 验证。
 * FU-A 重组逻辑即 rtsp/webrtc 模块需要实现的反向过程参考。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSDP, makeRTPH264Packet, makeRTPH264Packets, FAKE_SPS, FAKE_PPS } from '../index.js';

function b64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

test('SDP：行结构、rtpmap 与 sprop-parameter-sets 与 codecs 同源', () => {
  const { text, meta } = makeSDP();
  const lines = text.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'v=0');
  const mLine = lines.find((l) => l.startsWith('m=video'));
  assert.ok(/^m=video 5004 RTP\/AVP 96$/.test(mLine));
  assert.ok(lines.includes('a=rtpmap:96 H264/90000'));
  const fmtp = lines.find((l) => l.startsWith('a=fmtp'));
  assert.ok(fmtp.includes('packetization-mode=1'));
  assert.ok(
    fmtp.includes(`sprop-parameter-sets=${b64(FAKE_SPS)},${b64(FAKE_PPS)}`),
    'sprop-parameter-sets 必须与 FAKE_SPS/PPS 的 base64 一致',
  );
});

test('RTP 固定头：版本/PT/序号/时间戳/SSRC 回读一致', () => {
  const nal = new Uint8Array(20).fill(7);
  nal[0] = 0x41;
  const pkt = makeRTPH264Packet({ payload: nal, seq: 65535, timestamp: 3000, marker: true });
  assert.equal(pkt[0], 0x80, 'V=2 且无填充/扩展');
  assert.equal(pkt[1], (1 << 7) | 96);
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  assert.equal(dv.getUint16(2), 65535);
  assert.equal(dv.getUint32(4), 3000);
  assert.equal(dv.getUint32(8), 0x12345678);
  // 载荷原样跟随
  assert.deepEqual(Array.from(pkt.subarray(12)), Array.from(nal));
});

test('小 NAL 走 Single-NAL 模式（一包 + marker）', () => {
  const nal = new Uint8Array(30);
  nal[0] = 0x67;
  const { packets, meta } = makeRTPH264Packets({ nal, mtu: 64 });
  assert.equal(meta.mode, 'single-nal');
  assert.equal(packets.length, 1);
  assert.equal(packets[0][1] & 0x80, 0x80, '单包即帧末，marker 应置位');
  assert.deepEqual(Array.from(meta.reassembled), Array.from(nal));
});

test('大 NAL 自动 FU-A：仅首片 S、仅末片 E+marker，重组还原原始字节', () => {
  const nal = new Uint8Array(101);
  nal[0] = 0x65; // IDR
  for (let i = 1; i < nal.length; i++) nal[i] = i & 0xff;

  const { packets, meta } = makeRTPH264Packets({ nal, mtu: 64, seq: 100, timestamp: 9000 });
  assert.equal(meta.mode, 'fu-a');
  assert.ok(packets.length >= 2);

  packets.forEach((p, i) => {
    assert.equal(p.length <= 12 + 64, true, '每包载荷不超过 mtu');
    const fuHeader = p[13];
    const isS = (fuHeader & 0x80) !== 0;
    const isE = (fuHeader & 0x40) !== 0;
    if (i === 0) { assert.ok(isS, '首片 S=1'); assert.ok(!isE); }
    else if (i === packets.length - 1) { assert.ok(isE, '末片 E=1'); assert.ok(!isS); }
    else { assert.ok(!isS && !isE, '中间片无 S/E'); }

    const markerSet = (p[1] & 0x80) !== 0;
    assert.equal(markerSet, i === packets.length - 1, 'marker 只在末片');

    // FU indicator：保留 F/NRI（来自原 NAL 头）+ type=28
    assert.equal(p[12] & 0x1f, 28);
    assert.equal(p[12] & 0xe0, nal[0] & 0xe0);
    // FU header 的真实 type 应等于原 NAL type
    assert.equal(fuHeader & 0x1f, 5);

    if (i > 0) {
      const dvPrev = new DataView(packets[i - 1].buffer, packets[i - 1].byteOffset, packets[i - 1].byteLength);
      const dvCur = new DataView(p.buffer, p.byteOffset, p.byteLength);
      assert.equal(dvCur.getUint16(2), (dvPrev.getUint16(2) + 1) & 0xffff, '序号连续递增');
      assert.equal(dvCur.getUint32(4), dvPrev.getUint32(4), '同一 AU 时间戳不变');
    }
  });

  assert.deepEqual(Array.from(meta.reassembled), Array.from(nal), 'FU-A 重组应精确还原 NAL');
});
