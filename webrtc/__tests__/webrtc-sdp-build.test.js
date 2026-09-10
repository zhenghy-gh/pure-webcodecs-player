/**
 * webrtc 补充单测：sdp-utils 构造/边界覆盖
 *  - parseSdp：会话级空媒体、extmap/ssrc、c= 连接行、flag 属性、fmtp 失配、
 *    多 candidate、application/inactive、未知属性落 rawAttrs、mid 提取
 *  - parseCandidateLine："candidate:" 前缀、字段不足、无 raddr 的 host
 *  - summarizeSdp：无 BUNDLE 组、多候选计数
 * 全部内联 fixture，零网络依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSdp,
  parseCandidateLine,
  summarizeSdp,
} from '../src/sdp-utils.js';

/* ---------------- parseSdp 构造/边界 ---------------- */

test('parseSdp：仅会话级无媒体行（media 为空、session 字段落到）', () => {
  const { session, media } = parseSdp('v=0\no=- 1 2 IN IP4 127.0.0.1\ns=-\nt=0 0\n');
  assert.equal(media.length, 0);
  assert.equal(session.version, 0);
  assert.equal(session.origin, '- 1 2 IN IP4 127.0.0.1');
  assert.equal(session.timing, '0 0');
  assert.deepEqual(session.attributes, {});
});

test('parseSdp：会话级 flag 属性（无冒号）落到 attributes 为 true', () => {
  const { session } = parseSdp('v=0\ns=-\nt=0 0\na=ice-options:trickle\na=foo-bar\n');
  assert.equal(session.attributes['ice-options'], 'trickle');
  assert.equal(session.attributes['foo-bar'], true);
});

test('parseSdp：extmap 与 ssrc 解析、c= 连接行落 media.connection', () => {
  const sdp = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 239.0.0.1
a=mid:1
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=ssrc:1234567 cname:user@host
a=ssrc:1234567 msid:stream audio0
`;
  const { media } = parseSdp(sdp);
  const [audio] = media;
  assert.equal(audio.type, 'audio');
  assert.equal(audio.connection, 'IN IP4 239.0.0.1');
  assert.equal(audio.mid, '1');
  assert.deepEqual(audio.extmaps, ['1 urn:ietf:params:rtp-hdrext:ssrc-audio-level']);
  assert.equal(audio.ssrcs.length, 2);
  assert.equal(audio.ssrcs[0].id, '1234567');
  assert.equal(audio.ssrcs[0].attribute, 'cname:user@host');
  assert.equal(audio.ssrcs[1].attribute, 'msid:stream audio0');
});

test('parseSdp：unknown 媒体级 a= 行落入 rawAttrs 但被忽略语义', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=mid:0\na=rtcp-rsize\na=unknown-flag\n`;
  const { media } = parseSdp(sdp);
  const [video] = media;
  assert.ok(video.rawAttrs.includes('a=rtcp-rsize'));
  assert.ok(video.rawAttrs.includes('a=unknown-flag'));
  assert.equal(video.direction, null); // 非方向属性
});

test('parseSdp：fmtp 的 pt 与已解析 codec 不匹配时不抛错、保持原值', () => {
  const sdp = `v=0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96
a=rtpmap:96 H264/90000
a=fmtp:97 level-asymmetry-allowed=1
`;
  const { media } = parseSdp(sdp);
  const [video] = media;
  assert.equal(video.codecs.length, 1);
  assert.equal(video.codecs[0].fmtp, undefined, 'pt=97 无对应 codec，fmtp 不应写入');
});

test('parseSdp：单媒体行多个 candidate + application 类型 + inactive 方向', () => {
  const sdp = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=application 9 DTLS/SCTP 5000
a=mid:2
a=inactive
a=candidate:1 1 UDP 2122252543 192.168.1.4 61665 typ host
a=candidate:2 1 UDP 1685988607 203.0.113.5 54321 typ srflx raddr 192.168.1.4 rport 61665
`;
  const { media } = parseSdp(sdp);
  const [app] = media;
  assert.equal(app.type, 'application');
  assert.equal(app.direction, 'inactive');
  assert.equal(app.mid, '2');
  assert.equal(app.candidates.length, 2);
  assert.equal(app.candidates[0].type, 'host');
  assert.equal(app.candidates[1].type, 'srflx');
  assert.equal(app.candidates[1].relatedAddress, '192.168.1.4');
  assert.equal(app.candidates[1].relatedPort, 61665);
});

test('summarizeSdp：无 BUNDLE 组 → bundle=false；多候选计数', () => {
  const sdp = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:0
a=sendonly
a=rtcp-mux
a=ice-ufrag:AAAA
a=ice-pwd:BBBBBBBBBBBBBBBBBBBBBB
a=fingerprint:sha-256 11:FF:ED:80:27:64:B3:8D:5E:F2:56:41:8A:12:FD:D7
a=rtpmap:96 H264/90000
a=candidate:1 1 UDP 1 192.168.1.4 1 typ host
a=candidate:2 1 UDP 1 192.168.1.5 2 typ host
`;
  const s = summarizeSdp(sdp);
  assert.equal(s.bundle, false);
  assert.equal(s.candidateCount, 2);
  assert.deepEqual(s.codecs, ['v:H264']);
  assert.equal(s.hasIce, true);
  assert.equal(s.hasDtls, true);
});

/* ---------------- parseCandidateLine 边界 ---------------- */

test('parseCandidateLine：含 "candidate:" 前缀被剥离、字段不足返回 null', () => {
  const c = parseCandidateLine('candidate:1 1 UDP 2122252543 192.168.1.4 61665 typ host');
  assert.equal(c.foundation, '1');
  assert.equal(c.protocol, 'udp');
  // 不足 8 个字段（仅 foundation/component/protocol/priority/address/port/typ，缺 type）
  assert.equal(parseCandidateLine('1 1 UDP 1 192.168.1.4 61665 typ'), null);
  // 空串
  assert.equal(parseCandidateLine(''), null);
});

test('parseCandidateLine：无 raddr 的 host 候选 related 为 null', () => {
  const c = parseCandidateLine('1 1 UDP 2122252543 192.168.1.4 61665 typ host');
  assert.equal(c.type, 'host');
  assert.equal(c.relatedAddress, null);
  assert.equal(c.relatedPort, null);
});
