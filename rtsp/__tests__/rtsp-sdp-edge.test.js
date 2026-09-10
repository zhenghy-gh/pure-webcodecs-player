/**
 * parseSdp / pickVideoTrack / 辅助解析器 的边界与畸形输入测试（sdp.test.js 已覆盖正向路径）。
 * 重点：空/缺 m= 行、多 track 选择、rtpmap 缺失 fallback、control 空值、会话级 H265 sprop、
 * b64ListToNals 与 parseFmtpParams 的容错分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSdp, parseFmtpParams, b64ListToNals, pickVideoTrack } from '../src/sdp.js';

test('空/缺 m= 行：仅会话级，media 为空，pickVideoTrack 返回 null', () => {
  const sdp = parseSdp('v=0\r\ns=Session Only\r\nt=0 0');
  assert.equal(sdp.version, '0');
  assert.equal(sdp.sessionName, 'Session Only');
  assert.deepEqual(sdp.media, []);
  assert.equal(pickVideoTrack(sdp), null);
});

test('null / 空字符串输入不抛错，返回默认结构', () => {
  const a = parseSdp(null);
  const b = parseSdp('');
  assert.deepEqual(a.media, []);
  assert.deepEqual(b.media, []);
  assert.equal(a.version, null);
});

test('多 track：audio 在前、video 在后，pickVideoTrack 选首个视频轨', () => {
  const SDP = [
    'v=0', 's=Multi', 't=0 0',
    'm=audio 0 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1;sprop-parameter-sets=AAAA',
    '',
  ].join('\r\n');
  const sdp = parseSdp(SDP);
  assert.equal(sdp.media.length, 2);
  assert.equal(sdp.media[0].type, 'audio');
  assert.equal(sdp.media[1].type, 'video');
  const track = pickVideoTrack(sdp);
  assert.ok(track, '应能选出视频轨');
  assert.equal(track.codec, 'h264');
  assert.equal(track.pt, 96);
});

test('rtpmap 缺失：有 m=video 但无 rtpmap → h264/h265 为 null，pickVideoTrack 返回 null', () => {
  const SDP = [
    'v=0', 's=NoRtpmap', 't=0 0',
    'm=video 0 RTP/AVP 96',
    'a=control:trackID=0',
    '',
  ].join('\r\n');
  const sdp = parseSdp(SDP);
  const m = sdp.media[0];
  assert.equal(m.type, 'video');
  assert.deepEqual(m.rtpmap, {});
  assert.equal(m.h264, null);
  assert.equal(m.h265, null);
  assert.equal(pickVideoTrack(sdp), null);
});

test('a=control: 空值应回退为 "*"', () => {
  const SDP = [
    'v=0', 's=Ctl', 't=0 0',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H264/90000',
    'a=control:',
    '',
  ].join('\r\n');
  const m = parseSdp(SDP).media[0];
  assert.equal(m.control, '*');
});

test('会话级 H265 sprop：媒体级无 fmtp sprop 时回退到会话级参数集', () => {
  const SDP = [
    'v=0', 's=H265-sess', 't=0 0',
    'a=sprop-vps=AAAA',
    'a=sprop-sps=AAAA',
    'a=sprop-pps=AAAA',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H265/90000',
    '',
  ].join('\r\n');
  const m = parseSdp(SDP).media[0];
  assert.ok(m.h265, '应解析出 h265 节');
  assert.equal(m.h265.vps.length, 1, 'VPS 应来自会话级');
  assert.equal(m.h265.sps.length, 1, 'SPS 应来自会话级');
  assert.equal(m.h265.pps.length, 1, 'PPS 应来自会话级');
});

test('H265 媒体级 fmtp sprop 优先于会话级', () => {
  const SDP = [
    'v=0', 's=H265-mix', 't=0 0',
    'a=sprop-sps=AAAA', // 会话级占位
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H265/90000',
    'a=fmtp:96 sprop-sps=QUFB',
    '',
  ].join('\r\n');
  const m = parseSdp(SDP).media[0];
  // QUFB = "AAA"，与会话级 AAAA([0,0,0]) 不同，应优先媒体级
  assert.equal(m.h265.sps[0][0], 0x41, 'SPS 应使用媒体级 sprop（base64 QUFB = "AAA"）');
});

test('b64ListToNals：空串、含空段、尾部逗号均容错', () => {
  assert.deepEqual(b64ListToNals(''), []);                 // 空串 → 空
  assert.deepEqual(Array.from(b64ListToNals('AAAA')[0]), [0, 0, 0]); // 单段解码为 3 字节
  assert.equal(b64ListToNals('AAAA,,BBBB').length, 2);     // 空段被滤除
  assert.equal(b64ListToNals('AAAA,').length, 1);          // 尾部逗号
});

test('b64ListToNals：URL 安全字符被规整为 Base64', () => {
  // URL-safe '-''_' 转换为 '+' '/'
  const out = b64ListToNals('Zg');
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 0x66); // 'f'
});

test("parseFmtpParams：仅含 flag（无 '='）的条目映射为空串", () => {
  const p = parseFmtpParams('packetization-mode=1;foo;bar=2');
  assert.equal(p['packetization-mode'], '1');
  assert.equal(p.foo, ''); // 无 '=' → 空串
  assert.equal(p.bar, '2');
});

test('parseFmtpParams：空输入返回空对象', () => {
  assert.deepEqual(parseFmtpParams(undefined), {});
  assert.deepEqual(parseFmtpParams(''), {});
});
