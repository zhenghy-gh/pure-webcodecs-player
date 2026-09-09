import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSdp, parseFmtpParams, pickVideoTrack } from '../src/sdp.js';
import { bytesToB64 } from '../src/b64.js';
import { makeParameterSets, spropParameterSets } from '../../samples/gateway/src/media/h264-pcm.js';

// H264 参数集直接复用网关的程序化编码器，保证真实可解码
const H264_SDP = [
  'v=0',
  'o=- 20260825 1 IN IP4 127.0.0.1',
  's=Test H264',
  't=0 0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 127.0.0.1',
  'a=control:trackID=0',
  'a=rtpmap:96 H264/90000',
  `a=fmtp:96 packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=${spropParameterSets()}`,
  '',
].join('\r\n');

/** 合成最小 H265 参数集：仅构造合法的 2 字节 NAL 头 + 若干载荷字节 */
function hevcNal(type, tidPlus1 = 1) {
  const body = new Uint8Array(6).fill(0xab);
  const nal = new Uint8Array(2 + body.length);
  nal[0] = (type << 1) | ((0 >> 5) & 1); // layerId=0
  nal[1] = (0 & 0x1f) << 3 | (tidPlus1 & 7); // layerId 低 5 位 + tid+1
  nal.set(body, 2);
  return nal;
}

const vpsNal = hevcNal(32);
const spsNal = hevcNal(33);
const ppsNal = hevcNal(34);

const H265_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=Test H265',
  't=0 0',
  'm=video 5006 RTP/AVP 96 97',
  'a=rtpmap:96 H265/90000',
  `a=fmtp:96 sprop-max-don-diff=2;sprop-sps=${bytesToB64(spsNal)};sprop-pps=${bytesToB64(ppsNal)}`,
  `a=sprop-vps=${bytesToB64(vpsNal)}`,
  '',
].join('\r\n');

test('H264 SDP：rtpmap/fmtp/sprop-parameter-sets 完整提取', () => {
  const sdp = parseSdp(H264_SDP);
  assert.equal(sdp.version, '0');
  const video = sdp.media[0];
  assert.equal(video.type, 'video');
  assert.deepEqual(video.payloads, [96]);
  assert.equal(video.rtpmap['96'].codec, 'H264');
  assert.equal(video.rtpmap['96'].clock, 90000);

  const h264 = video.h264;
  assert.ok(h264, '应解析出 h264 节');
  assert.equal(h264.packetizationMode, 1);
  assert.equal(h264.profileLevelId, '42c01e');
  // 与网关编码器输出一致：SPS 首字节 0x67，PPS 首字节 0x68
  const { sps, pps } = makeParameterSets();
  assert.deepEqual(Array.from(h264.sps[0]), Array.from(sps));
  assert.deepEqual(Array.from(h264.pps[0]), Array.from(pps));
});

test('fmtp 参数解析器', () => {
  const p = parseFmtpParams('packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=AAA,BBB');
  assert.equal(p['packetization-mode'], '1');
  assert.equal(p['profile-level-id'], '42c01e');
  assert.equal(p['sprop-parameter-sets'], 'AAA,BBB');
});

test('H265 SDP：会话级 vps 与媒体级 sps/pps、DONL 配置', () => {
  const sdp = parseSdp(H265_SDP);
  const video = sdp.media[0];
  assert.equal(video.rtpmap['96'].codec, 'H265');
  const h265 = video.h265;
  assert.ok(h265, '应解析出 h265 节');
  // NAL header 首字节 >> 1 即类型
  assert.equal(h265.vps[0][0] >> 1, 32, 'VPS 类型应为 32');
  assert.equal(h265.sps[0][0] >> 1, 33, 'SPS 类型应为 33');
  assert.equal(h265.pps[0][0] >> 1, 34, 'PPS 类型应为 34');
  assert.equal(h265.maxDonDiff, 2, 'DONL 应启用');
  const track = pickVideoTrack(sdp);
  assert.equal(track.codec, 'h265');
  assert.equal(track.maxDonDiff, 2);
});

test('pickVideoTrack：优先返回可用视频轨（h264）', () => {
  const track = pickVideoTrack(parseSdp(H264_SDP));
  assert.equal(track.codec, 'h264');
  assert.equal(track.pt, 96);
  assert.ok(track.parameterSets.sps.length >= 1);
  assert.ok(track.parameterSets.pps.length >= 1);
});

test('无视频轨时 pickVideoTrack 返回 null', () => {
  const track = pickVideoTrack(parseSdp('v=0\r\ns=x\r\n'));
  assert.equal(track, null);
});
