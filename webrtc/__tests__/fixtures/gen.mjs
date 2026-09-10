/**
 * fixtures/gen.mjs —— WebRTC SDP 样例程序化生成（契约 §0.6）
 *
 * 产出：WHEP offer/answer 对、含 srflx/relay 候选的 answer 变体、trickle sdpfrag。
 * 程序化拼装（非固定字符串），字段值由参数推导，便于扩展用例。
 */

function buildOffer({ sessionId = 'offer-session', videoPt = 96, audioPt = 111 } = {}) {
  return [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=PurePlay Offer',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=ice-options:trickle',
    `m=video 9 UDP/TLS/RTP/SAVPF ${videoPt}`,
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-mux',
    'a=ice-ufrag:FgHh',
    'a=ice-pwd:OfferPwdPlaceholder000000000',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    `a=rtpmap:${videoPt} H264/90000`,
    `a=fmtp:${videoPt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
    `m=audio 9 UDP/TLS/RTP/SAVPF ${audioPt}`,
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=recvonly',
    'a=rtcp-mux',
    'a=ice-ufrag:FgHh',
    'a=ice-pwd:OfferPwdPlaceholder000000000',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    `a=rtpmap:${audioPt} opus/48000/2`,
    '',
  ].join('\n');
}

function buildAnswer({ sessionId = 'answer-session', candidates = [] } = {}) {
  const candLines = candidates.map(
    (c, i) =>
      `a=candidate:${i + 1} 1 UDP ${c.priority} ${c.address} ${c.port} typ ${c.type}` +
      (c.related ? ` raddr ${c.related.addr} rport ${c.related.port}` : '')
  );
  return [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=PurePlay Answer',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    'a=rtcp-mux',
    'a=ice-ufrag:AnSw',
    'a=ice-pwd:AnswerPwdPlaceholder00000000',
    'a=fingerprint:sha-256 FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00',
    'a=setup:passive',
    'a=rtpmap:96 H264/90000',
    ...candLines,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendonly',
    'a=rtcp-mux',
    'a=ice-ufrag:AnSw',
    'a=ice-pwd:AnswerPwdPlaceholder00000000',
    'a=fingerprint:sha-256 FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00',
    'a=setup:passive',
    'a=rtpmap:111 opus/48000/2',
    ...candLines.map((l) => l), // 双 m 行共享候选（BUNDLE 场景简化）
    '',
  ].join('\n');
}

/** 契约签名：async generate(fixDir) */
export async function generate(fixDir) {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  await writeFile(join(fixDir, 'offer.sdp'), buildOffer(), 'utf8');
  await writeFile(join(fixDir, 'answer.sdp'), buildAnswer(), 'utf8');
  await writeFile(
    join(fixDir, 'answer-with-candidates.sdp'),
    buildAnswer({
      candidates: [
        { priority: 2122252543, address: '192.168.1.4', port: 61665, type: 'host' },
        { priority: 1694498815, address: '203.0.113.5', port: 54321, type: 'srflx', related: { addr: '192.168.1.4', port: 61665 } },
        { priority: 16777215, address: '198.51.100.7', port: 50000, type: 'relay', related: { addr: '0.0.0.0', port: 0 } },
      ],
    }),
    'utf8'
  );
  await writeFile(
    join(fixDir, 'trickle.sdpfrag'),
    [
      'a=ice-ufrag:TrIc',
      'a=ice-pwd:TrickleFragment0000000000',
      'a=candidate:9 1 UDP 2122252543 192.168.7.7 40000 typ host',
      '',
    ].join('\n'),
    'utf8'
  );
}
