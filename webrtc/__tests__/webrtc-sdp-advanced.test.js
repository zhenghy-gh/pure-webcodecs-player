/**
 * webrtc 补充单测：sdp-utils.js 高级形态
 *  - parseSdp：空字符串仅返回结构骨架、多 m= section 的 mid 各自正确提取、
 *    全部 4 种方向（sendrecv/sendonly/recvonly/inactive）正确写入 direction、
 *    m= 行带多 payload type 时 formats 数组完整、c= 行重复时 connection 被覆盖、
 *    ice-options/rtcp-rsize 等媒体级未知属性落 rawAttrs
 *  - parseCandidateLine：TCP 协议小写化、raddr/rport 完整解析、字段不足仍返回 null
 *  - summarizeSdp：空 SDP 返回默认结构、bundle 仅当 group 包含 BUNDLE 关键字、
 *    hasIce/hasDtls 在部分媒体缺失时返回 false
 * 全部内联 fixture，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSdp,
  parseCandidateLine,
  summarizeSdp,
} from '../src/sdp-utils.js';

/* ---------------- parseSdp 高级形态 ---------------- */

test('parseSdp：空字符串返回结构骨架（version=0、media=[]）', () => {
  const { session, media } = parseSdp('');
  assert.equal(session.version, null);
  assert.equal(session.name, null);
  assert.equal(media.length, 0);
  // session.lines 也应是空
  assert.deepEqual(session.lines, []);
});

test('parseSdp：多 m= section 时各 section 的 mid 各自独立提取', () => {
  const sdp = `v=0\no=- 1 1 IN IP4 127.0.0.1\ns=-\nt=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:0
a=sendonly
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=mid:1
a=recvonly
m=application 9 DTLS/SCTP 5000
a=mid:2
a=inactive
`;
  const { media } = parseSdp(sdp);
  assert.equal(media.length, 3);
  assert.deepEqual(media.map((m) => m.mid), ['0', '1', '2']);
  assert.deepEqual(media.map((m) => m.direction), ['sendonly', 'recvonly', 'inactive']);
  assert.deepEqual(media.map((m) => m.type), ['video', 'audio', 'application']);
});

test('parseSdp：四种方向属性都被正确识别（sendrecv/sendonly/recvonly/inactive）', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=sendrecv\n`;
  assert.equal(parseSdp(sdp).media[0].direction, 'sendrecv');

  for (const dir of ['sendonly', 'recvonly', 'inactive']) {
    const r = parseSdp(`v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=${dir}\n`);
    assert.equal(r.media[0].direction, dir);
  }
});

test('parseSdp：m= 行带多 payload type 时 formats 数组完整', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99\n`;
  const { media } = parseSdp(sdp);
  assert.deepEqual(media[0].formats, ['96', '97', '98', '99']);
  assert.equal(media[0].port, 9);
  assert.equal(media[0].proto, 'UDP/TLS/RTP/SAVPF');
});

test('parseSdp：c= 行在媒体段内重复出现时 connection 被覆盖（最后胜出）', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 10.0.0.1
c=IN IP4 10.0.0.2
`;
  const { media } = parseSdp(sdp);
  assert.equal(media[0].connection, 'IN IP4 10.0.0.2', '后出现的连接信息覆盖');
});

test('parseSdp：媒体级未知属性（rtcp-rsize/ice-options）落 rawAttrs 不抛错', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=mid:0\na=rtcp-rsize\na=ice-options:trickle\na=foo-bar\n`;
  const { media } = parseSdp(sdp);
  const v = media[0];
  assert.ok(v.rawAttrs.includes('a=rtcp-rsize'));
  assert.ok(v.rawAttrs.includes('a=ice-options:trickle'));
  assert.ok(v.rawAttrs.includes('a=foo-bar'));
});

test('parseSdp：a=ssrc 无空格时 id 完整、attribute 为空串', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=ssrc:1234567\n`;
  const { media } = parseSdp(sdp);
  assert.equal(media[0].ssrcs.length, 1);
  assert.equal(media[0].ssrcs[0].id, '1234567');
  assert.equal(media[0].ssrcs[0].attribute, '');
});

test('parseSdp：fmtp 的 pt 与 codec 列表全部命中时全部 fmtp 写入', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96 97
a=rtpmap:96 H264/90000
a=rtpmap:97 H264/90000
a=fmtp:96 profile-level-id=42e01f
a=fmtp:97 profile-level-id=4d401e
`;
  const { media } = parseSdp(sdp);
  const fmtps = media[0].codecs.map((c) => c.fmtp).filter(Boolean);
  assert.deepEqual(fmtps, ['profile-level-id=42e01f', 'profile-level-id=4d401e']);
});

test('parseSdp：sessions 级 a=group 含 BUNDLE 列表（多 mid）', () => {
  const sdp = `v=0\ns=-\nt=0 0\na=group:BUNDLE 0 1 2\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=mid:0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=mid:1\nm=application 9 DTLS/SCTP 5000\na=mid:2\n`;
  const { session } = parseSdp(sdp);
  assert.equal(session.attributes.group, 'BUNDLE 0 1 2');
});

test('parseSdp：a=rtpmap 名称含连字符（如 H264）大小写归一', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=rtpmap:96 h264/90000\n`;
  const { media } = parseSdp(sdp);
  // 大写归一（解析器会 toUpperCase）
  assert.equal(media[0].codecs[0].name, 'H264');
});

/* ---------------- parseCandidateLine 边界 ---------------- */

test('parseCandidateLine：TCP 协议归一为 tcp', () => {
  const c = parseCandidateLine('candidate:1 1 TCP 2122252543 192.168.1.4 61665 typ host');
  assert.equal(c.protocol, 'tcp');
  assert.equal(c.foundation, '1');
});

test('parseCandidateLine：raddr/rport 同时存在时正确解析', () => {
  const c = parseCandidateLine('candidate:1 1 UDP 1694498815 203.0.113.5 54321 typ srflx raddr 192.168.1.4 rport 61665');
  assert.equal(c.relatedAddress, '192.168.1.4');
  assert.equal(c.relatedPort, 61665);
  assert.equal(c.address, '203.0.113.5');
  assert.equal(c.port, 54321);
  assert.equal(c.priority, 1694498815);
});

test('parseCandidateLine：字段不足 8 个时返回 null', () => {
  // foundation/component/protocol/priority/address/port/typ，但缺 type 值
  assert.equal(parseCandidateLine('1 1 UDP 2122252543 192.168.1.4 61665 typ'), null);
  assert.equal(parseCandidateLine('1 1 UDP'), null);
  assert.equal(parseCandidateLine('1 1'), null);
});

test('parseCandidateLine：候选 type 仅 host 时不解析 raddr', () => {
  const c = parseCandidateLine('1 1 UDP 2122252543 192.168.1.4 61665 typ host');
  assert.equal(c.type, 'host');
  assert.equal(c.relatedAddress, null);
  assert.equal(c.relatedPort, null);
});

test('parseCandidateLine：garbage 输入返回 null', () => {
  assert.equal(parseCandidateLine('not-a-candidate'), null);
  assert.equal(parseCandidateLine('   '), null);
});

/* ---------------- summarizeSdp 边界 ---------------- */

test('summarizeSdp：空 SDP 返回默认结构（bundle=false、mediaCount=0）', () => {
  const s = summarizeSdp('');
  assert.equal(s.bundle, false);
  assert.equal(s.mediaCount, 0);
  assert.deepEqual(s.mediaTypes, []);
  assert.deepEqual(s.directions, []);
  assert.equal(s.hasIce, true, 'media.every() 在空数组上返回 true（vacuously）');
  assert.equal(s.hasDtls, true);
  assert.equal(s.candidateCount, 0);
});

test('summarizeSdp：部分媒体缺失 ice-ufrag → hasIce=false', () => {
  const sdp = `v=0\ns=-\nt=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:0
a=ice-ufrag:AAAA
a=ice-pwd:BBBBBBBBBBBBBBBBBBBBBB
a=fingerprint:sha-256 AA:BB
a=rtpmap:96 H264/90000
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=mid:1
a=rtpmap:111 opus/48000/2
`;
  const s = summarizeSdp(sdp);
  assert.equal(s.hasIce, false, 'audio 缺 ice-ufrag/ice-pwd → hasIce=false');
  assert.equal(s.hasDtls, false, 'audio 缺 fingerprint → hasDtls=false');
  assert.equal(s.mediaCount, 2);
  assert.deepEqual(s.codecs, ['v:H264', 'a:OPUS']);
});

test('summarizeSdp：group 属性含 BUNDLE 才算 bundle=true（大小写敏感）', () => {
  // a=group:BUNDLE 必须在 m= 之前（会话级属性）
  const base = `v=0\ns=-\nt=0 0\na=group:BUNDLE 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\n`;
  assert.equal(summarizeSdp(base).bundle, true);
  assert.equal(summarizeSdp(base.replace('BUNDLE', 'bundle')).bundle, false, '小写不算 BUNDLE');
  assert.equal(summarizeSdp(base.replace('BUNDLE 0', 'LS 0 1')).bundle, false, '非 BUNDLE group 不算');
});

test('summarizeSdp：candidateCount 仅统计非 null 解析项', () => {
  const sdp = `v=0\ns=-\nt=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=candidate:1 1 UDP 1 192.168.1.4 1 typ host
a=candidate:2 1 UDP 1 192.168.1.5 2 typ host
a=candidate:garbage line that fails to parse
`;
  // 注：garbage 那行 a= 后 'candidate:garbage...' 仍被 addEventListener 入 _l；
  // parseCandidateLine 字段不足返回 null，被 filter(Boolean) 排除
  const s = summarizeSdp(sdp);
  assert.equal(s.candidateCount, 2, '合法 2 条 + 1 条 null');
});